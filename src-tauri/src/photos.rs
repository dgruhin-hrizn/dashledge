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
#[tauri::command]
pub async fn photos_read(request: PhotoRequest) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args = CString::new(json!(request).to_string()).map_err(|e| e.to_string())?;
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
}
