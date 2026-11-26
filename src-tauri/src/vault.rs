//! One Keychain-protected encryption key for all Workbench connections.
//! Concurrent processes lock the same file before initialization and vault updates.
use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM},
    rand::{SecureRandom, SystemRandom},
};
use security_framework::{
    os::macos::keychain::SecKeychain,
    passwords::{get_generic_password, set_generic_password},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Mutex,
};

const SERVICE: &str = "Edge Workbench Connections";
const ACCOUNT: &str = "Local vault";
const HEADER: &[u8] = b"EWCV1";
const LOCKED: &str =
    "Keychain access was declined or is unavailable. Use Unlock connections in Settings to retry.";
const LEGACY_SECRET: &str = "dev.edgeworkbench.connections";
const LEGACY_CA: &str = "dev.edgeworkbench.proxmox-ca";

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Credential {
    pub key: Option<String>,
    pub ca: Option<String>,
}
type Entries = BTreeMap<String, Credential>;
enum Session {
    New,
    Open(LessSafeKey),
    Denied,
}
impl Session {
    fn unlock(
        &mut self,
        load: impl FnOnce() -> Result<LessSafeKey, String>,
    ) -> Result<&LessSafeKey, String> {
        if matches!(self, Self::New) {
            match load() {
                Ok(key) => *self = Self::Open(key),
                Err(error) => {
                    if error == LOCKED {
                        *self = Self::Denied
                    }
                    return Err(error);
                }
            }
        }
        match self {
            Self::Open(key) => Ok(key),
            _ => Err(LOCKED.into()),
        }
    }
}
static SESSION: Mutex<Session> = Mutex::new(Session::New);

fn directory() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join("Library/Application Support/dev.edgeworkbench.desktop"))
        .ok_or("Home folder unavailable".into())
}
fn session_key(existing: bool) -> Result<LessSafeKey, String> {
    let bytes = match get_generic_password(SERVICE, ACCOUNT) {
        Ok(data) => data,
        Err(e) if e.code() == -25300 && !existing => {
            let mut data = vec![0; 32];
            SystemRandom::new()
                .fill(&mut data)
                .map_err(|_| "Cannot generate a vault key")?;
            set_generic_password(SERVICE, ACCOUNT, &data).map_err(|_| LOCKED)?;
            data
        }
        Err(e) if e.code() == -25300 => {
            return Err("The Keychain key for the existing Workbench vault is missing.".into())
        }
        Err(_) => return Err(LOCKED.into()),
    };
    UnboundKey::new(&AES_256_GCM, &bytes)
        .map(LessSafeKey::new)
        .map_err(|_| "Invalid Workbench vault key".into())
}
fn decode(key: &LessSafeKey, raw: &[u8]) -> Result<Entries, String> {
    let payload = raw
        .strip_prefix(HEADER)
        .ok_or("Unrecognized connection vault")?;
    let (nonce, ciphertext) = payload
        .split_at_checked(12)
        .ok_or("Incomplete connection vault")?;
    let mut buffer = ciphertext.to_vec();
    let data = key
        .open_in_place(
            Nonce::try_assume_unique_for_key(nonce).map_err(|_| "Invalid vault nonce")?,
            Aad::from(HEADER),
            &mut buffer,
        )
        .map_err(|_| "Cannot authenticate the connection vault")?;
    serde_json::from_slice(data).map_err(|_| "Invalid connection vault".into())
}
fn save(path: &Path, key: &LessSafeKey, entries: &Entries) -> Result<(), String> {
    let mut nonce = [0; 12];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "Cannot generate a vault nonce")?;
    let mut data = serde_json::to_vec(entries).map_err(|_| "Cannot encode credentials")?;
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(HEADER),
        &mut data,
    )
    .map_err(|_| "Cannot protect credentials")?;
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing vault directory")?)
        .map_err(|e| e.to_string())?;
    file.write_all(HEADER)
        .and_then(|_| file.write_all(&nonce))
        .and_then(|_| file.write_all(&data))
        .and_then(|_| file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn transaction<T>(operation: impl FnOnce(&mut Entries) -> Result<T, String>) -> Result<T, String> {
    let mut session = SESSION.lock().unwrap();
    if matches!(*session, Session::Denied) {
        return Err(LOCKED.into());
    }
    let dir = directory()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(dir.join("connections.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    let path = dir.join("connections.vault");
    let raw = match fs::read(&path) {
        Ok(raw) => Some(raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let key = session.unlock(|| session_key(raw.is_some()))?;
    let mut entries = match raw {
        Some(raw) => decode(key, &raw)?,
        None => Entries::new(),
    };
    let before = entries.clone();
    let result = operation(&mut entries)?;
    if entries != before {
        save(&path, key, &entries)?;
    }
    Ok(result)
}

fn id(kind: &str, base: &reqwest::Url) -> String {
    let address = if kind == "json" {
        base.as_str()
    } else {
        base.as_str().trim_end_matches('/')
    };
    format!("{kind}|{address}")
}
// The old app stored each token and CA under its own ACL. Use accessible old
// values first, then the matching installed collector. Never prompt in this path.
fn legacy(
    kind: &str,
    base: &reqwest::Url,
    fallback: Credential,
    interactive: bool,
) -> Result<Credential, String> {
    let _quiet = if interactive {
        None
    } else {
        Some(
            SecKeychain::disable_user_interaction()
                .map_err(|_| "Cannot check previous credentials silently")?,
        )
    };
    let read = |service: &str, account: &str| -> Result<Option<String>, String> {
        match get_generic_password(service,account){
            Ok(bytes)=>String::from_utf8(bytes).map(Some).map_err(|_|"Invalid saved credential".into()),
            Err(e) if e.code()==-25300=>Ok(None),
            Err(_)=>Err("The previous credential needs approval. Choose Recover previous credential in Connections.".into()),
        }
    };
    let mut key = None;
    for account in crate::connections::account_ids(kind, base) {
        match read(LEGACY_SECRET, &account) {
            Ok(Some(value)) => {
                key = Some(value);
                break;
            }
            Ok(None) => {}
            Err(_) if fallback.key.is_some() => break,
            Err(error) => return Err(error),
        }
    }
    let key = key.or(fallback.key);
    let ca = if kind == "proxmox" {
        match read(LEGACY_CA, base.as_str()) {
            Ok(value) => value.or(fallback.ca),
            Err(_) if fallback.ca.is_some() => fallback.ca,
            Err(error) => return Err(error),
        }
    } else {
        None
    };
    Ok(Credential { key, ca })
}

pub fn get(kind: &str, base: &reqwest::Url) -> Result<Credential, String> {
    transaction(|entries| {
        let account = id(kind, base);
        if let Some(value) = entries.get(&account) {
            return Ok(value.clone());
        }
        let fallback = crate::migration::installed_credential(kind, base).unwrap_or_default();
        let credential = legacy(kind, base, fallback, false)?;
        entries.insert(account, credential.clone());
        Ok(credential)
    })
}
pub fn import(kind: &str, base: &reqwest::Url, source: Credential) -> Result<(), String> {
    transaction(|entries| {
        let account = id(kind, base);
        match entries.entry(account) {
            std::collections::btree_map::Entry::Occupied(mut item) => {
                let value = item.get_mut();
                if value.key.is_none() {
                    value.key = source.key
                }
                if value.ca.is_none() {
                    value.ca = source.ca
                }
            }
            std::collections::btree_map::Entry::Vacant(item) => {
                item.insert(legacy(kind, base, source, false)?);
            }
        }
        Ok(())
    })
}
pub fn set(kind: &str, base: &reqwest::Url, secret: String) -> Result<(), String> {
    if !secret.is_empty() && kind == "proxmox" {
        // Retain the CA when replacing a Proxmox token, including on upgrade.
        get(kind, base)?;
    }
    transaction(|entries| {
        let value = entries.entry(id(kind, base)).or_default();
        if secret.is_empty() {
            *value = Credential::default()
        } else {
            value.key = Some(secret)
        }
        Ok(())
    })
}
#[tauri::command]
pub async fn unlock_connections() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        {
            let mut session = SESSION.lock().unwrap();
            if matches!(*session, Session::Denied) {
                *session = Session::New;
            }
        }
        transaction(|_| Ok(()))
    })
    .await
    .map_err(|_| "Unlock interrupted".to_string())?
}
#[tauri::command]
pub async fn recover_credential(
    window: tauri::WebviewWindow,
    kind: String,
    address: String,
) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("Open Settings to recover a credential".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let base = crate::connections::endpoint(&address)?;
        transaction(|entries| {
            let value = legacy(&kind, &base, Credential::default(), true)?;
            if value == Credential::default() {
                return Err("No previous credential found for this connection".into());
            }
            let item = entries.entry(id(&kind, &base)).or_default();
            if value.key.is_some() {
                item.key = value.key
            }
            if value.ca.is_some() {
                item.ca = value.ca
            }
            Ok(())
        })?;
        crate::widget_host::invalidate(&kind, &base);
        Ok(())
    })
    .await
    .map_err(|_| "Recovery interrupted".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn widgets_share_one_unlock_and_denial_suppresses_background_prompts() {
        let mut session = Session::New;
        session
            .unlock(|| {
                Ok(LessSafeKey::new(
                    UnboundKey::new(&AES_256_GCM, &[9; 32]).unwrap(),
                ))
            })
            .unwrap();
        for _ in 0..10 {
            assert!(session.unlock(|| panic!("duplicate Keychain read")).is_ok());
        }
        let mut session = Session::New;
        assert!(session.unlock(|| Err(LOCKED.into())).is_err());
        assert!(session.unlock(|| panic!("unexpected retry")).is_err());
    }
    #[test]
    fn vault_roundtrip_keeps_certificates_and_detects_tampering() {
        let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &[17; 32]).unwrap());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault");
        let mut entries = Entries::default();
        entries.insert(
            "proxmox|https://example".into(),
            Credential {
                key: Some("fixture-private".into()),
                ca: Some("fixture-ca".into()),
            },
        );
        save(&path, &key, &entries).unwrap();
        let mut bytes = fs::read(path).unwrap();
        assert!(!bytes.windows(15).any(|w| w == b"fixture-private"));
        assert!(decode(&key, &bytes).unwrap() == entries);
        *bytes.last_mut().unwrap() ^= 1;
        assert!(decode(&key, &bytes).is_err());
    }
}
