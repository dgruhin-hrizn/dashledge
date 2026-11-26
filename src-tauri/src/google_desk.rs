use serde_json::Value;
use std::{
    ffi::{c_char, c_void, CStr},
    process::Command,
};

extern "C" {
    fn desk_calendar_snapshot(request: i32) -> *mut c_char;
    fn free(ptr: *mut c_void);
}
#[tauri::command]
pub async fn desk_calendar(request: bool) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || unsafe {
        let ptr = desk_calendar_snapshot(i32::from(request));
        if ptr.is_null() {
            return Err("Could not read calendars on this Mac.".into());
        }
        let data = serde_json::from_slice(CStr::from_ptr(ptr).to_bytes())
            .map_err(|_| "Invalid calendar response.".to_string());
        free(ptr.cast());
        data
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn desk_open(target: String) -> Result<(), String> {
    let mut cmd = Command::new("/usr/bin/open");
    match target.as_str() {
        "apple-mail" => {
            cmd.args(["-b", "com.apple.mail"]);
        }
        "apple-compose" => {
            cmd.args(["-b", "com.apple.mail", "mailto:"]);
        }
        "automation" => {
            cmd.arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation");
        }
        s if s.starts_with("message://%3C") && s.ends_with("%3E") && s.len() < 8192 => {
            cmd.args(["-b", "com.apple.mail", s]);
        }
        "spark" => {
            cmd.args(["-b", "com.readdle.SparkDesktop"]);
        }
        "compose" => {
            cmd.args(["-b", "com.readdle.SparkDesktop", "mailto:"]);
        }
        s if s.starts_with("compose-to:") => {
            let address = &s["compose-to:".len()..];
            if address.len() > 254
                || address.matches('@').count() != 1
                || address.starts_with('@')
                || address.ends_with('@')
                || !address
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._+-@".contains(&c))
            {
                return Err("Enter a valid recipient address.".into());
            }
            cmd.args([
                "-b",
                "com.readdle.SparkDesktop",
                &format!("mailto:{address}"),
            ]);
        }
        "accounts" => {
            cmd.arg("x-apple.systempreferences:com.apple.Internet-Accounts-Settings.extension");
        }
        "privacy" => {
            cmd.arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars");
        }
        s if s.starts_with("readdle-spark://bl=")
            && s.len() > 20
            && s.len() < 8192
            && !s.chars().any(char::is_whitespace) =>
        {
            cmd.args(["-b", "com.readdle.SparkDesktop", s]);
        }
        s => {
            let url = reqwest::Url::parse(s).map_err(|_| "Invalid meeting link.")?;
            let host = url.host_str().unwrap_or("");
            if url.scheme() != "https"
                || !(matches!(
                    host,
                    "meet.google.com" | "zoom.us" | "teams.microsoft.com" | "teams.live.com"
                ) || host.ends_with(".zoom.us"))
            {
                return Err("Unsupported meeting link.".into());
            }
            cmd.arg(url.as_str());
        }
    }
    if cmd.status().map_err(|e| e.to_string())?.success() {
        Ok(())
    } else {
        Err("Could not open the requested app or link on this Mac.".into())
    }
}

#[tauri::command]
pub async fn desk_mail() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(||{
        let output=Command::new("/usr/bin/osascript").args(["-l","JavaScript","-e",include_str!("apple_mail.jxa")]).output().map_err(|e|e.to_string())?;
        if !output.status.success(){
            let error=String::from_utf8_lossy(&output.stderr);
            if error.contains("-1743"){return Err("Allow Dashledge to control Mail in System Settings → Privacy & Security → Automation.".into())}
            return Err("Could not read the Apple Mail inbox. Check that Mail has a configured account and try again.".into());
        }
        serde_json::from_slice(&output.stdout).map_err(|_|"Invalid Apple Mail response.".into())
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn desk_spark_inbox() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = dirs::home_dir()
            .ok_or("Cannot locate the Mac home folder.")?
            .join("Library/Application Support/Spark Desktop/core-data/messages.sqlite");
        if !path.is_file() {
            return Err(
                "Spark’s local inbox is unavailable. Open Spark Desktop and let it sync.".into(),
            );
        }
        let output = Command::new("/usr/bin/sqlite3")
            .args([
                "-batch",
                "-bail",
                "-readonly",
                "-init",
                "/dev/null",
                "-cmd",
                ".timeout 1200",
            ])
            .arg(path)
            .arg(include_str!("spark_inbox.sql"))
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            return Err(if error.contains("locked") {
                "Spark is syncing. The inbox will refresh shortly."
            } else if error.contains("no such") {
                "This version of Spark uses an unfamiliar inbox format."
            } else {
                "Dashledge could not read the local Spark inbox."
            }
            .into());
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|_| "Unrecognized Spark inbox response.".into())
    })
    .await
    .map_err(|e| e.to_string())?
}
