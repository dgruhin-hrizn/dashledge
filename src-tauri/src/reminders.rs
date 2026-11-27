//! Apple Reminders for package views that declare the `reminders` permission. The
//! EventKit work is in `reminders.m`; the package bridge (`ui/package-bridge.js`) is
//! the only caller and refuses views without the permission.

use serde_json::Value;
use std::ffi::{c_char, c_void, CStr, CString};

extern "C" {
    fn reminders_snapshot(request: i32) -> *mut c_char;
    fn reminders_set_completed(id: *const c_char, completed: i32) -> *mut c_char;
    fn reminders_add(title: *const c_char, list: *const c_char, due: *const c_char, time: *const c_char, priority: i32) -> *mut c_char;
    fn reminders_revision() -> std::ffi::c_long;
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

/// A due day (`YYYY-MM-DD`) and optional time (`HH:MM`). Empty day means no due date;
/// a time needs a day.
pub fn clean_due(due: &str, time: &str) -> Result<(String, String), String> {
    let due = due.trim();
    let time = time.trim();
    if due.is_empty() {
        return if time.is_empty() { Ok((String::new(), String::new())) } else { Err("Choose a day for that time.".into()) };
    }
    chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d").map_err(|_| "Not a date".to_string())?;
    if due.len() != 10 {
        return Err("Not a date".into());
    }
    if !time.is_empty() && (time.len() != 5 || chrono::NaiveTime::parse_from_str(time, "%H:%M").is_err()) {
        return Err("Not a time".into());
    }
    Ok((due.to_string(), time.to_string()))
}

/// Reminders' priorities: 0 none, 1 high, 5 medium, 9 low.
pub fn valid_priority(priority: i32) -> bool {
    matches!(priority, 0 | 1 | 5 | 9)
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

/// Counts EventKit changes from anywhere; a view reads again when it moves.
#[tauri::command]
pub fn reminders_changes() -> i64 {
    unsafe { reminders_revision() as i64 }
}

/// Open reminders with a due time, for spoken alerts. None without access.
pub fn timed() -> Option<Vec<crate::voice::Due>> {
    let data = unsafe { take(reminders_snapshot(0)) }.ok()?;
    if data.get("permission").and_then(Value::as_str) != Some("allowed") || data.get("error").is_some() {
        return None;
    }
    let items = data.get("items")?.as_array()?;
    Some(
        items
            .iter()
            .filter(|item| item.get("completed").and_then(Value::as_bool) == Some(false))
            .filter_map(|item| {
                Some(crate::voice::Due {
                    id: item.get("id")?.as_str()?.to_string(),
                    title: item.get("title")?.as_str()?.to_string(),
                    due_at: item.get("dueAt")?.as_i64()?,
                })
            })
            .collect(),
    )
}

/// Adds to `list`, or to the default Reminders list when it is empty, due on `due`
/// (and at `time`) when given, with Reminders' `priority`.
#[tauri::command]
pub async fn reminders_create(title: String, list: Option<String>, due: Option<String>, time: Option<String>, priority: Option<i32>) -> Result<Value, String> {
    let title = clean_title(&title)?;
    let (due, time) = clean_due(due.as_deref().unwrap_or(""), time.as_deref().unwrap_or(""))?;
    let priority = priority.unwrap_or(0);
    if !valid_priority(priority) {
        return Err("Not a priority".into());
    }
    let list = list.unwrap_or_default();
    if !list.is_empty() && !valid_id(&list) {
        return Err("Not a Reminders list".into());
    }
    blocking(move || unsafe {
        let title = CString::new(title).map_err(|_| "Invalid title")?;
        let list = CString::new(list).map_err(|_| "Not a Reminders list")?;
        let due = CString::new(due).map_err(|_| "Not a date")?;
        let time = CString::new(time).map_err(|_| "Not a time")?;
        take(reminders_add(title.as_ptr(), list.as_ptr(), due.as_ptr(), time.as_ptr(), priority))
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
    fn due_dates_are_a_real_day_and_optional_time() {
        assert_eq!(clean_due("", "").unwrap(), (String::new(), String::new()));
        assert_eq!(clean_due("2026-11-28", "").unwrap(), ("2026-11-28".into(), String::new()));
        assert_eq!(clean_due(" 2026-11-28 ", "09:30").unwrap(), ("2026-11-28".into(), "09:30".into()));
        assert!(clean_due("", "09:30").is_err());
        assert!(clean_due("2026-02-30", "").is_err());
        assert!(clean_due("2026-11-28", "24:00").is_err());
        assert!(clean_due("2026-11-28", "9:30").is_err());
        assert!(clean_due("tomorrow", "").is_err());
        assert!(valid_priority(0) && valid_priority(1) && valid_priority(5) && valid_priority(9));
        assert!(!valid_priority(3) && !valid_priority(-1));
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
