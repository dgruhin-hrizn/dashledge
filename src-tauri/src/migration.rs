//! Import the installed collectors' local connection settings. Only public connection
//! fields cross the webview bridge. Put credentials under the host's normal Keychain IDs.
use crate::connections::{endpoint, import_ca, import_secret, validate_ca};
use reqwest::Url;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Serialize)]
struct Source {
    kind: &'static str,
    name: String,
    address: String,
    #[serde(rename = "gpuGuests", skip_serializing_if = "Value::is_null")]
    gpu_guests: Value,
}
struct Candidate {
    source: Source,
    secret: Option<String>,
    ca: Option<Vec<u8>>,
}
#[derive(Default, Serialize)]
pub struct Report {
    sources: Vec<Source>,
    issues: Vec<String>,
    ember: bool,
}

fn file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Ok(m) if m.is_file() && m.len() <= 4 * 1024 * 1024 => fs::read(path)
            .map(Some)
            .map_err(|_| "cannot read saved settings".into()),
        _ => Err("cannot open saved settings".into()),
    }
}
fn read_json(path: &Path) -> Result<Option<Value>, String> {
    file(path)?
        .map(|b| serde_json::from_slice(&b).map_err(|_| "invalid settings JSON".into()))
        .transpose()
}
fn string<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v[key].as_str().map(str::trim).filter(|s| !s.is_empty())
}
fn candidate(
    kind: &'static str,
    name: &str,
    url: &str,
    secret: Option<&str>,
) -> Result<Candidate, String> {
    let base = endpoint(url)?;
    Ok(Candidate {
        source: Source {
            kind,
            name: name.to_string(),
            address: base.to_string(),
            gpu_guests: Value::Null,
        },
        secret: secret.map(str::to_owned),
        ca: None,
    })
}
fn goliath(home: &Path, kind: &'static str) -> Result<Vec<Candidate>, String> {
    let script = home.join(format!(
        "Library/Application Support/Goliath Zurface {kind}/capture.mjs"
    ));
    let Some(bytes) = file(&script)? else {
        return Ok(vec![]);
    };
    let script = std::str::from_utf8(&bytes).map_err(|_| "cannot read collector endpoint")?;
    let host = script
        .lines()
        .find_map(|line| {
            let value = line
                .trim()
                .strip_prefix("const host")?
                .trim_start()
                .strip_prefix('=')?
                .trim()
                .trim_end_matches(';')
                .trim();
            value
                .strip_prefix('\'')
                .and_then(|s| s.strip_suffix('\''))
                .or_else(|| value.strip_prefix('"')?.strip_suffix('"'))
        })
        .ok_or("cannot determine the installed server address")?;
    let is_emby = kind == "emby";
    let suffix = if is_emby { "/emby/" } else { "/api/v1/" };
    let url_line = script
        .lines()
        .find(|line| line.contains("+host+") && line.contains(suffix))
        .ok_or("cannot determine the service port")?;
    let port = url_line
        .split(suffix)
        .next()
        .and_then(|s| s.rsplit(':').next())
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|p| *p > 0)
        .ok_or("invalid service port")?;
    let mut url = Url::parse("http://localhost").unwrap();
    url.set_host(Some(host))
        .map_err(|_| "invalid service host")?;
    url.set_port(Some(port))
        .map_err(|_| "invalid service port")?;
    url.set_path(suffix);
    let key = if is_emby { "embyKey" } else { "unraidToken" };
    let current = read_json(&home.join(format!(".config/{kind}-zurface-widget/credentials.json")))?;
    let secret = match current.as_ref().and_then(|v| string(v, key)) {
        Some(s) => Some(s.to_owned()),
        None => read_json(&home.join(".config/goliath-zurface/credentials.json"))?
            .and_then(|v| string(&v, key).map(str::to_owned)),
    };
    Ok(vec![candidate(
        kind,
        if is_emby { "Emby" } else { "Goliath" },
        url.as_str(),
        secret.as_deref(),
    )?])
}
fn proxmox(home: &Path) -> Result<Vec<Candidate>, String> {
    let Some(v) = read_json(&home.join(".config/proxmox-zurface/config.json"))? else {
        return Ok(vec![]);
    };
    let host = string(&v, "host").ok_or("missing Proxmox host")?;
    let mut url = Url::parse("https://localhost").unwrap();
    let ipv6 = if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    url.set_host(Some(&ipv6))
        .map_err(|_| "invalid Proxmox host")?;
    let port = v["port"].as_u64().unwrap_or(8006);
    if !(1..=65535).contains(&port) {
        return Err("invalid port".into());
    }
    url.set_port(Some(port as u16))
        .map_err(|_| "invalid port")?;
    let token = format!(
        "{}={}",
        string(&v, "tokenId").ok_or("missing token ID")?,
        string(&v, "secret").ok_or("missing token secret")?
    );
    let mut entry = candidate("proxmox", "Proxmox", url.as_str(), Some(&token))?;
    if let Some(path) = string(&v, "caFile") {
        let data = file(Path::new(path))?.ok_or("configured CA file is missing")?;
        validate_ca(&data)?;
        entry.ca = Some(data);
    }
    if let Some(map) = v["gpuGuests"].as_object() {
        let mut refs = serde_json::Map::new();
        for (vm, guest) in map {
            if vm.parse::<u32>().is_err() {
                continue;
            }
            if let Some(target) = guest.as_str().or_else(|| string(guest, "target")) {
                let mut settings = json!({"target":target});
                if let Some(path) = string(guest, "identityFile") {
                    settings["identityFile"] = json!(path);
                }
                refs.insert(vm.clone(), settings);
            }
        }
        entry.source.gpu_guests = Value::Object(refs);
    }
    Ok(vec![entry])
}
fn comfy(home: &Path, issues: &mut Vec<String>) -> Result<Vec<Candidate>, String> {
    let Some(hosts) =
        read_json(&home.join("Library/Application Support/ComfyUI Zurface/hosts.json"))?
    else {
        return Ok(vec![]);
    };
    let mut entries = Vec::new();
    for (i, host) in hosts
        .as_array()
        .ok_or("invalid workers list")?
        .iter()
        .enumerate()
    {
        match candidate(
            "comfy",
            string(host, "name").unwrap_or("ComfyUI"),
            string(host, "url").unwrap_or(""),
            None,
        ) {
            Ok(c) => entries.push(c),
            Err(_) => issues.push(format!("ComfyUI worker {} has an invalid address", i + 1)),
        }
    }
    Ok(entries)
}
fn omlx(home: &Path, issues: &mut Vec<String>) -> Result<Vec<Candidate>, String> {
    let dir = home.join(".omlx");
    let servers = read_json(&dir.join("zurface-servers.json"))?;
    if servers.is_none()
        && !home
            .join("Library/Application Support/Zeon/oMLX Dashboard/collect.mjs")
            .is_file()
    {
        return Ok(vec![]);
    }
    let rows =
        servers.unwrap_or_else(|| json!({"servers":[{"localSettings":true,"name":"This Mac"}]}));
    let mut entries = Vec::new();
    for (i, row) in rows["servers"]
        .as_array()
        .ok_or("invalid server list")?
        .iter()
        .enumerate()
    {
        let load = || -> Result<Candidate, String> {
            let local = row["localSettings"] == true;
            let settings = if local {
                read_json(&dir.join("settings.json"))?.unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            let port = settings
                .pointer("/server/port")
                .and_then(Value::as_u64)
                .unwrap_or(8000);
            let mut address = match string(row, "address") {
                Some(s) => s.to_owned(),
                None if local => format!("http://127.0.0.1:{port}"),
                None => return Err("missing server address".into()),
            };
            if !address.contains("://") {
                let bare = address.trim_end_matches('/');
                let default_port = bare.parse::<std::net::IpAddr>().is_ok()
                    || !bare.contains(':')
                    || bare.ends_with(']');
                address = format!("http://{bare}{}", if default_port { ":8000" } else { "" });
            }
            let base = endpoint(&address)?;
            if base.path() != "/" {
                return Err("expected a server origin".into());
            }
            if local && !matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) {
                return Err("local credentials require a loopback address".into());
            }
            let secret = if let Some(path) = string(row, "keyFile") {
                let bytes = file(&dir.join(path))?.ok_or("configured key file is missing")?;
                Some(
                    String::from_utf8(bytes)
                        .map_err(|_| "invalid key file")?
                        .trim()
                        .to_owned(),
                )
            } else {
                settings
                    .pointer("/auth/api_key")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            candidate(
                "omlx",
                string(row, "name").unwrap_or(base.host_str().unwrap_or("oMLX")),
                base.as_str(),
                secret.as_deref(),
            )
        };
        match load() {
            Ok(c) => entries.push(c),
            Err(e) => issues.push(format!("oMLX server {}: {e}", i + 1)),
        }
    }
    Ok(entries)
}
fn discover(home: &Path) -> (Vec<Candidate>, Report) {
    let mut entries = Vec::new();
    let mut report = Report::default();
    report.ember = home
        .join("Library/Application Support/Ember/User/globalStorage/ember.ember-agent/ember.db")
        .is_file();
    for (label, result) in [
        ("Emby", goliath(home, "emby")),
        ("Unraid", goliath(home, "unraid")),
        ("Proxmox", proxmox(home)),
        ("ComfyUI", comfy(home, &mut report.issues)),
        ("oMLX", omlx(home, &mut report.issues)),
    ] {
        match result {
            Ok(mut v) => entries.append(&mut v),
            Err(e) => report.issues.push(format!("{label}: {e}")),
        }
    }
    (entries, report)
}
fn migrate(home: &Path) -> Report {
    let (entries, mut report) = discover(home);
    for entry in entries {
        let store = || -> Result<(), String> {
            if let Some(bytes) = entry.ca {
                import_ca(&entry.source.address, &bytes)?
            }
            if let Some(secret) = entry.secret.filter(|s| !s.is_empty()) {
                import_secret(entry.source.kind, &entry.source.address, secret.as_bytes())?
            }
            Ok(())
        };
        match store() {
            Ok(()) => report.sources.push(entry.source),
            Err(e) => report.issues.push(format!("{}: {e}", entry.source.name)),
        }
    }
    report
}
#[tauri::command]
pub async fn import_zurface_connections() -> Result<Report, String> {
    let home: PathBuf = dirs::home_dir().ok_or("Home folder unavailable")?;
    tauri::async_runtime::spawn_blocking(move || migrate(&home))
        .await
        .map_err(|_| "Import interrupted".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_installed_server_and_serializes_only_connection_metadata() {
        let dir =
            std::env::temp_dir().join(format!("edge-workbench-import-test-{}", std::process::id()));
        let script = dir.join("Library/Application Support/Goliath Zurface emby/capture.mjs");
        let creds = dir.join(".config/emby-zurface-widget/credentials.json");
        for f in [&script, &creds] {
            fs::create_dir_all(f.parent().unwrap()).unwrap();
        }
        fs::write(
            script,
            "const host = 'example.test';\nconst target='http://'+host+':8096/emby/';",
        )
        .unwrap();
        fs::write(creds, r#"{"embyKey":"fixture-private"}"#).unwrap();
        let (mut entries, report) = discover(&dir);
        assert!(report.issues.is_empty());
        let c = entries.pop().unwrap();
        assert_eq!(c.secret.as_deref(), Some("fixture-private"));
        assert_eq!(c.source.address, "http://example.test:8096/emby/");
        assert!(!serde_json::to_string(&c.source)
            .unwrap()
            .contains("fixture-private"));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    #[ignore = "inspects current Mac collector files without writing credentials"]
    fn inventory_on_this_mac() {
        let (items, report) = discover(&dirs::home_dir().unwrap());
        for c in items {
            println!(
                "{}: credential={}, custom_ca={}, guest_refs={}",
                c.source.kind,
                c.secret.as_ref().is_some_and(|s| !s.is_empty()),
                c.ca.is_some(),
                c.source.gpu_guests.as_object().map_or(0, |m| m.len())
            );
        }
        println!(
            "Ember local database: {}, read issues: {:?}",
            report.ember, report.issues
        );
    }
}
