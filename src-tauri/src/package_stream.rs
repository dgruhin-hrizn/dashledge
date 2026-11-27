//! The `stream` capability. A package view opens a WebSocket route its manifest's
//! `streams` declare; Dashledge opens it on the placement's connection (with its
//! credential and saved CA, through the connector's NSURLSession socket) and relays each
//! frame to the dashboard over a Tauri channel: binary frames as raw bytes, everything
//! else as JSON events. The bridge moves them into the frame by transfer. Live camera
//! video (go2rtc MSE) plays from them with `video.srcObject = mediaSource`.
use crate::package_connector::{self, Target};
use crate::package_manifest::Permission;
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};
use tauri::ipc::{Channel, InvokeResponseBody};

/// Streams one feed may keep open, across its viewers.
const PER_FEED: usize = 4;
const MESSAGE_LIMIT: usize = 64 * 1024;

struct Stream {
    feed: String,
    viewer: String,
    channel: Channel<InvokeResponseBody>,
}
static STREAMS: LazyLock<Mutex<HashMap<i64, Stream>>> = LazyLock::new(Default::default);

/// A socket event from connector.m for a stream socket.
pub fn event(socket: i64, kind: &str, data: &str) {
    let channel = {
        let mut streams = STREAMS.lock().unwrap();
        let Some(stream) = streams.get(&socket) else { return };
        let channel = stream.channel.clone();
        if kind == "close" {
            streams.remove(&socket);
        }
        channel
    };
    let body = match kind {
        "binary" => {
            use base64::Engine;
            match base64::engine::general_purpose::STANDARD.decode(data) {
                Ok(bytes) => InvokeResponseBody::Raw(bytes),
                Err(_) => return,
            }
        }
        "message" => InvokeResponseBody::Json(json!({"event": "message", "text": data}).to_string()),
        "open" => InvokeResponseBody::Json(json!({"event": "open"}).to_string()),
        "error" => InvokeResponseBody::Json(json!({"event": "error", "message": data}).to_string()),
        "close" => InvokeResponseBody::Json(json!({"event": "close", "code": data.parse::<u16>().unwrap_or(1006)}).to_string()),
        _ => return,
    };
    // The window that opened it is gone: stop reading.
    if channel.send(body).is_err() {
        close(socket);
    }
}

fn close(socket: i64) {
    if STREAMS.lock().unwrap().remove(&socket).is_some() {
        package_connector::socket_close(socket);
    }
}

/// Close a feed's streams, or one viewer's.
pub fn close_for(feed: &str, viewer: Option<&str>) {
    retain(|f, v| f != feed || viewer.is_some_and(|viewer| viewer != v));
}

/// Keep the streams whose feed and viewer pass `keep`; close the rest.
pub fn retain(keep: impl Fn(&str, &str) -> bool) {
    let closed: Vec<i64> = STREAMS.lock().unwrap().iter().filter(|(_, s)| !keep(&s.feed, &s.viewer)).map(|(id, _)| *id).collect();
    for socket in closed {
        close(socket);
    }
}

fn owned(id: &str, viewer: &str, stream: i64) -> Result<(), String> {
    let streams = STREAMS.lock().unwrap();
    streams.get(&stream).filter(|s| s.feed == id && s.viewer == viewer).map(|_| ()).ok_or_else(|| "That stream is closed.".to_string())
}

/// Open a declared stream. Returns its ID; frames arrive on `channel`.
#[tauri::command]
pub async fn package_stream_open(id: String, viewer: String, stream: String, params: Map<String, Value>, connection: Option<usize>,
    channel: Channel<InvokeResponseBody>) -> Result<i64, String> {
    let (kind, connection) = package_connector::feed_connection(&id, &viewer, connection)?;
    let manifest = package_connector::installed_manifest(&kind)?;
    if !manifest.permissions.contains(&Permission::Stream) {
        return Err("This widget didn’t declare the stream permission.".into());
    }
    let declared = manifest.streams.iter().find(|s| s.id == stream).ok_or("This widget didn’t declare that stream.")?;
    let connection = connection.ok_or("Choose a connection for this widget.")?;
    let target = Target::new(&kind, &connection.address)?;
    let mut url = package_connector::route_url(&target.base, &package_connector::fill(&declared.path, &params)?);
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme).map_err(|_| "Invalid stream address")?;
    let socket = package_connector::next_socket();
    {
        let mut streams = STREAMS.lock().unwrap();
        if streams.values().filter(|s| s.feed == id).count() >= PER_FEED {
            return Err(format!("A widget may keep at most {PER_FEED} streams open."));
        }
        streams.insert(socket, Stream { feed: id.clone(), viewer: viewer.clone(), channel });
    }
    let auth = manifest.auth_for(connection.source_type.as_deref());
    if let Err(error) = package_connector::open_socket(package_connector::STREAM_HANDLE, socket, &kind, Some(&target), &auth, url).await {
        STREAMS.lock().unwrap().remove(&socket);
        return Err(error);
    }
    Ok(socket)
}

/// Send a text message on an open stream, such as go2rtc's codec handshake.
#[tauri::command]
pub fn package_stream_send(id: String, viewer: String, stream: i64, text: String) -> Result<(), String> {
    owned(&id, &viewer, stream)?;
    if text.len() > MESSAGE_LIMIT {
        return Err("Stream messages are limited to 64 KiB.".into());
    }
    package_connector::socket_send_text(stream, &text)
}

#[tauri::command]
pub fn package_stream_close(id: String, viewer: String, stream: i64) -> Result<(), String> {
    owned(&id, &viewer, stream)?;
    close(stream);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn register(socket: i64, feed: &str, viewer: &str) -> Arc<Mutex<Vec<InvokeResponseBody>>> {
        let received = Arc::new(Mutex::new(Vec::new()));
        let sink = received.clone();
        let channel = Channel::new(move |body| { sink.lock().unwrap().push(body); Ok(()) });
        STREAMS.lock().unwrap().insert(socket, Stream { feed: feed.into(), viewer: viewer.into(), channel });
        received
    }

    #[test]
    fn frames_reach_the_opening_viewer_and_streams_close_with_it() {
        // Sockets well above the ones real streams use, so tests don't collide.
        let received = register(-101, "pkg-1", "v1");
        register(-102, "pkg-1", "v2");
        register(-103, "pkg-2", "v1");
        event(-101, "open", "");
        event(-101, "binary", "AAEC/w==");
        event(-101, "message", "{\"type\":\"mse\",\"value\":\"video/mp4\"}");
        let bodies = received.lock().unwrap().clone();
        assert!(matches!(&bodies[0], InvokeResponseBody::Json(j) if j.contains("\"open\"")));
        assert!(matches!(&bodies[1], InvokeResponseBody::Raw(b) if b == &[0, 1, 2, 255]), "binary frames go as raw bytes");
        assert!(matches!(&bodies[2], InvokeResponseBody::Json(j) if j.contains("mse")));
        assert!(owned("pkg-1", "v1", -101).is_ok());
        assert!(owned("pkg-1", "v2", -101).is_err(), "another viewer can't use the stream");
        assert!(owned("pkg-2", "v1", -101).is_err(), "nor another feed");
        event(-101, "close", "1000");
        assert!(owned("pkg-1", "v1", -101).is_err(), "a closed stream is forgotten");
        STREAMS.lock().unwrap().retain(|id, _| ![-102, -103].contains(id));
    }

    #[test]
    fn closing_a_viewer_keeps_its_feeds_other_viewers() {
        register(-201, "pkg-7", "a");
        register(-202, "pkg-7", "b");
        register(-203, "pkg-8", "a");
        // These sockets were never opened; closing an unknown socket is a no-op in connector.m.
        close_for("pkg-7", Some("a"));
        assert!(owned("pkg-7", "a", -201).is_err());
        assert!(owned("pkg-7", "b", -202).is_ok() && owned("pkg-8", "a", -203).is_ok());
        close_for("pkg-7", None);
        assert!(owned("pkg-7", "b", -202).is_err(), "closing the feed closes every viewer's streams");
        assert!(owned("pkg-8", "a", -203).is_ok());
        close_for("pkg-8", None);
    }
}
