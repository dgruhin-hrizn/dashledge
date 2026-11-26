//! Shared display preferences. Import only the matching General fields from Zurface.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::Path,
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct General {
    pub primary: String,
    pub accent: String,
    pub vertical: bool,
    pub show_seconds: bool,
    pub focus_minutes: u16,
    pub direct_touch: bool,
    pub display: String,
    pub auto_updates: bool,
}
impl Default for General {
    fn default() -> Self {
        Self {
            primary: "#edf0e6".into(),
            accent: "#f88d4f".into(),
            vertical: false,
            show_seconds: false,
            focus_minutes: 25,
            direct_touch: true,
            display: String::new(),
            auto_updates: true,
        }
    }
}
fn color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}
impl General {
    fn validate(&self) -> Result<(), String> {
        if !color(&self.primary)
            || !color(&self.accent)
            || !(1..=240).contains(&self.focus_minutes)
            || self.display.len() > 64
        {
            return Err("Invalid General setting".into());
        }
        Ok(())
    }
    fn imported(v: &Value) -> Self {
        let mut p = Self::default();
        for (key, target) in [
            ("customPrimary", &mut p.primary),
            ("customAccent", &mut p.accent),
        ] {
            if let Some(c) = v[key].as_str().filter(|c| color(c)) {
                *target = c.into();
            }
        }
        p.vertical = v["orientation"] == "vertical";
        p.show_seconds = v["showSeconds"].as_bool().unwrap_or(p.show_seconds);
        p.direct_touch = v["directTouch"].as_bool().unwrap_or(p.direct_touch);
        p.focus_minutes = v["focusMinutes"]
            .as_u64()
            .filter(|n| (1..=240).contains(n))
            .unwrap_or(25) as u16;
        p
    }
}
static PREFS: LazyLock<Mutex<General>> = LazyLock::new(Default::default);
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("general.json");
    let settings = match fs::read(&file) {
        Ok(data) => serde_json::from_slice::<General>(&data).map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let imported = dirs::home_dir()
                .and_then(|h| {
                    fs::read(h.join("Library/Application Support/Zeon/preferences.json")).ok()
                })
                .and_then(|b| serde_json::from_slice(&b).ok())
                .map(|v| General::imported(&v))
                .unwrap_or_default();
            persist(&file, &imported)?;
            imported
        }
        Err(e) => return Err(e.to_string()),
    };
    settings.validate()?;
    *PREFS.lock().unwrap() = settings;
    Ok(())
}
fn persist(file: &Path, p: &General) -> Result<(), String> {
    let dir = file.parent().ok_or("Settings directory unavailable")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut out = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut out, p).map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())?;
    out.persist(file).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn general_settings() -> General {
    PREFS.lock().unwrap().clone()
}
#[tauri::command]
pub fn save_general(
    window: WebviewWindow,
    app: tauri::AppHandle,
    settings: General,
) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("Open Settings to change preferences".into());
    }
    settings.validate()?;
    let mut p = PREFS.lock().unwrap();
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("general.json");
    persist(&file, &settings)?;
    let rotate = p.vertical != settings.vertical;
    *p = settings;
    let vertical = p.vertical;
    drop(p);
    crate::sync_touch(&app);
    if rotate {
        if let Some(win) = app.get_webview_window("preview") {
            size_preview(&win, vertical)?;
        }
    }
    Ok(())
}

extern "C" {
    fn ew_preview_size(window: *mut std::ffi::c_void, vertical: bool);
}
fn size_preview(win: &WebviewWindow, vertical: bool) -> Result<(), String> {
    let native = win.clone();
    win.run_on_main_thread(move || {
        if let Ok(ptr) = native.ns_window() {
            unsafe { ew_preview_size(ptr, vertical) }
        }
    })
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn open_preview(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("preview") {
        win.unminimize().map_err(|e| e.to_string())?;
        win.show().map_err(|e| e.to_string())?;
        return win.set_focus().map_err(|e| e.to_string());
    }
    let win = tauri::WebviewWindowBuilder::new(
        &app,
        "preview",
        tauri::WebviewUrl::App("preview.html".into()),
    )
    .on_web_resource_request(crate::widget_host::serve)
    .title("Edge Workbench Preview")
    .decorations(false)
    .always_on_top(true)
    .inner_size(960., 270.)
    .center()
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    size_preview(&win, general_settings().vertical)?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn preview_control(window: WebviewWindow, action: String) -> Result<(), String> {
    if window.label() != "preview" {
        return Err("Open the floating preview".into());
    }
    match action.as_str() {
        "move" => window.start_dragging(),
        "close" => window.close(),
        _ => return Err("Unknown preview action".into()),
    }
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn check_release() -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("Edge-Workbench")
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get("https://api.github.com/repos/dgruhin-hrizn/edge-workbench/releases/latest")
        .send()
        .await
        .map_err(|_| "Could not reach GitHub Releases.")?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(
            serde_json::json!({"message":"No public release is available for this repository."}),
        );
    }
    let release: Value = res
        .error_for_status()
        .map_err(|_| "GitHub could not complete the update check.")?
        .json()
        .await
        .map_err(|_| "Could not read the release details.")?;
    let tag = release["tag_name"]
        .as_str()
        .ok_or("Missing release version.")?;
    let latest = semver::Version::parse(tag.trim_start_matches('v'))
        .map_err(|_| "Unrecognized release version.")?;
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION")).unwrap();
    Ok(if latest > current {
        serde_json::json!({"message":format!("Version {latest} is available."),"available":true})
    } else {
        serde_json::json!({"message":format!("Version {current} is up to date.")})
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_supported_values_and_ignores_invalid_colors() {
        let p = General::imported(
            &serde_json::json!({"orientation":"vertical","customAccent":"bad","focusMinutes":40,"showSeconds":true}),
        );
        assert!(p.vertical && p.show_seconds);
        assert_eq!(p.focus_minutes, 40);
        assert_eq!(p.accent, General::default().accent);
    }
}
