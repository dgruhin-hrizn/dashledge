use reqwest::{Client, Url};
use std::{process::Command, time::Duration};

#[tauri::command]
pub async fn news_headlines(source: String) -> Result<String, String> {
    let feed = match source.as_str() {
        "bbc" => "https://feeds.bbci.co.uk/news/rss.xml",
        "technology" => "https://feeds.bbci.co.uk/news/technology/rss.xml",
        "guardian" => "https://www.theguardian.com/world/rss",
        _ => return Err("Choose an available edition.".into()),
    };
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Dashledge RSS reader")
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(feed)
        .send()
        .await
        .map_err(|_| "Cannot reach the publisher.")?
        .error_for_status()
        .map_err(|_| "The publisher is unavailable.")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Feed download interrupted.")?
    {
        if bytes.len() + chunk.len() > 2_000_000 {
            return Err("Feed exceeds the size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Unreadable publisher feed.".into())
}

fn news_destination(raw: &str) -> Result<(Url, bool), String> {
    let url = Url::parse(raw).map_err(|_| "Invalid story link.")?;
    let host = url.host_str().unwrap_or("");
    let apple = host == "apple.news";
    let publisher = ["bbc.com", "bbc.co.uk", "theguardian.com"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !(apple || publisher)
    {
        return Err("Choose an Apple News or supported publisher story.".into());
    }
    Ok((url, apple))
}

#[tauri::command]
pub fn news_open(link: Option<String>) -> Result<(), String> {
    let mut command = Command::new("/usr/bin/open");
    if let Some(raw) = link {
        let (url, apple) = news_destination(&raw)?;
        if apple {
            command.args(["-b", "com.apple.news"]);
        }
        command.arg(url.as_str());
    } else {
        command.args(["-b", "com.apple.news"]);
    }
    if command.status().map_err(|e| e.to_string())?.success() {
        Ok(())
    } else {
        Err("macOS could not open this destination.".into())
    }
}

#[tauri::command]
pub async fn news_clipboard_link() -> Result<serde_json::Value, String> {
    use std::ffi::{c_char, c_void, CStr};
    extern "C" {
        fn dash_news_clipboard() -> *mut c_char;
        fn free(ptr: *mut c_void);
    }
    tauri::async_runtime::spawn_blocking(|| unsafe {
        let ptr = dash_news_clipboard();
        if ptr.is_null() {
            return Err("In Apple News, copy a story, channel, or topic link first.".into());
        }
        let result =
            serde_json::from_slice(CStr::from_ptr(ptr).to_bytes()).map_err(|e| e.to_string());
        free(ptr.cast());
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routes_news_and_publisher_links() {
        assert!(news_destination("https://apple.news/A123").unwrap().1);
        assert!(
            !news_destination("https://www.bbc.com/news/articles/123")
                .unwrap()
                .1
        );
        for link in [
            "file:///tmp/story",
            "https://bbc.com.example.org/story",
            "https://user@apple.news/A",
            "https://apple.news:8000/A",
        ] {
            assert!(news_destination(link).is_err());
        }
    }
}
