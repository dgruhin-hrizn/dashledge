//! One update check per app launch, then daily while the menu bar app is running.
use std::{
    process::Command,
    sync::{LazyLock, Mutex},
    time::{Duration, SystemTime},
};
use tauri::WebviewWindow;

static RUNNING: Mutex<()> = Mutex::new(());
static STATUS: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new(String::new()));
const DAY: Duration = Duration::from_secs(24 * 60 * 60);

fn status(message: &str) {
    *STATUS.lock().unwrap() = message.to_owned();
}

#[tauri::command]
pub fn update_status() -> String {
    STATUS.lock().unwrap().clone()
}

fn check(automatic: bool) {
    let Ok(_guard) = RUNNING.try_lock() else {
        return;
    };
    status("Checking for updates…");
    let result = (|| -> Result<(), String> {
        let release = tauri::async_runtime::block_on(crate::general::check_release())?;
        if release["available"] != true {
            status(
                release["message"]
                    .as_str()
                    .unwrap_or("No update available."),
            );
            return Ok(());
        }
        if automatic && !crate::general::general_settings().auto_updates {
            status("Automatic updates are off.");
            return Ok(());
        }
        let tag = release["tag"].as_str().ok_or("Missing release tag.")?;
        let version = tag
            .strip_prefix('v')
            .ok_or("Expected a versioned release tag.")?;
        let helper = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("Missing app executable directory.")?
            .join("../Helpers/DashledgeUpdater");
        status(&format!("Downloading and verifying Dashledge {version}. The app will reopen after installation."));
        let output = Command::new(helper)
            .args(["--update", version])
            .output()
            .map_err(|e| format!("Could not launch the updater: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        }
        Ok(())
    })();
    if let Err(error) = result {
        crate::log(&format!("update: {error}"));
        status(&format!("Update failed. {error}"));
    }
}

#[tauri::command]
pub async fn check_and_install(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("Open Settings to install an update.".into());
    }
    tauri::async_runtime::spawn_blocking(|| check(false))
        .await
        .map_err(|e| e.to_string())
}

fn due(last: Option<SystemTime>, now: SystemTime) -> bool {
    last.is_none_or(|then| {
        now.duration_since(then)
            .map_or(true, |elapsed| elapsed >= DAY)
    })
}

pub fn start() {
    std::thread::spawn(move || {
        let mut last = None;
        loop {
            if crate::general::general_settings().auto_updates {
                let now = SystemTime::now();
                if due(last, now) {
                    last = Some(now);
                    check(true);
                }
            } else {
                last = None;
            }
            std::thread::sleep(Duration::from_secs(60));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checks_on_launch_then_daily_and_after_a_missed_day() {
        let launch = SystemTime::UNIX_EPOCH + DAY;
        assert!(due(None, launch));
        assert!(!due(Some(launch), launch + DAY - Duration::from_secs(1)));
        assert!(due(Some(launch), launch + DAY));
        assert!(due(Some(launch), launch + DAY * 3));
    }
}
