//! Read-only Spotify queue access. Playback itself stays on the local Mac.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{Client, Url};
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::Mutex,
    time::{Duration, Instant},
};

const REDIRECT: &str = "http://127.0.0.1:4848/callback";
const TOKEN: &str = "https://accounts.spotify.com/api/token";
static ACCESS: Mutex<Option<(String, String, Instant)>> = Mutex::new(None);

fn check_id(id: &str) -> Result<(), String> {
    if id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("Enter the 32-character Spotify Client ID.".into())
    }
}
fn random() -> Result<String, String> {
    let mut bytes = [0; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "Unable to start Spotify sign-in")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn authorize(id: &str) -> Result<(String, String), String> {
    let listener =
        TcpListener::bind("127.0.0.1:4848").map_err(|_| "Spotify sign-in port 4848 is busy.")?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let verifier = random()?;
    let state = random()?;
    let mut url = Url::parse("https://accounts.spotify.com/authorize").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id", id),
        ("redirect_uri", REDIRECT),
        ("response_type", "code"),
        ("scope", "user-read-playback-state"),
        ("state", &state),
        ("code_challenge_method", "S256"),
        (
            "code_challenge",
            &URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, verifier.as_bytes())),
        ),
    ]);
    std::process::Command::new("open")
        .arg(url.as_str())
        .status()
        .map_err(|e| e.to_string())?;
    let end = Instant::now() + Duration::from_secs(180);
    while Instant::now() < end {
        let (mut stream, _) = match listener.accept() {
            Ok(pair) => pair,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        let mut line = String::new();
        if BufReader::new((&stream).take(8192))
            .read_line(&mut line)
            .is_err()
        {
            continue;
        }
        let Some(path) = line
            .split_whitespace()
            .nth(1)
            .and_then(|p| p.strip_prefix("/callback?"))
        else {
            continue;
        };
        let mut callback = Url::parse(REDIRECT).unwrap();
        callback.set_query(Some(path));
        if !callback
            .query_pairs()
            .any(|(k, v)| k == "state" && v == state)
        {
            continue;
        }
        let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nReturn to Edge Workbench to view your queue.");
        return callback
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| (v.into_owned(), verifier))
            .ok_or("Spotify sign-in cancelled.".into());
    }
    Err("Spotify sign-in timed out.".into())
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
}
fn storage(id: &str) -> Url {
    Url::parse(&format!("https://accounts.spotify.com/{id}")).unwrap()
}
fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}
async fn exchange(id: &str, form: &[(&str, &str)]) -> Result<String, String> {
    let res = client()?
        .post(TOKEN)
        .form(form)
        .send()
        .await
        .map_err(|_| "Cannot reach Spotify.")?;
    if !res.status().is_success() {
        return Err("Reconnect your Spotify account.".into());
    }
    let token: Token = res.json().await.map_err(|_| "Invalid Spotify response.")?;
    if let Some(refresh) = token.refresh_token {
        crate::vault::set("spotify-queue", &storage(id), refresh)?
    }
    *ACCESS.lock().unwrap() = Some((
        id.into(),
        token.access_token.clone(),
        Instant::now() + Duration::from_secs(token.expires_in.saturating_sub(60)),
    ));
    Ok(token.access_token)
}
#[tauri::command]
pub fn spotify_open(uri: Option<String>) -> Result<(), String> {
    let mut command = std::process::Command::new("open");
    command.args(["-b", "com.spotify.client"]);
    if let Some(uri) = uri {
        if let Some(id) = uri
            .strip_prefix("spotify:track:")
            .or_else(|| uri.strip_prefix("spotify:episode:"))
        {
            if id.len() == 22 && id.bytes().all(|b| b.is_ascii_alphanumeric()) {
                command.arg(uri);
            }
        }
    }
    command
        .status()
        .ok()
        .filter(|status| status.success())
        .map(|_| ())
        .ok_or_else(|| "Install Spotify on this Mac to open the player.".into())
}

#[tauri::command]
pub async fn spotify_connect(client_id: String) -> Result<(), String> {
    check_id(&client_id)?;
    let id = client_id.clone();
    let (code, verifier) = tauri::async_runtime::spawn_blocking(move || authorize(&id))
        .await
        .map_err(|e| e.to_string())??;
    exchange(
        &client_id,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", &client_id),
            ("redirect_uri", REDIRECT),
            ("code", &code),
            ("code_verifier", &verifier),
        ],
    )
    .await?;
    Ok(())
}
#[tauri::command]
pub async fn spotify_queue(client_id: String) -> Result<Value, String> {
    check_id(&client_id)?;
    let cached = ACCESS
        .lock()
        .unwrap()
        .as_ref()
        .filter(|(id, _, exp)| id == &client_id && *exp > Instant::now())
        .map(|(_, t, _)| t.clone());
    let token = match cached {
        Some(t) => t,
        None => {
            let refresh = crate::vault::get("spotify-queue", &storage(&client_id))?
                .key
                .ok_or("Reconnect your Spotify account.")?;
            exchange(
                &client_id,
                &[
                    ("grant_type", "refresh_token"),
                    ("client_id", &client_id),
                    ("refresh_token", &refresh),
                ],
            )
            .await?
        }
    };
    let res = client()?
        .get("https://api.spotify.com/v1/me/player/queue")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Cannot reach Spotify.")?;
    match res.status().as_u16() {
        204 => return Ok(json!({"items":[]})),
        401 | 403 => {
            *ACCESS.lock().unwrap() = None;
            return Err("Reconnect Spotify to allow queue access.".into());
        }
        429 => {
            return Ok(
                json!({"retryAfter":res.headers().get("retry-after").and_then(|v|v.to_str().ok()?.parse::<u64>().ok()).unwrap_or(60)}),
            )
        }
        200 => (),
        _ => return Err("Queue unavailable. Try again shortly.".into()),
    }
    let data: Value = res.json().await.map_err(|_| "Invalid Spotify queue.")?;
    let items:Vec<_>=data["queue"].as_array().into_iter().flatten().take(12).map(|t|{
        let by=t["artists"].as_array().map(|a|a.iter().filter_map(|v|v["name"].as_str()).collect::<Vec<_>>().join(", ")).or_else(||t["show"]["name"].as_str().map(String::from));
        json!({"title":t["name"],"artist":by,"art":t.pointer("/album/images/0/url").or_else(||t.pointer("/images/0/url"))})
    }).collect();
    Ok(json!({"current":data["currently_playing"]["uri"],"items":items}))
}
