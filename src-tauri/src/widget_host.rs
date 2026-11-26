//! Run the original dashboard feeds while a dashboard or live preview is subscribed.
//! Each virtual directory serves a signed view plus only that feed's display assets.
use crate::connections::{endpoint, widget_credentials};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    http::{Request, Response},
    Manager,
};
use tempfile::TempDir;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    name: String,
    address: String,
    #[serde(default)]
    gpu_guests: Value,
}

struct Feed {
    kind: String,
    sources: Vec<Source>,
    assets: PathBuf,
    directory: TempDir,
    child: Child,
    viewers: HashMap<String, String>,
    last_attached: Instant,
}
impl Drop for Feed {
    fn drop(&mut self) {
        // Kill before removing the snapshots. The pipe also closes on abnormal app exit.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
static FEEDS: LazyLock<Mutex<HashMap<String, Feed>>> = LazyLock::new(Default::default);

pub fn reap_idle(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(15));
        let windows=app.webview_windows();
        FEEDS.lock().unwrap().retain(|_, feed| {
            feed.viewers.retain(|_,label| windows.contains_key(label));
            if !feed.viewers.is_empty(){feed.last_attached=Instant::now();}
            feed.last_attached.elapsed()<Duration::from_secs(90) && feed.child.try_wait().is_ok_and(|exit| exit.is_none())
        });
    });
}
pub fn invalidate(kind: &str, base: &reqwest::Url) {
    crate::connections::invalidate_reading(kind,base);
    FEEDS.lock().unwrap().retain(|_, feed| {
        feed.kind != kind
            || !feed
                .sources
                .iter()
                .any(|s| endpoint(&s.address).as_ref() == Ok(base))
    });
}
pub fn restart_markets() {
    FEEDS.lock().unwrap().retain(|_, feed| feed.kind != "markets");
}
pub fn shutdown() {
    FEEDS.lock().unwrap().clear();
}
fn assets(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let root = app.path().resource_dir().map_err(|e| e.to_string())?;
    let node = root.join("runtime/node");
    if node.is_file() {
        return Ok((root.join("widgets"), node));
    }
    #[cfg(debug_assertions)]
    {
        let project = Path::new(env!("CARGO_MANIFEST_DIR"));
        let node = project.join("runtime/node");
        return Ok((
            project.join("../widgets"),
            if node.is_file() { node } else { "node".into() },
        ));
    }
    #[cfg(not(debug_assertions))]
    Err("The app is missing its widget runtime.".into())
}

fn launch(kind: &str, sources: &[Source], assets: &Path, node: &Path) -> Result<Feed, String> {
    let entry = match kind {
        "comfy" | "emby" | "unraid" => "capture.mjs",
        "omlx" | "proxmox" | "markets" => "collect.mjs",
        "ember" => "collector.mjs",
        _ => return Err("Unknown widget".into()),
    };
    let mut settings = Vec::new();
    if kind == "markets" { settings.push(crate::markets::credentials()?); }
    for source in sources {
        let base = endpoint(&source.address)?;
        let (key, ca) = widget_credentials(kind, &base)?;
        settings.push(json!({"address":base.as_str(),"name":source.name,"key":key,"ca":ca,"gpuGuests":source.gpu_guests}));
    }
    let directory = tempfile::Builder::new()
        .permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700))
        .prefix("edge-widget-")
        // Keep OpenSSH control socket paths below macOS's sockaddr_un limit.
        .tempdir_in("/tmp")
        .map_err(|e| e.to_string())?;
    let mut child = Command::new(node)
        .arg("--disable-warning=ExperimentalWarning")
        .arg(assets.join("collectors").join(kind).join(entry))
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("NODE_TLS_REJECT_UNAUTHORIZED")
        .current_dir(directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start the widget collector: {e}"))?;
    let setup = json!({"directory":directory.path(),"sources":settings});
    if let Err(e) = writeln!(child.stdin.as_mut().unwrap(), "{setup}") {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("Could not initialize the widget collector: {e}"));
    }
    Ok(Feed {
        kind: kind.into(),
        sources: sources.to_vec(),
        assets: assets.join("views").join(kind),
        directory,
        child,
        viewers: HashMap::new(),
        last_attached: Instant::now(),
    })
}
fn attach_existing(kind: &str, sources: &[Source], viewer: &str, label: &str) -> Option<String> {
    let mut feeds = FEEDS.lock().unwrap();
    for (id, feed) in feeds.iter_mut() {
        if feed.kind == kind && feed.sources == sources && feed.child.try_wait().ok() == Some(None)
        {
            feed.viewers.insert(viewer.to_string(),label.into());
            feed.last_attached=Instant::now();
            return Some(id.clone());
        }
    }
    None
}
#[tauri::command]
pub async fn widget_open(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    kind: String,
    sources: Vec<Source>,
    viewer: String,
) -> Result<String, String> {
    let count = match kind.as_str() {
        "ember" | "markets" => 0..=0,
        "comfy" => 1..=2,
        "omlx" => 1..=20,
        "emby" | "unraid" | "proxmox" => 1..=1,
        _ => return Err("Unknown widget".into()),
    };
    if !count.contains(&sources.len()) || viewer.len() > 80 {
        return Err("Check the widget connections in Settings.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Serialize starts without holding the resource-serving lock during Keychain access.
        static START: Mutex<()> = Mutex::new(());
        let _start = START.lock().unwrap();
        if let Some(id) = attach_existing(&kind, &sources, &viewer, window.label()) {
            return Ok(id);
        }
        let (assets, node) = assets(&app)?;
        let mut feed = launch(&kind, &sources, &assets, &node)?;
        feed.viewers.insert(viewer,window.label().into());
        let id = feed
            .directory
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        FEEDS.lock().unwrap().insert(id.clone(), feed);
        Ok(id)
    })
    .await
    .map_err(|_| "Widget startup interrupted".to_string())?
}
#[tauri::command]
pub fn widget_ping(id: String, viewer: String) -> bool {
    let mut feeds = FEEDS.lock().unwrap();
    if let Some(feed) = feeds.get_mut(&id) {
        if feed.viewers.contains_key(&viewer) {
            return feed.child.try_wait().ok() == Some(None);
        }
    }
    false
}
#[tauri::command]
pub fn widget_close(id: String, viewer: String) {
    let mut feeds = FEEDS.lock().unwrap();
    if let Some(feed) = feeds.get_mut(&id) {
        feed.viewers.remove(&viewer);
        feed.last_attached=Instant::now();
    }
}
#[tauri::command]
pub fn widget_model_action(id: String, viewer: String, command: Value) -> Result<(), String> {
    let mut feeds = FEEDS.lock().unwrap();
    let feed = feeds
        .get_mut(&id)
        .filter(|f| f.kind == "omlx" && f.viewers.contains_key(&viewer))
        .ok_or("Model controls disconnected")?;
    let message = json!({"instance":format!("omlx-dashboard@{viewer}"),"command":command});
    writeln!(
        feed.child.stdin.as_mut().ok_or("Collector disconnected")?,
        "{message}"
    )
    .map_err(|_| "Collector disconnected".into())
}
fn resource(id: &str, path: &str) -> Option<(Vec<u8>, &'static str)> {
    // Every allowed filename is a simple component. A feed cannot request another
    // connection's files, its action mailbox, collector code, or arbitrary host files.
    let parts = path.split('/').collect::<Vec<_>>();
    if !parts.iter().all(|p| {
        !p.is_empty()
            && !p.starts_with('.')
            && p.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    }) {
        return None;
    }
    let feeds = FEEDS.lock().unwrap();
    let feed = feeds.get(id)?;
    let root = match parts.as_slice() {
        ["market.json"] if feed.kind == "markets" => feed.directory.path(),
        ["snapshot.js"] | ["revision.js"] => feed.directory.path(),
        ["art" | "previews", file] if file.ends_with(".jpg") => feed.directory.path(),
        ["container-icons", file] if file.ends_with("-icon.png") => feed.directory.path(),
        ["icons", _] | [_] => &feed.assets,
        _ => return None,
    };
    let mime = match Path::new(path).extension()?.to_str()? {
        "json" => "application/json",
        "html" => "text/html; charset=utf-8",
        "css" => "text/css",
        "js" => "text/javascript",
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ttf" => "font/ttf",
        _ => return None,
    };
    let file = root.join(path);
    drop(feeds);
    let data = if path == "index.html" {
        let html = fs::read_to_string(file).ok()?;
        html.replacen(
            "<head>",
            "<head><link rel=\"stylesheet\" href=\"/scrollbars.css\"><script src=\"/widget-bridge.js\"></script>",
            1,
        )
        .into_bytes()
    } else {
        fs::read(file).ok()?
    };
    Some((data, mime))
}
pub fn serve(req: Request<Vec<u8>>, res: &mut Response<Cow<'static, [u8]>>) {
    if let Some(kind) = req.uri().path().strip_prefix("/widget-icon/") {
        let (bytes, mime): (&[u8], _) = match kind {
            "ember" => (include_bytes!("../../widgets/views/ember/ember-mark.png"), "image/png"),
            "proxmox" => (include_bytes!("../../widgets/views/proxmox/icon.svg"), "image/svg+xml"),
            "emby" => (include_bytes!("../../widgets/views/emby/icon.svg"), "image/svg+xml"),
            "omlx" => (include_bytes!("../../widgets/views/omlx/omlx-icon.svg"), "image/svg+xml"),
            "unraid" => (include_bytes!("../../widgets/views/unraid/unraid.svg"), "image/svg+xml"),
            "comfy" => (include_bytes!("../../widgets/views/comfy/comfy-icon.svg"), "image/svg+xml"),
            _ => return,
        };
        *res = Response::builder().header("Content-Type", mime).body(Cow::Borrowed(bytes)).unwrap();
        return;
    }
    let Some(route) = req.uri().path().strip_prefix("/widget-view/") else {
        return;
    };
    let asset = route
        .split_once('/')
        .and_then(|(id, path)| resource(id, path));
    let builder = Response::builder().header("Cache-Control","no-store")
        .header("X-Content-Type-Options","nosniff")
        .header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'");
    *res = if let Some((data, mime)) = asset {
        builder
            .header("Content-Type", mime)
            .body(Cow::Owned(data))
            .unwrap()
    } else {
        builder.status(404).body(Cow::Borrowed(&[][..])).unwrap()
    };
}
