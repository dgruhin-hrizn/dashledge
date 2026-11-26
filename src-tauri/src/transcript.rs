//! Read the bounded tail of a selected local Ember conversation.
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

fn summary(record: &Value, rows: &mut Vec<Value>) {
    let role = record["type"].as_str().unwrap_or("");
    if !matches!(role, "user" | "assistant")
        || record["isSidechain"] == true
        || record["isCompactSummary"] == true
    {
        return;
    }
    let content = &record["message"]["content"];
    let mut add = |kind: &str, label: &str, text: &str| {
        if !text.is_empty() || !label.is_empty() {
            rows.push(json!({"kind":kind,"label":label,"text":text.chars().take(5000).collect::<String>()}));
        }
    };
    if let Some(text) = content.as_str() {
        add(role, "", text);
        return;
    }
    for block in content.as_array().into_iter().flatten() {
        match block["type"].as_str() {
            Some("text") => add(role, "", block["text"].as_str().unwrap_or("")),
            Some("thinking") => add(
                "thinking",
                "Thought",
                block["thinking"].as_str().unwrap_or(""),
            ),
            Some("tool_use") => {
                let name = block["name"].as_str().unwrap_or("Tool");
                let input = &block["input"];
                let label = input["description"].as_str().unwrap_or(name);
                let detail = input["command"]
                    .as_str()
                    .or(input["file_path"].as_str())
                    .map(str::to_owned)
                    .unwrap_or_else(|| input.to_string());
                add("tool", label, &detail);
            }
            Some("tool_result") => {
                let c = &block["content"];
                let text = c.as_str().map(str::to_owned).unwrap_or_else(|| {
                    c.as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                });
                add(
                    "result",
                    if block["is_error"] == true {
                        "Tool error"
                    } else {
                        "Tool result"
                    },
                    &text,
                );
            }
            _ => {}
        }
    }
}
struct Cached {
    path: PathBuf,
    stamp: SystemTime,
    size: u64,
    rows: Value,
}
#[tauri::command]
pub async fn ember_transcript(chat: String, folders: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || tail(&chat, &folders))
        .await
        .map_err(|_| "Chat reader unavailable".to_string())?
}
fn tail(chat: &str, folders: &[String]) -> Result<Value, String> {
    if chat.is_empty()
        || chat.len() > 96
        || !chat.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid chat ID".into());
    }
    let home = dirs::home_dir().ok_or("Home folder unavailable")?;
    let root = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"))
        .join("projects")
        .canonicalize()
        .map_err(|_| "No local transcript directory")?;
    let mut selected = None;
    for folder in folders.iter().take(5) {
        let slug: String = folder
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .take(240)
            .collect();
        if slug.is_empty() {
            continue;
        }
        if let Ok(path) = root.join(slug).join(format!("{chat}.jsonl")).canonicalize() {
            if path.starts_with(&root) && path.is_file() {
                selected = Some(path);
                break;
            }
        }
    }
    let path = selected.ok_or("Waiting for a local transcript")?;
    let mut file = File::open(&path).map_err(|_| "Cannot open this transcript")?;
    let metadata = file.metadata().map_err(|_| "Transcript unavailable")?;
    let size = metadata.len();
    let stamp = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    static CACHE: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Chat reader busy")?;
    if let Some(c) = cache.as_ref() {
        if c.path == path && c.stamp == stamp && c.size == size {
            return Ok(c.rows.clone());
        }
    }
    let start = size.saturating_sub(512 * 1024);
    file.seek(SeekFrom::Start(start))
        .map_err(|_| "Transcript unavailable")?;
    let mut data = Vec::new();
    file.take(size - start)
        .read_to_end(&mut data)
        .map_err(|_| "Transcript unavailable")?;
    let mut rows = Vec::new();
    for line in data.split(|b| *b == b'\n').skip(usize::from(start > 0)) {
        if let Ok(r) = serde_json::from_slice::<Value>(line) {
            summary(&r, &mut rows)
        }
    }
    if rows.len() > 100 {
        rows.drain(..rows.len() - 100);
    }
    let rows = Value::Array(rows);
    *cache = Some(Cached {
        path,
        stamp,
        size,
        rows: rows.clone(),
    });
    Ok(rows)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_user_text_and_tool_activity_in_order() {
        let mut out = vec![];
        summary(
            &json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Inspecting status"},{"type":"tool_use","name":"Read","input":{"file_path":"file.md"}}]}}),
            &mut out,
        );
        summary(
            &json!({"type":"user","message":{"content":"Next step"}}),
            &mut out,
        );
        assert_eq!(
            out.iter()
                .map(|r| r["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["thinking", "tool", "user"]
        );
    }
}
