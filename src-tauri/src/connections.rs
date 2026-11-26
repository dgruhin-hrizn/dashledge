use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::{sync::OnceLock, time::Duration};

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
pub(crate) fn account_ids(kind: &str, base: &Url) -> Vec<String> {
    let exact = format!("{kind}|{base}");
    // Earlier releases saved bundled widgets' credentials with or without a trailing slash.
    if base.path() == "/" || !crate::package_store::is_bundled(kind) {
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
    Ok(crate::vault::get(kind, base)?.key.map(String::into_bytes))
}
pub(crate) fn widget_credentials(
    kind: &str,
    base: &Url,
) -> Result<(String, Option<String>), String> {
    let value = crate::vault::get(kind, base)?;
    Ok((value.key.unwrap_or_default(), value.ca))
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
    crate::vault::set(&kind, &base, secret)?;
    crate::widget_host::invalidate(&kind, &base);
    Ok(())
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
pub(crate) fn validate_ca(bytes: &[u8]) -> Result<Vec<reqwest::Certificate>, String> {
    let certs = reqwest::Certificate::from_pem_bundle(bytes)
        .map_err(|_| "Invalid Proxmox CA certificate")?;
    if certs.is_empty() {
        return Err("Missing Proxmox CA certificate".into());
    }
    Ok(certs)
}
/// A connection with a saved CA certificate trusts it; others use the system roots.
fn service_client(kind: &str, base: &Url) -> Result<Client, String> {
    match crate::vault::get(kind, base)?.ca {
        Some(pem) => {
            let mut builder = Client::builder()
                .timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none());
            for cert in validate_ca(pem.as_bytes())? {
                builder = builder.add_root_certificate(cert);
            }
            builder
                .build()
                .map_err(|_| "Could not load Proxmox CA certificate".into())
        }
        None => Ok(http().clone()),
    }
}

/// How a connection sends its credential: from its widget's manifest, else a bearer token.
fn auth_for(kind: &str) -> crate::package_manifest::Auth {
    crate::package_store::lookup(kind)
        .and_then(|(info, _)| info.manifest.sources.map(|s| s.auth))
        .unwrap_or(crate::package_manifest::Auth::Bearer)
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
        use crate::package_manifest::Auth;
        request = match auth_for(kind) {
            Auth::EmbyToken => request.header("X-Emby-Token", key),
            Auth::PveToken => request.header("Authorization", format!("PVEAPIToken={key}")),
            Auth::Bearer => request.bearer_auth(key),
            Auth::None => request,
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
// One in-flight JSON request per endpoint for all dashboard and preview windows.
// Keep samples in process memory. The Test button uses an independent fresh read.
type Reading = std::sync::Arc<tauri::async_runtime::Mutex<Option<(std::time::Instant, Result<Value,String>)>>>;
static READINGS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String,Reading>>> =
    std::sync::LazyLock::new(Default::default);
pub(crate) fn invalidate_reading(kind:&str,base:&Url) {
    if kind=="json"{READINGS.lock().unwrap().remove(base.as_str());}
}
#[tauri::command]
pub async fn widget_source_read(kind:String,address:String)->Result<Value,String>{
    if kind!="json"{return Err("Choose a JSON connection for this widget".into());}
    let base=endpoint(&address)?;
    let cell=READINGS.lock().unwrap().entry(base.to_string()).or_default().clone();
    let mut sample=cell.lock().await;
    if let Some((at,value))=&*sample{
        if at.elapsed()<Duration::from_secs(5){return value.clone();}
    }
    let result=source_read(kind,address).await;
    *sample=Some((std::time::Instant::now(),result.clone()));
    result
}

/// Test a connection: read every route its widget's manifest declares for Test.
#[tauri::command]
pub async fn source_read(kind: String, address: String) -> Result<Value, String> {
    let base = endpoint(&address)?;
    let key = String::from_utf8(secret_for(&kind, &base)?.unwrap_or_default())
        .map_err(|_| "Invalid credential")?;
    if kind == "json" {
        return get(&kind, &base, "", &key).await;
    }
    let (info, _) = crate::package_store::lookup(&kind).ok_or("Unknown provider")?;
    let routes = info.manifest.sources.map(|s| s.test).unwrap_or_default();
    for route in &routes {
        get(&kind, &base, route, &key).await?;
    }
    if routes.is_empty() {
        get(&kind, &base, "", &key).await?;
    }
    Ok(json!({"ok": true, "routes": routes.len().max(1)}))
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
    fn auth_style_comes_from_the_widget_manifest() {
        use crate::package_manifest::Auth;
        assert_eq!(auth_for("emby"), Auth::EmbyToken);
        assert_eq!(auth_for("proxmox"), Auth::PveToken);
        assert_eq!(auth_for("unraid"), Auth::Bearer);
        assert_eq!(auth_for("json"), Auth::Bearer);
    }
}
