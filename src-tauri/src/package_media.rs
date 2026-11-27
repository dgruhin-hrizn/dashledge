//! The `images` capability. A package view asks for an image its manifest's `images`
//! patterns allow; Dashledge fetches it (with the connection's credential when it is on
//! the connection, without one on a declared host), checks that the bytes really are a
//! raster image, caches it, and returns the bytes. The bridge hands them to the frame,
//! which shows them from a `blob:` URL. The view itself still can't reach the network.
use crate::package_connector::{self, Request, Target};
use crate::package_manifest::{self, Permission};
use reqwest::Url;
use std::{
    collections::VecDeque,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

const CACHE_LIMIT: usize = 64 * 1024 * 1024;
const CACHE_AGE: Duration = Duration::from_secs(600);

struct Cached {
    key: String,
    at: Instant,
    bytes: Arc<Vec<u8>>,
}
static CACHE: LazyLock<Mutex<VecDeque<Cached>>> = LazyLock::new(Default::default);

fn cached(key: &str) -> Option<Arc<Vec<u8>>> {
    let mut cache = CACHE.lock().unwrap();
    let index = cache.iter().position(|c| c.key == key)?;
    let entry = cache.remove(index)?;
    if entry.at.elapsed() > CACHE_AGE {
        return None;
    }
    let bytes = entry.bytes.clone();
    cache.push_back(entry); // most recently used last
    Some(bytes)
}

fn remember(key: String, bytes: Arc<Vec<u8>>) {
    let mut cache = CACHE.lock().unwrap();
    cache.retain(|c| c.key != key);
    cache.push_back(Cached { key, at: Instant::now(), bytes });
    let mut total: usize = cache.iter().map(|c| c.bytes.len()).sum();
    while total > CACHE_LIMIT {
        let Some(oldest) = cache.pop_front() else { break };
        total -= oldest.bytes.len();
    }
}

/// The image format of `bytes` by signature: JPEG, PNG, GIF or WebP. SVG and anything
/// else is refused, because only raster images are inert.
pub fn image_kind(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0xff, 0xd8, 0xff, ..] => Some("image/jpeg"),
        [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, ..] => Some("image/png"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

/// Where an image request goes, if the manifest allows it.
fn image_url(manifest: &package_manifest::Manifest, target: Option<&Target>, path: &str) -> Result<Url, String> {
    let refused = || format!("This widget didn’t declare the image “{path}”.");
    let (route, query) = path.split_once('?').map_or((path, None), |(p, q)| (p, Some(q)));
    if query.is_some_and(|q| !package_manifest::image_query(q)) {
        return Err(refused());
    }
    if let Some((origin, rest)) = package_manifest::split_origin(route) {
        let declared = manifest.images.iter().filter_map(|p| package_manifest::split_origin(p))
            .any(|(o, pattern)| o.eq_ignore_ascii_case(origin) && package_manifest::image_matches(pattern, rest));
        let host = manifest.connector.as_ref().is_some_and(|c| c.hosts.iter().any(|h| h.eq_ignore_ascii_case(origin)));
        if !declared || !host {
            return Err(refused());
        }
        return Url::parse(path).map_err(|_| refused());
    }
    let declared = manifest.images.iter().filter(|p| package_manifest::split_origin(p).is_none())
        .any(|pattern| package_manifest::image_matches(pattern, route));
    let target = target.ok_or("Choose a connection for this widget.")?;
    if !declared {
        return Err(refused());
    }
    Ok(package_connector::route_url(&target.base, path))
}

/// Fetch an image a package view asked for. `fresh` skips the cache (a camera snapshot).
#[tauri::command]
pub async fn package_image(id: String, viewer: String, path: String, fresh: Option<bool>) -> Result<tauri::ipc::Response, String> {
    let (kind, connection) = package_connector::feed_connection(&id, &viewer)?;
    let manifest = package_connector::installed_manifest(&kind)?;
    if !manifest.permissions.contains(&Permission::Images) {
        return Err("This widget didn’t declare the images permission.".into());
    }
    let target = connection.as_ref().map(|c| Target::new(&kind, &c.address)).transpose()?;
    let url = image_url(&manifest, target.as_ref(), &path)?;
    let key = format!("{kind}|{url}");
    if fresh != Some(true) {
        if let Some(bytes) = cached(&key) {
            return Ok(tauri::ipc::Response::new(bytes.to_vec()));
        }
    }
    let auth = manifest.auth_for(connection.as_ref().and_then(|c| c.source_type.as_deref()));
    let request = Request { url, method: "GET".into(), headers: vec![("Accept".into(), "image/*".into())], body: None };
    let response = package_connector::exchange(&kind, target.as_ref(), &auth, request).await?;
    if !(200..300).contains(&response.status) {
        return Err(format!("Server returned HTTP {}", response.status));
    }
    if image_kind(&response.body).is_none() {
        return Err("That isn’t a JPEG, PNG, GIF or WebP image.".into());
    }
    let bytes = Arc::new(response.body);
    remember(key, bytes.clone());
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> package_manifest::Manifest {
        let raw = json!({"apiVersion": 2, "id": "plugin.posters", "title": "Posters", "icon": "i.png", "view": {"entry": "index.html"},
            "sources": {"min": 1, "max": 1, "auth": {"header": "X-Api-Key"}},
            "permissions": ["images"], "images": ["api/v3/mediacover/*/*.jpg", "https://images.example.com/t/p/*/*"],
            "connector": {"entry": "connector.js", "hosts": ["https://images.example.com"]}});
        package_manifest::validate(&raw, package_manifest::Origin::Installed).unwrap()
    }

    #[test]
    fn only_declared_images_on_the_connection_or_a_declared_host_are_fetched() {
        let m = manifest();
        let base = Url::parse("http://radarr.local:7878/radarr/").unwrap();
        let target = Target { base: base.clone(), account: Url::parse("http://radarr.local:7878/radarr").unwrap() };
        assert_eq!(image_url(&m, Some(&target), "api/v3/mediacover/12/poster-250.jpg?lastWrite=6381").unwrap().as_str(),
            "http://radarr.local:7878/radarr/api/v3/mediacover/12/poster-250.jpg?lastWrite=6381");
        assert_eq!(image_url(&m, Some(&target), "https://images.example.com/t/p/w342/abc.jpg").unwrap().host_str(), Some("images.example.com"));
        for bad in ["api/v3/system/status", "api/v3/mediacover/12/../../config.jpg", "https://evil.example.com/t/p/w342/a.jpg",
                    "https://images.example.com/other/a.jpg", "api/v3/mediacover/12/a.jpg?x=<y>"] {
            assert!(image_url(&m, Some(&target), bad).is_err(), "{bad}");
        }
        assert!(image_url(&m, None, "api/v3/mediacover/1/a.jpg").is_err(), "connection images need a connection");
    }

    #[test]
    fn only_raster_images_pass_and_the_cache_keeps_the_newest() {
        assert_eq!(image_kind(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(image_kind(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_kind(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None);
        assert_eq!(image_kind(b"{\"error\":\"nope\"}"), None);
        remember("t|a".into(), Arc::new(vec![1; 10]));
        remember("t|b".into(), Arc::new(vec![2; 10]));
        assert_eq!(cached("t|a").unwrap()[0], 1);
        remember("t|huge".into(), Arc::new(vec![3; CACHE_LIMIT]));
        assert!(cached("t|b").is_none(), "the oldest entries make room");
        assert!(cached("t|huge").is_some());
        CACHE.lock().unwrap().clear();
    }
}
