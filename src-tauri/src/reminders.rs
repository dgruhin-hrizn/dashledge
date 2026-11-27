//! Apple Reminders for package views that declare the `reminders` permission. The
//! EventKit work is in `reminders.m`; the package bridge (`ui/package-bridge.js`) is
//! the only caller and refuses views without the permission.

use serde_json::Value;
use std::ffi::{c_char, c_void, CStr, CString};

extern "C" {
    fn reminders_snapshot(request: i32) -> *mut c_char;
    fn reminders_set_completed(id: *const c_char, completed: i32) -> *mut c_char;
    fn reminders_add(title: *const c_char, list: *const c_char) -> *mut c_char;
    fn free(ptr: *mut c_void);
}

const MAX_TITLE: usize = 300;

/// EventKit identifiers are UUID-like ASCII: letters, digits, `-`, `:` and `/`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b':' | b'/' | b'.' | b'_'))
}

/// A reminder title: trimmed, one line, no control characters, at most 300 characters.
pub fn clean_title(title: &str) -> Result<String, String> {
    let title: String = title.trim().chars().map(|c| if c.is_control() { ' ' } else { c }).take(MAX_TITLE).collect();
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("Type a reminder first.".into());
    }
    Ok(title)
}

unsafe fn take(ptr: *mut c_char) -> Result<Value, String> {
    if ptr.is_null() {
        return Err("Could not reach Reminders on this Mac.".into());
    }
    let data: Result<Value, String> = serde_json::from_slice(CStr::from_ptr(ptr).to_bytes()).map_err(|_| "Invalid Reminders response.".to_string());
    free(ptr.cast());
    let data = data?;
    match data.get("error").and_then(Value::as_str) {
        Some(error) if data.get("ok").is_none() && data.get("permission").is_none() => Err(error.to_string()),
        _ => Ok(data),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Lists, open reminders and the ones finished today. `request` asks macOS for access
/// when it hasn't been decided yet.
#[tauri::command]
pub async fn reminders_read(request: bool) -> Result<Value, String> {
    blocking(move || unsafe { take(reminders_snapshot(i32::from(request))) }).await
}

#[tauri::command]
pub async fn reminders_complete(id: String, completed: bool) -> Result<Value, String> {
    if !valid_id(&id) {
        return Err("Not a reminder".into());
    }
    blocking(move || unsafe {
        let id = CString::new(id).map_err(|_| "Not a reminder")?;
        take(reminders_set_completed(id.as_ptr(), i32::from(completed)))
    })
    .await
}

/// Adds to `list`, or to the default Reminders list when it is empty.
#[tauri::command]
pub async fn reminders_create(title: String, list: Option<String>) -> Result<Value, String> {
    let title = clean_title(&title)?;
    let list = list.unwrap_or_default();
    if !list.is_empty() && !valid_id(&list) {
        return Err("Not a Reminders list".into());
    }
    blocking(move || unsafe {
        let title = CString::new(title).map_err(|_| "Invalid title")?;
        let list = CString::new(list).map_err(|_| "Not a Reminders list")?;
        take(reminders_add(title.as_ptr(), list.as_ptr()))
    })
    .await
}

/// Opens Privacy & Security › Reminders, where a denied permission is changed.
#[tauri::command]
pub fn reminders_privacy() -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders")
        .status()
        .map_err(|e| e.to_string())
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_plain_ascii_identifiers() {
        assert!(valid_id("8A1F0C3E-1234-4B5C-9D6E-0F1A2B3C4D5E"));
        assert!(valid_id("x-apple-reminder://8A1F0C3E"));
        assert!(!valid_id(""));
        assert!(!valid_id("a b"));
        assert!(!valid_id("id\"; drop"));
        assert!(!valid_id(&"a".repeat(201)));
    }

    #[test]
    fn titles_are_trimmed_single_line_and_capped() {
        assert_eq!(clean_title("  Buy milk \n").unwrap(), "Buy milk");
        assert_eq!(clean_title("a\tb\nc").unwrap(), "a b c");
        assert!(clean_title("   ").is_err());
        assert!(clean_title("\n\t").is_err());
        assert_eq!(clean_title(&"é".repeat(400)).unwrap().chars().count(), MAX_TITLE);
    }
}
