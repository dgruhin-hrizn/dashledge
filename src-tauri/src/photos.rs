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
    Select { source: String, albums: Vec<String> },
    Image { id: String },
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
