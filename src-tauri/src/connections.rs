use reqwest::{Client, Url};
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use serde_json::{json, Value};
use std::{sync::OnceLock, time::Duration};

const SERVICE: &str = "dev.edgeworkbench.connections";
pub(crate) fn endpoint(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Enter a full server URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err("Use an HTTP(S) URL without embedded credentials or a query".into());
    }
    Ok(url)
}
fn account_ids(kind: &str, base: &Url) -> Vec<String> {
    let exact = format!("{kind}|{base}");
    if base.path() == "/" || !matches!(kind, "emby" | "unraid" | "comfy" | "omlx" | "proxmox") {
        return vec![exact];
    }
    let alternate = if base.as_str().ends_with('/') {
        base.as_str().trim_end_matches('/').to_owned()
    } else {
        format!("{base}/")
    };
    vec![exact, format!("{kind}|{alternate}")]
}
fn secret_for(kind: &str, base: &Url) -> Result<Option<Vec<u8>>, String> {
    for account in account_ids(kind, base) {
        match get_generic_password(SERVICE, &account) {
            Ok(value) => return Ok(Some(value)),
            Err(e) if e.code() == -25300 => continue,
            Err(_) => return Err("Keychain access unavailable".into()),
        }
    }
    Ok(None)
}
#[tauri::command]
pub fn set_secret(
    window: tauri::WebviewWindow,
    kind: String,
    address: String,
    secret: String,
) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("Open Settings to change credentials".into());
    }
    let base = endpoint(&address)?;
    let id = format!("{kind}|{base}");
    if secret.is_empty() {
        for account in account_ids(&kind, &base) {
            if let Err(e) = delete_generic_password(SERVICE, &account) {
                if e.code() != -25300 {
                    return Err("Keychain could not clear the credential".into());
                }
            }
        }
        if kind == "proxmox" {
            if let Err(e) = delete_generic_password(CA_SERVICE, base.as_str()) {
                if e.code() != -25300 {
                    return Err("Keychain could not clear the certificate".into());
                }
            }
        }
        return Ok(());
    }
    set_generic_password(SERVICE, &id, secret.as_bytes())
        .map_err(|_| "Keychain could not save the credential".into())
}
fn http() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("HTTP client")
    })
}
const CA_SERVICE: &str = "dev.edgeworkbench.proxmox-ca";

fn import_if_missing(service: &str, account: &str, bytes: &[u8]) -> Result<(), String> {
    match get_generic_password(service, account) {
        Ok(_) => Ok(()),
        Err(e) if e.code() == -25300 => set_generic_password(service, account, bytes)
            .map_err(|_| "Keychain could not save the imported connection".into()),
        Err(_) => Err("Keychain access unavailable".into()),
    }
}
pub(crate) fn import_secret(kind: &str, address: &str, bytes: &[u8]) -> Result<(), String> {
    let base = endpoint(address)?;
    if secret_for(kind, &base)?.is_some() {
        return Ok(());
    }
    import_if_missing(SERVICE, &format!("{kind}|{base}"), bytes)
}
pub(crate) fn import_ca(address: &str, bytes: &[u8]) -> Result<(), String> {
    import_if_missing(CA_SERVICE, endpoint(address)?.as_str(), bytes)
}
pub(crate) fn validate_ca(bytes: &[u8]) -> Result<Vec<reqwest::Certificate>, String> {
    let certs = reqwest::Certificate::from_pem_bundle(bytes)
        .map_err(|_| "Invalid Proxmox CA certificate")?;
    if certs.is_empty() {
        return Err("Missing Proxmox CA certificate".into());
    }
    Ok(certs)
}
fn service_client(kind: &str, base: &Url) -> Result<Client, String> {
    if kind != "proxmox" {
        return Ok(http().clone());
    }
    match get_generic_password(CA_SERVICE, base.as_str()) {
        Ok(bytes) => {
            let mut builder = Client::builder()
                .timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none());
            for cert in validate_ca(&bytes)? {
                builder = builder.add_root_certificate(cert);
            }
            builder
                .build()
                .map_err(|_| "Could not load Proxmox CA certificate".into())
        }
        Err(e) if e.code() == -25300 => Ok(http().clone()),
        Err(_) => Err("Cannot read Proxmox certificate from Keychain".into()),
    }
}

async fn get(kind: &str, base: &Url, path: &str, key: &str) -> Result<Value, String> {
    let client = service_client(kind, base)?;
    let mut url = base.clone();
    if !path.is_empty() {
        let (route, query) = path
            .split_once('?')
            .map_or((path, None), |(p, q)| (p, Some(q)));
        url.set_path(&format!("{}/{}", base.path().trim_end_matches('/'), route));
        url.set_query(query);
    }
    let mut request = client.get(url);
    if !key.is_empty() {
        request = match kind {
            "emby" => request.header("X-Emby-Token", key),
            "proxmox" => request.header("Authorization", format!("PVEAPIToken={key}")),
            _ => request.bearer_auth(key),
        };
    }
    let mut res = request
        .send()
        .await
        .map_err(|_| "Server unreachable. Check the URL, network and certificate.".to_string())?;
    if !res.status().is_success() {
        return Err(format!("Server returned HTTP {}", res.status().as_u16()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|_| "Connection interrupted")? {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("Response exceeds 8 MiB".into());
        }
        bytes.extend_from_slice(&chunk)
    }
    serde_json::from_slice(&bytes).map_err(|_| "Expected a JSON response".into())
}
fn play_method(session: &Value) -> &str {
    if let Some(m) = session["PlayState"]["PlayMethod"]
        .as_str()
        .or(session["PlayMethod"].as_str())
    {
        return m;
    }
    let t = &session["TranscodingInfo"];
    if t.is_object() {
        if t["IsVideoDirect"].as_bool() == Some(true) && t["IsAudioDirect"].as_bool() == Some(true)
        {
            "DirectStream"
        } else {
            "Transcode"
        }
    } else if session["NowPlayingItem"].is_object() {
        "DirectPlay"
    } else {
        "Unknown"
    }
}

#[tauri::command]
pub async fn source_read(kind: String, address: String) -> Result<Value, String> {
    let base = endpoint(&address)?;
    let key = String::from_utf8(secret_for(&kind, &base)?.unwrap_or_default())
        .map_err(|_| "Invalid credential")?;
    let read = |path| get(&kind, &base, path, &key);
    match kind.as_str() {
        "json" => read("").await,
        "comfy" => {
            let q = read("queue").await?;
            let stats = read("system_stats").await?;
            Ok(
                json!({"running":q["queue_running"].as_array().map(Vec::len),"queued":q["queue_pending"].as_array().map(Vec::len),"devices":stats["devices"],"system":stats["system"]}),
            )
        }
        "emby" => {
            let sessions = read("Sessions").await?;
            let rows:Vec<_>=sessions.as_array().ok_or("Expected sessions")?.iter().filter(|s|s["NowPlayingItem"].is_object()).map(|s|json!({"session":s["Id"],"overview":s["NowPlayingItem"]["Overview"],"rating":s["NowPlayingItem"]["CommunityRating"],"critics":s["NowPlayingItem"]["CriticRating"],"year":s["NowPlayingItem"]["ProductionYear"],"client":s["Client"],"mediaId":s["NowPlayingItem"]["Id"],"title":s["NowPlayingItem"]["Name"],"series":s["NowPlayingItem"]["SeriesName"],"user":s["UserName"],"device":s["DeviceName"],"method":play_method(s),"paused":s["PlayState"]["IsPaused"],"position":s["PlayState"]["PositionTicks"],"duration":s["NowPlayingItem"]["RunTimeTicks"]})).collect();
            Ok(json!({"streams":rows.len(),"sessions":rows}))
        }
        "proxmox" => read("api2/json/cluster/resources").await,
        "unraid" => {
            let system = read("system").await?;
            let array = read("array").await?;
            let disks = read("disks").await.ok();
            let containers = read("docker").await.ok();
            let running = containers.as_ref().and_then(Value::as_array).map(|rows| {
                rows.iter()
                    .filter(|c| c["state"] == "running")
                    .map(|c| json!({"name":c["name"],"cpu":c["cpu_percent"]}))
                    .collect::<Vec<_>>()
            });
            Ok(json!({"system":system,"array":array,"disks":disks,"running":running}))
        }
        "omlx" => {
            let mut status = read("api/status").await?;
            if let Ok(activity) = read("admin/api/activity").await {
                status["active_models"] = activity["active_models"].clone();
            }
            Ok(status)
        }
        _ => Err("Unknown provider".into()),
    }
}

#[tauri::command]
pub async fn poster(address: String, media_id: String) -> Result<String, String> {
    if media_id.len() > 128
        || media_id.is_empty()
        || !media_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid media ID".into());
    }
    let base = endpoint(&address)?;
    let mut url = base.clone();
    url.set_path(&format!(
        "{}/Items/{}/Images/Primary",
        base.path().trim_end_matches('/'),
        media_id
    ));
    url.set_query(Some("maxWidth=256&quality=80&format=jpg"));
    let mut req = http().get(url);
    if let Some(key) = secret_for("emby", &base)? {
        req = req.header("X-Emby-Token", key);
    }
    image_data(req, 512000).await
}

#[tauri::command]
pub async fn comfy_preview(address: String) -> Result<String, String> {
    let base = endpoint(&address)?;
    let key = String::from_utf8(secret_for("comfy", &base)?.unwrap_or_default())
        .map_err(|_| "Invalid credential")?;
    let records = get("comfy", &base, "history?max_items=4", &key).await?;
    let mut jobs: Vec<_> = records
        .as_object()
        .ok_or("History unavailable")?
        .values()
        .collect();
    jobs.sort_by_key(|v| {
        std::cmp::Reverse(v.pointer("/prompt/0").and_then(Value::as_i64).unwrap_or(0))
    });
    let image = jobs
        .into_iter()
        .filter_map(|j| j["outputs"].as_object())
        .flat_map(|o| o.values())
        .filter_map(|node| node["images"].as_array())
        .flatten()
        .find(|i| i["type"] == "output" && i["filename"].is_string())
        .ok_or("No image outputs yet")?;
    let filename = image["filename"].as_str().unwrap_or_default();
    let folder = image["subfolder"].as_str().unwrap_or_default();
    if filename.contains(['/', '\\'])
        || folder.split(['/', '\\']).any(|p| p == "..")
        || folder.starts_with('/')
    {
        return Err("Invalid output path".into());
    }
    let mut url = base.clone();
    url.set_path(&format!("{}/view", base.path().trim_end_matches('/')));
    url.query_pairs_mut().extend_pairs([
        ("filename", filename),
        ("subfolder", folder),
        ("type", "output"),
        ("preview", "jpeg;65"),
    ]);
    let mut request = http().get(url);
    if !key.is_empty() {
        request = request.bearer_auth(key)
    }
    image_data(request, 4 * 1024 * 1024).await
}

async fn image_data(req: reqwest::RequestBuilder, limit: usize) -> Result<String, String> {
    use base64::Engine;
    let mut response = req
        .send()
        .await
        .map_err(|_| "Image unavailable")?
        .error_for_status()
        .map_err(|_| "Image unavailable")?;
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Interrupted image")? {
        if data.len() + chunk.len() > limit {
            return Err("Image too large".into());
        }
        data.extend_from_slice(&chunk)
    }
    if !data.starts_with(&[255, 216]) {
        return Err("Expected JPEG".into());
    }
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(data)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints_keep_the_service_path_and_reject_embedded_credentials() {
        assert_eq!(
            endpoint("https://localhost:8080/api/v1/").unwrap().path(),
            "/api/v1/"
        );
        for invalid in [
            "file:///etc/hosts",
            "https://u:p@localhost",
            "http://localhost/?token=private",
        ] {
            assert!(endpoint(invalid).is_err());
        }
    }
    #[test]
    fn emby_counts_paused_direct_play_and_trusts_explicit_transcode_state() {
        assert_eq!(
            play_method(&json!({"NowPlayingItem":{},"PlayState":{"IsPaused":true}})),
            "DirectPlay"
        );
        assert_eq!(
            play_method(&json!({"NowPlayingItem":{},"PlayState":{"PlayMethod":"Transcode"}})),
            "Transcode"
        );
        assert_eq!(
            play_method(&json!({"TranscodingInfo":{"IsVideoDirect":true,"IsAudioDirect":true}})),
            "DirectStream"
        );
    }
}
