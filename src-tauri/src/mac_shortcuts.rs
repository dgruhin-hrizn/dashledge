use serde::Serialize;
use std::collections::HashSet;
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use uuid::Uuid;

#[derive(Serialize)]
pub struct Shortcut {
    id: Uuid,
    name: String,
}

fn parse_line(line: &str) -> Option<Shortcut> {
    let (name, id) = line.trim_end().strip_suffix(')')?.rsplit_once(" (")?;
    Some(Shortcut {
        id: Uuid::parse_str(id).ok()?,
        name: name.to_owned(),
    })
}

fn execute(args: &[&str], capture: bool) -> Result<Vec<u8>, String> {
    let result = Command::new("/usr/bin/shortcuts")
        .args(args)
        .stdin(Stdio::null())
        .stdout(if capture {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if result.status.success() {
        return Ok(result.stdout);
    }
    let message = String::from_utf8_lossy(&result.stderr);
    Err(if message.trim().is_empty() {
        "Shortcuts could not complete the request.".into()
    } else {
        message.trim().chars().take(500).collect()
    })
}

#[tauri::command]
pub async fn mac_shortcuts_list() -> Result<Vec<Shortcut>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let bytes = execute(&["list", "--show-identifiers"], true)?;
        String::from_utf8_lossy(&bytes)
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                parse_line(line).ok_or_else(|| "Unexpected shortcut listing format.".into())
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

static RUNNING: LazyLock<Mutex<HashSet<Uuid>>> = LazyLock::new(Mutex::default);

#[tauri::command]
pub async fn mac_shortcut_run(id: Uuid) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !RUNNING.lock().unwrap().insert(id) {
            return Err("This shortcut is already running.".into());
        }
        let result = execute(&["run", &id.to_string()], false);
        RUNNING.lock().unwrap().remove(&id);
        result.map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn listing_preserves_names_and_distinguishes_identifiers() {
        let shortcut =
            parse_line("Lights (Office) 🌙 (153016DD-71EE-45CC-B412-49E336D8D98F)").unwrap();
        assert_eq!(shortcut.name, "Lights (Office) 🌙");
        assert!(parse_line("Lights (Office)").is_none());
    }
}
