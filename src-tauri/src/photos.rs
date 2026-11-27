use serde::Deserialize;
use serde_json::{json, Value};
use std::ffi::{c_char, c_void, CStr, CString};

extern "C" {
    fn dash_photos(args: *const c_char) -> *mut c_char;
    fn free(p: *mut c_void);
}

#[derive(Deserialize, serde::Serialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum PhotoRequest {
    Catalog { ask: bool },
    Select {
        source: String,
        #[serde(default)]
        albums: Vec<String>,
        #[serde(default, rename = "skipScreenshots")]
        skip_screenshots: bool,
    },
    Image {
        id: String,
        /// Longest edge wanted, in pixels; photos.m clamps it.
        #[serde(default)]
        size: Option<u32>,
        /// Also report the salient point, so a cropped frame keeps its subject.
        #[serde(default)]
        focus: bool,
    },
}

/// Ask photos.m for one action, off the main thread. Its `error` field becomes Err.
async fn call(request: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args = CString::new(request.to_string()).map_err(|e| e.to_string())?;
        unsafe {
            let p = dash_photos(args.as_ptr());
            if p.is_null() {
                return Err("Photos unavailable".into());
            }
            let result = serde_json::from_slice::<Value>(CStr::from_ptr(p).to_bytes());
            free(p.cast());
            let result = result.map_err(|e| e.to_string())?;
            if let Some(e) = result["error"].as_str() {
                return Err(e.to_string());
            }
            Ok(result)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reads only: the catalog, a selection, or an image. Writes go through `photos_set_favorite`.
#[tauri::command]
pub async fn photos_read(request: PhotoRequest) -> Result<Value, String> {
    call(json!(request)).await
}

/// Photos identifiers look like "8A1C…-…/L0/001".
pub fn valid_asset_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '/')
}

fn favorite_request(id: &str, favorite: bool) -> Result<Value, String> {
    if !valid_asset_id(id) {
        return Err("Not a Photos id.".into());
    }
    Ok(json!({"action": "favorite", "id": id, "favorite": favorite}))
}

/// Mark or unmark a photo as a Favorite in Photos. `id` is the asset id from a selection.
/// Resolves to the photo's new state.
#[tauri::command]
pub async fn photos_set_favorite(id: String, favorite: bool) -> Result<bool, String> {
    let result = call(favorite_request(&id, favorite)?).await?;
    result["favorite"].as_bool().ok_or_else(|| "Photos didn't confirm the change.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // JS sends these fields; anything missing from the enum is silently dropped on the way to photos.m.
    #[test]
    fn requests_keep_every_field_photos_m_reads() {
        let select: PhotoRequest = serde_json::from_value(json!({"action":"select","source":"library","skipScreenshots":true})).unwrap();
        assert_eq!(json!(select), json!({"action":"select","source":"library","albums":[],"skipScreenshots":true}));
        let image: PhotoRequest = serde_json::from_value(json!({"action":"image","id":"a","size":2048,"focus":true})).unwrap();
        assert_eq!(json!(image), json!({"action":"image","id":"a","size":2048,"focus":true}));
        let old: PhotoRequest = serde_json::from_value(json!({"action":"image","id":"a"})).unwrap();
        assert_eq!(json!(old)["size"], Value::Null);
    }

    // The read command can never carry a write.
    #[test]
    fn reads_cannot_ask_for_a_favorite_change() {
        assert!(serde_json::from_value::<PhotoRequest>(json!({"action":"favorite","id":"a","favorite":true})).is_err());
    }

    #[test]
    fn checks_asset_ids() {
        assert!(valid_asset_id("8A1C2B3D-1234-ABCD-9999-0123456789AB/L0/001"));
        assert!(!valid_asset_id(""));
        assert!(!valid_asset_id("../x"));
        assert!(!valid_asset_id("a b"));
        assert!(!valid_asset_id("a\"}"));
        assert!(!valid_asset_id(&"A".repeat(201)));
        assert!(valid_asset_id(&"A".repeat(200)));
    }

    #[test]
    fn favorite_requests_are_built_only_for_valid_ids() {
        assert_eq!(
            favorite_request("ABC-1/L0/001", false).unwrap(),
            json!({"action":"favorite","id":"ABC-1/L0/001","favorite":false})
        );
        assert!(favorite_request("../etc", true).is_err());
    }
}
