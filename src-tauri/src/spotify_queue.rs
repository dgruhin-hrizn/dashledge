//! Spotify Connect playback, queue, playlists and artist metadata.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{Client, Url};
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
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
fn authorize(id: &str, library: bool, history: bool) -> Result<(String, String), String> {
    let listener =
        TcpListener::bind("127.0.0.1:4848").map_err(|_| "Spotify sign-in port 4848 is busy.")?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let verifier = random()?;
    let state = random()?;
    let mut url = Url::parse("https://accounts.spotify.com/authorize").unwrap();
    let mut scopes = String::from("user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative");
    if library {
        scopes.push_str(" user-library-read user-library-modify");
    }
    if history {
        scopes.push_str(" user-read-recently-played");
    }
    url.query_pairs_mut().extend_pairs([
        ("client_id", id),
        ("redirect_uri", REDIRECT),
        ("response_type", "code"),
        ("scope", scopes.as_str()),
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
    crate::oauth_callback::receive(listener, REDIRECT, &state).map(|code|(code,verifier))
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
    check_cooldown()?;
    let res = client()?
        .post(TOKEN)
        .form(form)
        .send()
        .await
        .map_err(|_| "Cannot reach Spotify.")?;
    let res = check_rate_limit(res).await?;
    if !res.status().is_success() {
        let status = res.status();
        let error = res.json::<Value>().await.unwrap_or_default();
        if error["error"] == "invalid_grant" {
            return Err("Reconnect Spotify. Your authorization has expired or was revoked.".into());
        }
        let detail = error["error_description"]
            .as_str()
            .unwrap_or("Try connecting again.");
        return Err(format!("Spotify authorization failed ({status}). {detail}"));
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
pub async fn spotify_connect(
    client_id: String,
    library: Option<bool>,
    history: Option<bool>,
) -> Result<(), String> {
    check_id(&client_id)?;
    let id = client_id.clone();
    let (code, verifier) = tauri::async_runtime::spawn_blocking(move || {
        authorize(&id, library.unwrap_or(false), history.unwrap_or(false))
    })
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
async fn access_token(client_id: &str) -> Result<String, String> {
    check_id(client_id)?;
    check_cooldown()?;
    static REFRESH: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());
    let _refresh = REFRESH.lock().await;
    let cached = ACCESS
        .lock()
        .unwrap()
        .as_ref()
        .filter(|(id, _, exp)| id == client_id && *exp > Instant::now())
        .map(|(_, t, _)| t.clone());
    let token = match cached {
        Some(t) => t,
        None => {
            let refresh = crate::vault::get("spotify-queue", &storage(client_id))?
                .key
                .ok_or("Reconnect Spotify to continue.")?;
            exchange(
                client_id,
                &[
                    ("grant_type", "refresh_token"),
                    ("client_id", client_id),
                    ("refresh_token", &refresh),
                ],
            )
            .await?
        }
    };
    Ok(token)
}

#[tauri::command]
pub async fn spotify_playlists(client_id: String, offset: u32) -> Result<Value, String> {
    let token = access_token(&client_id).await?;
    let response = send_player_request(
        client()?
            .get("https://api.spotify.com/v1/me/playlists")
            .query(&[("offset", offset), ("limit", 50)]),
        &token,
    )
    .await?;
    if response.status().as_u16() == 401 {
        *ACCESS.lock().unwrap() = None;
        return Ok(json!({"reconnect":true}));
    }
    let response = checked(response).await?;
    let page: Value = response
        .json()
        .await
        .map_err(|_| "Invalid playlist response.")?;
    let records = page["items"]
        .as_array()
        .ok_or("Invalid playlist response.")?;
    let items: Vec<_> = records
        .iter()
        .filter(|p| p["uri"].is_string())
        .map(|p| {
            json!({
                "uri":p["uri"], "name":p["name"], "owner":p.pointer("/owner/display_name"),
                "art":p.pointer("/images/0/url")
            })
        })
        .collect();
    let next = page["next"]
        .as_str()
        .filter(|_| !records.is_empty())
        .map(|_| offset.saturating_add(records.len() as u32));
    Ok(json!({"items":items, "next":next}))
}

#[tauri::command]
pub async fn spotify_queue(client_id: String) -> Result<Value, String> {
    let token = access_token(&client_id).await?;
    let res = send_player_request(
        client()?.get("https://api.spotify.com/v1/me/player/queue"),
        &token,
    )
    .await?;
    if res.status().as_u16() == 204 {
        return Ok(json!({"items":[]}));
    }
    let res = checked(res).await?;
    let data: Value = res.json().await.map_err(|_| "Invalid Spotify queue.")?;
    let items:Vec<_>=data["queue"].as_array().into_iter().flatten().take(12).map(|t|{
        let by=t["artists"].as_array().map(|a|a.iter().filter_map(|v|v["name"].as_str()).collect::<Vec<_>>().join(", ")).or_else(||t["show"]["name"].as_str().map(String::from));
        json!({"uri":t["uri"],"title":t["name"],"artist":by,"art":t.pointer("/album/images/0/url").or_else(||t.pointer("/images/0/url"))})
    }).collect();
    Ok(json!({"current":data["currently_playing"]["uri"],"items":items}))
}

fn resource_id(uri: &str, prefix: &str) -> Result<String, String> {
    uri.strip_prefix(prefix)
        .filter(|id| id.len() == 22 && id.bytes().all(|b| b.is_ascii_alphanumeric()))
        .map(String::from)
        .ok_or_else(|| "Invalid Spotify URI.".into())
}

// Only explicit catalog links use Launch Services. Transport stays on the Web API.
#[tauri::command]
pub fn spotify_catalog_link(uri: String) -> Result<(), String> {
    let mut pieces = uri.split(':');
    if pieces.next() != Some("spotify") {
        return Err("Invalid Spotify link.".into());
    }
    let kind = pieces.next().ok_or("Missing Spotify item.")?;
    if !matches!(kind, "track" | "episode" | "artist" | "album" | "playlist") {
        return Err("Unknown Spotify item.".into());
    }
    let id = resource_id(&uri, &format!("spotify:{kind}:"))?;
    let status = std::process::Command::new("/usr/bin/open")
        .arg(format!("https://open.spotify.com/{kind}/{id}"))
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not open the Spotify link.".into())
    }
}

// All widget windows share the Web API cooldown, including on-demand metadata calls.
static COOLDOWN: Mutex<Option<(Instant, bool, u32)>> = Mutex::new(None);
fn cooldown_message(quota: bool, seconds: u64) -> String {
    let reason = if quota {
        "Spotify developer quota reached."
    } else {
        "Spotify rate limit reached."
    };
    format!("{reason} Retry in {seconds} seconds.")
}
fn check_cooldown() -> Result<(), String> {
    if let Some((until, quota, _)) = *COOLDOWN.lock().unwrap() {
        if let Some(left) = until.checked_duration_since(Instant::now()) {
            return Err(cooldown_message(quota, left.as_secs() + 1));
        }
    }
    Ok(())
}
async fn send_player_request(
    request: reqwest::RequestBuilder,
    token: &str,
) -> Result<reqwest::Response, String> {
    check_cooldown()?;
    let response = request
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Cannot reach Spotify.")?;
    check_rate_limit(response).await
}

async fn check_rate_limit(response: reqwest::Response) -> Result<reqwest::Response, String> {
    if response.status().as_u16() != 429 {
        let mut cooldown = COOLDOWN.lock().unwrap();
        if response.status().is_success()
            && cooldown.is_some_and(|(until, _, _)| until <= Instant::now())
        {
            *cooldown = None;
        }
        return Ok(response);
    }
    let retry = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok()?.parse::<u32>().ok());
    let body = response.json::<Value>().await.unwrap_or_default();
    let quota = body
        .pointer("/error/reason")
        .or_else(|| body.get("reason"))
        .and_then(Value::as_str)
        == Some("QUOTA_EXCEEDED");
    let now = Instant::now();
    let mut cooldown = COOLDOWN.lock().unwrap();
    let attempt = cooldown.map_or(0, |(end, _, n)| if end > now { n } else { (n + 1).min(8) });
    let fallback = if quota { 900 } else { 5 };
    let delay = (fallback * (1u64 << attempt)).min(3600);
    let seconds = delay.max(u64::from(retry.unwrap_or(0)));
    let until = now + Duration::from_secs(seconds);
    if cooldown.is_none_or(|(end, _, _)| end < until) {
        *cooldown = Some((until, quota, attempt));
    }
    let (end, reason, _) = cooldown.unwrap();
    Err(cooldown_message(reason, end.duration_since(now).as_secs()))
}

async fn player_request(request: reqwest::RequestBuilder, token: &str) -> Result<Value, String> {
    let response = send_player_request(request, token).await?;
    let response = checked(response).await?;
    let body = response
        .bytes()
        .await
        .map_err(|_| "Couldn’t read Spotify’s response.")?;
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&body).map_err(|_| "Couldn’t read Spotify’s playback data.".into())
}

async fn checked(response: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.json::<Value>().await.unwrap_or_default();
    let detail = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("");
    let hint = match status.as_u16() {
        401 => {
            *ACCESS.lock().unwrap() = None;
            "Reconnect Spotify to continue."
        }
        403 => "Spotify denied access. Check your account and permissions.",
        404 => "Spotify could not find the device or item.",
        _ => "Spotify request failed.",
    };
    Err(format!("{hint} ({status}) {detail}").trim_end().into())
}

#[tauri::command]
pub async fn spotify_play_playlist(client_id: String, uri: String) -> Result<(), String> {
    resource_id(&uri, "spotify:playlist:")?;
    let token = access_token(&client_id).await?;
    let http = client()?;
    let request = http
        .put("https://api.spotify.com/v1/me/player/play")
        .json(&json!({"context_uri":uri}));
    start_playback(&http, &token, request).await
}

#[tauri::command]
pub async fn spotify_play_queue_track(
    client_id: String,
    context: Option<String>,
    tracks: Vec<String>,
) -> Result<(), String> {
    let first = tracks.first().ok_or("Choose a song from Up next.")?;
    for uri in &tracks {
        resource_id(uri, "spotify:track:")?;
    }
    let token = access_token(&client_id).await?;
    let http = client()?;
    let play = http.put("https://api.spotify.com/v1/me/player/play");
    if let Some(uri) =
        context.filter(|s| s.starts_with("spotify:playlist:") || s.starts_with("spotify:album:"))
    {
        let request = http
            .put("https://api.spotify.com/v1/me/player/play")
            .json(&json!({"context_uri":uri,"offset":{"uri":first}}));
        let response = send_player_request(request, &token).await?;
        // Manually queued tracks can be outside the active album or playlist.
        if !matches!(response.status().as_u16(), 400 | 404) {
            checked(response).await?;
            return Ok(());
        }
    }
    start_playback(&http, &token, play.json(&json!({"uris":tracks}))).await
}

// A paused Connect device can be available without being marked active.
async fn start_playback(
    http: &Client,
    token: &str,
    request: reqwest::RequestBuilder,
) -> Result<(), String> {
    let response =
        send_player_request(request.try_clone().ok_or("Cannot retry playback.")?, token).await?;
    if response.status().as_u16() == 404 {
        let devices = player_request(
            http.get("https://api.spotify.com/v1/me/player/devices"),
            token,
        )
        .await?;
        let mut available = devices["devices"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|device| device["is_restricted"] != true)
            .filter_map(|device| device["id"].as_str());
        let target = available.next().ok_or(
            "No Spotify Connect device is available. Start a playback device and try again.",
        )?;
        if available.next().is_some() {
            return Err("Choose an active Spotify Connect device, then try playback again.".into());
        }
        let response = send_player_request(request.query(&[("device_id", target)]), token).await?;
        checked(response).await?;
    } else {
        checked(response).await?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PanelAction {
    Search { query: String, offset: u32 },
    Enqueue { uri: String },
    Devices,
    Transfer { device: String },
    Volume { device: String, percent: u8 },
    Seek { milliseconds: u32 },
    Repeat { mode: String },
    Releases { artist: String, offset: u32 },
    PlayAlbum { uri: String },
    Save { uri: String },
    Saved { uri: String },
    History,
}

#[tauri::command]
pub async fn spotify_panel(client_id: String, action: PanelAction) -> Result<Value, String> {
    use PanelAction::*;
    let token = access_token(&client_id).await?;
    let http = client()?;
    let api = "https://api.spotify.com/v1";
    let player = format!("{api}/me/player");
    let request = match action {
        Search { query, offset } => http
            .get(format!("{api}/search"))
            .query(&[("q", query.trim()), ("type", "track"), ("limit", "10")])
            .query(&[("offset", offset)]),
        Devices => http.get(format!("{player}/devices")),
        History => http
            .get(format!("{player}/recently-played"))
            .query(&[("limit", 50)]),
        Releases { artist, offset } => {
            let id = resource_id(&artist, "spotify:artist:")?;
            http.get(format!("{api}/artists/{id}/albums"))
                .query(&[("include_groups", "album,single")])
                .query(&[("limit", 20), ("offset", offset)])
        }
        Saved { uri } => {
            resource_id(&uri, "spotify:track:")?;
            http.get(format!("{api}/me/library/contains"))
                .query(&[("uris", uri)])
        }
        PlayAlbum { uri } => {
            resource_id(&uri, "spotify:album:")?;
            start_playback(
                &http,
                &token,
                http.put(format!("{player}/play"))
                    .json(&json!({"context_uri":uri})),
            )
            .await?;
            return Ok(Value::Null);
        }
        write => {
            let request = match write {
                Enqueue { uri } => {
                    resource_id(&uri, "spotify:track:")?;
                    http.post(format!("{player}/queue")).query(&[("uri", uri)])
                }
                Save { uri } => {
                    resource_id(&uri, "spotify:track:")?;
                    http.put(format!("{api}/me/library"))
                        .query(&[("uris", uri)])
                }
                Transfer { device } => {
                    let request = http.put(&player).json(&json!({"device_ids":[device]}));
                    checked(send_player_request(request, &token).await?).await?;
                    return Ok(Value::Null);
                }
                Volume { device, percent } if percent <= 100 => http
                    .put(format!("{player}/volume"))
                    .query(&[("device_id", device)])
                    .query(&[("volume_percent", percent)]),
                Seek { milliseconds } => http
                    .put(format!("{player}/seek"))
                    .query(&[("position_ms", milliseconds)]),
                Repeat { mode } if matches!(mode.as_str(), "off" | "context" | "track") => http
                    .put(format!("{player}/repeat"))
                    .query(&[("state", mode)]),
                _ => return Err("Invalid Spotify control value.".into()),
            };
            checked(
                send_player_request(request.header(reqwest::header::CONTENT_LENGTH, "0"), &token)
                    .await?,
            )
            .await?;
            return Ok(Value::Null);
        }
    };
    player_request(request, &token).await
}

fn transport_command(
    http: &Client,
    base: &str,
    action: u8,
    enabled: bool,
) -> Result<reqwest::RequestBuilder, String> {
    let command = match action {
        1 => http.put(format!("{base}/{}", if enabled { "play" } else { "pause" })),
        2 => http.post(format!("{base}/next")),
        3 => http.post(format!("{base}/previous")),
        4 => http
            .put(format!("{base}/shuffle"))
            .query(&[("state", enabled)]),
        5 => http
            .put(format!("{base}/repeat"))
            .query(&[("state", if enabled { "context" } else { "off" })]),
        _ => return Err("Unknown playback control.".into()),
    };
    // Spotify requires an explicit length for transport writes with no payload.
    Ok(command.header(reqwest::header::CONTENT_LENGTH, "0"))
}

#[tauri::command]
pub async fn spotify_player(client_id: String, action: u8, enabled: bool) -> Result<Value, String> {
    let token = access_token(&client_id).await?;
    let http = client()?;
    let base = "https://api.spotify.com/v1/me/player";
    if action != 0 {
        let command = transport_command(&http, base, action, enabled)?;
        if action == 1 && enabled {
            start_playback(&http, &token, command).await?;
        } else {
            checked(send_player_request(command, &token).await?).await?;
        }
        return Ok(json!({"accepted": true}));
    }
    let state = player_request(
        http.get(base)
            .query(&[("additional_types", "track,episode")]),
        &token,
    )
    .await?;
    if state["item"].is_null() && state["is_playing"] != true {
        return Ok(
            json!({"noPlayback":true,"restricted":state.pointer("/device/is_restricted"),"status":"Press Play to resume, or choose a playlist."}),
        );
    }
    let item = &state["item"];
    let artist = item["artists"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a["name"].as_str())
        .collect::<Vec<_>>()
        .join(", ");
    Ok(json!({
        "title":item["name"],"uri":item["uri"],"artist":if artist.is_empty(){item.pointer("/show/name").and_then(Value::as_str).unwrap_or_default()}else{&artist},"artistUri":item.pointer("/artists/0/uri"),
        "restricted":state.pointer("/device/is_restricted"),"disallows":state.pointer("/actions/disallows").or_else(||state.get("actions")),
        "album":item.pointer("/album/name").or_else(||item.pointer("/show/publisher")),"artwork":item.pointer("/album/images/0/url").or_else(||item.pointer("/images/0/url")),
        "playing":state["is_playing"],"position":state["progress_ms"].as_f64().unwrap_or_default()/1000.0,
        "duration":item["duration_ms"].as_f64().unwrap_or_default()/1000.0,"context":state.pointer("/context/uri"),
        "device":state["device"],"repeatMode":state["repeat_state"],"shuffle":state["shuffle_state"],"repeat":matches!(state["repeat_state"].as_str(),Some("context"|"track")),
        "status":if item.is_null() {"Spotify hasn’t provided details for this item."} else {""}
    }))
}

#[tauri::command]
pub async fn spotify_detail(client_id: String, uri: String) -> Result<Value, String> {
    let path = if uri.starts_with("spotify:artist:") {
        format!("artists/{}", resource_id(&uri, "spotify:artist:")?)
    } else {
        format!("playlists/{}", resource_id(&uri, "spotify:playlist:")?)
    };
    let token = access_token(&client_id).await?;
    let data = player_request(
        client()?.get(format!("https://api.spotify.com/v1/{path}")),
        &token,
    )
    .await?;
    Ok(
        json!({"name":data["name"],"art":data.pointer("/images/0/url"),"genres":data["genres"],
        "followers":data.pointer("/followers/total"),"owner":data.pointer("/owner/display_name")}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_accepts_success_without_decoding_a_body() {
        for (status, body) in [(200, ""), (200, "OK"), (202, ""), (204, "")] {
            let response = tauri::http::Response::builder()
                .status(status)
                .body(body)
                .unwrap()
                .into();
            assert!(tauri::async_runtime::block_on(checked(response)).is_ok());
        }
        let denied = tauri::http::Response::builder()
            .status(403)
            .body(r#"{"error":{"message":"Device is restricted"}}"#)
            .unwrap()
            .into();
        assert!(tauri::async_runtime::block_on(checked(denied))
            .unwrap_err()
            .contains("Device is restricted"));
    }

    #[test]
    fn empty_transport_writes_declare_zero_length() {
        let http = client().unwrap();
        let base = "https://api.spotify.com/v1/me/player";
        for (action, enabled, method, endpoint) in [
            (1, true, "PUT", "play"),
            (1, false, "PUT", "pause"),
            (2, true, "POST", "next"),
            (3, true, "POST", "previous"),
            (4, true, "PUT", "shuffle?state=true"),
            (5, false, "PUT", "repeat?state=off"),
        ] {
            let request = transport_command(&http, base, action, enabled)
                .unwrap()
                .build()
                .unwrap();
            assert_eq!(request.method().as_str(), method);
            assert_eq!(request.url().as_str(), format!("{base}/{endpoint}"));
            assert_eq!(request.headers()[reqwest::header::CONTENT_LENGTH], "0");
            assert!(request.body().is_none());
        }
    }
}
