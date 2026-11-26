//! Data for installed packages: tier 1 (declarative polls and actions) and tier 2
//! (a sandboxed JavaScriptCore connector).
//!
//! The view never talks to the network. The app makes every request: to the
//! placement's connection, with its stored credential added here, and, for a
//! connector, to the hosts its manifest declares. Connector code never sees the
//! credential, cannot reach any other host, and has no file or process access.
use crate::package_manifest::{self, Auth, Manifest, Method, Tier};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    ffi::{c_char, c_void, CStr, CString},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        mpsc, Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

const EMIT_LIMIT: usize = 1024 * 1024;
const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const BODY_LIMIT: usize = 1024 * 1024;
const WATCHDOG_SECONDS: f64 = 2.0;

extern "C" {
    fn connector_new(handle: usize, limit: f64) -> *mut c_void;
    fn connector_eval(context: *mut c_void, source: *const c_char, url: *const c_char) -> *mut c_char;
    fn connector_free(context: *mut c_void);
    fn connector_ws_open(handle: usize, socket: i64, url: *const c_char, name: *const c_char, value: *const c_char);
    fn connector_ws_send(socket: i64, text: *const c_char);
    fn connector_ws_close(socket: i64);
    fn free(pointer: *mut c_void);
}

/// The connection a placement chose: where requests go and how they authenticate.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Connection {
    pub name: String,
    pub address: String,
}

#[derive(Default)]
pub(crate) struct Output {
    rev: u64,
    data: Value,
    error: Option<String>,
}

struct Feed {
    kind: String,
    connection: Option<Connection>,
    view: PathBuf,
    viewers: HashMap<String, String>,
    last_attached: Instant,
    output: Arc<Mutex<Output>>,
    stop: Arc<AtomicBool>,
}
impl Drop for Feed {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}
static FEEDS: LazyLock<Mutex<HashMap<String, Feed>>> = LazyLock::new(Default::default);
static NEXT_FEED: AtomicU64 = AtomicU64::new(1);

// ---------------------------------------------------------------- network ----

/// The origins a request may reach: the connection's, then the manifest's hosts.
pub fn allowed_origins(connection: Option<&Url>, manifest: &Manifest) -> Vec<String> {
    let mut origins: Vec<String> = connection.map(|u| u.origin().ascii_serialization()).into_iter().collect();
    if let Some(connector) = &manifest.connector {
        origins.extend(connector.hosts.iter().cloned());
    }
    origins
}

/// Check a URL a connector asked for. WebSocket URLs are checked as their HTTP origin.
pub fn check_url(raw: &str, origins: &[String]) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| format!("“{raw}” isn’t a full URL."))?;
    let http_scheme = match url.scheme() {
        "https" | "wss" => "https",
        "http" | "ws" => "http",
        _ => return Err(format!("“{raw}” must use http, https, ws or wss.")),
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs can’t carry credentials.".into());
    }
    let mut origin_url = url.clone();
    origin_url.set_scheme(http_scheme).map_err(|_| "Invalid URL")?;
    let origin = origin_url.origin().ascii_serialization();
    if !origins.contains(&origin) {
        return Err(format!("{origin} isn’t a host this widget declared."));
    }
    Ok(url)
}

fn same_origin(url: &Url, connection: Option<&Url>) -> bool {
    let scheme = |u: &Url| match u.scheme() { "wss" => "https".to_string(), "ws" => "http".to_string(), s => s.to_string() };
    connection.is_some_and(|c| {
        scheme(url) == scheme(c) && url.host_str() == c.host_str() && url.port_or_known_default() == c.port_or_known_default()
    })
}

/// The credential header for a request to the connection, never for other hosts.
pub fn credential_header(auth: Auth, key: &str) -> Option<(&'static str, String)> {
    if key.is_empty() {
        return None;
    }
    match auth {
        Auth::Bearer => Some(("Authorization", format!("Bearer {key}"))),
        Auth::EmbyToken => Some(("X-Emby-Token", key.to_string())),
        Auth::PveToken => Some(("Authorization", format!("PVEAPIToken={key}"))),
        Auth::None => None,
    }
}

/// Headers a package may not set itself.
fn forbidden_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(lower.as_str(), "authorization" | "cookie" | "host" | "x-emby-token" | "proxy-authorization" | "content-length")
}

struct Request {
    url: Url,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
}

async fn send(kind: &str, connection: Option<&Url>, auth: Auth, request: Request) -> Result<Value, String> {
    let client = match connection {
        // Only an authenticated connection has vault data (its key and any CA).
        Some(base) if auth != Auth::None && same_origin(&request.url, Some(base)) => crate::connections::service_client(kind, base)?,
        _ => crate::connections::plain_client(),
    };
    let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| "Unsupported method")?;
    let mut builder = client.request(method, request.url.clone()).timeout(Duration::from_secs(15));
    for (name, value) in &request.headers {
        if !forbidden_header(name) {
            builder = builder.header(name.as_str(), value.as_str());
        }
    }
    if let Some(base) = connection.filter(|base| auth != Auth::None && same_origin(&request.url, Some(base))) {
        let key = crate::connections::credential(kind, base)?;
        if let Some((name, value)) = credential_header(auth, &key) {
            builder = builder.header(name, value);
        }
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let mut response = builder.send().await.map_err(|_| "Server unreachable".to_string())?;
    let status = response.status().as_u16();
    let headers: Map<String, Value> = response
        .headers()
        .iter()
        .filter(|(name, _)| !matches!(name.as_str(), "set-cookie" | "www-authenticate"))
        .filter_map(|(name, value)| Some((name.as_str().to_string(), Value::String(value.to_str().ok()?.to_string()))))
        .collect();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Connection interrupted")? {
        if body.len() + chunk.len() > RESPONSE_LIMIT {
            return Err("Response exceeds 8 MiB".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(json!({"status": status, "headers": headers, "body": String::from_utf8_lossy(&body)}))
}

// ------------------------------------------------------- tier 1: declarative --

/// Fill `{name}` placeholders. Values may only use URL-safe characters.
pub fn fill(template: &str, args: &Map<String, Value>) -> Result<String, String> {
    let names = package_manifest::placeholder_names(template).ok_or("Invalid action route")?;
    let mut out = template.to_string();
    for name in names {
        let value = args.get(&name).and_then(Value::as_str).ok_or(format!("Missing “{name}”"))?;
        if value.is_empty() || value.len() > 128 || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)) {
            return Err(format!("“{name}” must be 1–128 letters, digits, . _ : or -."));
        }
        out = out.replace(&format!("{{{name}}}"), value);
    }
    Ok(out)
}

fn fill_body(value: &Value, args: &Map<String, Value>) -> Result<Value, String> {
    Ok(match value {
        // Only a string that is exactly one `{name}` placeholder is filled.
        Value::String(s) if s.starts_with('{') && s.ends_with('}')
            && package_manifest::placeholder_names(s).is_some_and(|n| n.len() == 1)
            && s.matches('{').count() == 1 => Value::String(fill(s, args)?),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| Ok((k.clone(), fill_body(v, args)?))).collect::<Result<_, String>>()?),
        Value::Array(items) => Value::Array(items.iter().map(|v| fill_body(v, args)).collect::<Result<_, _>>()?),
        other => other.clone(),
    })
}

fn route_url(base: &Url, route: &str) -> Url {
    let mut url = base.clone();
    let (path, query) = route.split_once('?').map_or((route, None), |(p, q)| (p, Some(q)));
    url.set_path(&format!("{}/{}", base.path().trim_end_matches('/'), path));
    url.set_query(query);
    url
}

fn run_declarative(kind: String, manifest: Manifest, base: Url, output: Arc<Mutex<Output>>, stop: Arc<AtomicBool>) {
    let auth = manifest.sources.as_ref().map_or(Auth::Bearer, |s| s.auth);
    std::thread::spawn(move || {
        let mut due: HashMap<String, Instant> = HashMap::new();
        while !stop.load(Ordering::SeqCst) {
            for poll in &manifest.data {
                if due.get(&poll.id).is_some_and(|at| Instant::now() < *at) {
                    continue;
                }
                due.insert(poll.id.clone(), Instant::now() + Duration::from_secs(poll.every.into()));
                let request = Request { url: route_url(&base, &poll.path), method: "GET".into(), headers: vec![("Accept".into(), "application/json".into())], body: None };
                let result = tauri::async_runtime::block_on(send(&kind, Some(&base), auth, request)).and_then(|r| {
                    let status = r["status"].as_u64().unwrap_or(0);
                    if !(200..300).contains(&status) {
                        return Err(format!("Server returned HTTP {status}"));
                    }
                    serde_json::from_str::<Value>(r["body"].as_str().unwrap_or("")).map_err(|_| "Expected a JSON response".into())
                });
                let mut out = output.lock().unwrap();
                if !out.data.is_object() {
                    out.data = json!({});
                }
                out.data[&poll.id] = match result {
                    Ok(value) => json!({"value": value, "at": chrono::Utc::now().timestamp_millis()}),
                    Err(error) => json!({"error": error, "at": chrono::Utc::now().timestamp_millis()}),
                };
                out.rev += 1;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

// ------------------------------------------------------- tier 2: connector ----

enum Event {
    Fetch { id: i64, result: Result<Value, String> },
    Socket { id: i64, kind: String, data: String },
}

struct Timer {
    id: i64,
    at: Instant,
    every: Option<Duration>,
}

struct Runtime {
    handle: usize,
    kind: String,
    connection: Option<Url>,
    auth: Auth,
    origins: Vec<String>,
    tx: mpsc::Sender<Event>,
    output: Arc<Mutex<Output>>,
    timers: Mutex<Vec<Timer>>,
    storage: Mutex<Map<String, Value>>,
    storage_file: Option<PathBuf>,
    storage_limit: usize,
    sockets: Mutex<HashMap<i64, i64>>, // global socket → connector's own id
    log: Mutex<Vec<String>>,
}
static RUNTIMES: LazyLock<Mutex<HashMap<usize, Arc<Runtime>>>> = LazyLock::new(Default::default);
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);
static NEXT_SOCKET: AtomicI64 = AtomicI64::new(1);

const PRELUDE: &str = include_str!("connector_prelude.js");

fn runtime(handle: usize) -> Option<Arc<Runtime>> {
    RUNTIMES.lock().unwrap().get(&handle).cloned()
}

fn host_op(rt: &Runtime, op: &str, args: Value) -> Result<Value, String> {
    match op {
        "fetch" => {
            let id = args["id"].as_i64().ok_or("Missing request ID")?;
            let url = check_url(args["url"].as_str().unwrap_or(""), &rt.origins)?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err("Use WebSocket for ws URLs.".into());
            }
            let method = args["method"].as_str().unwrap_or("GET").to_ascii_uppercase();
            if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD") {
                return Err(format!("{method} isn’t allowed."));
            }
            let body = args["body"].as_str().map(str::to_string);
            if body.as_ref().is_some_and(|b| b.len() > BODY_LIMIT) {
                return Err("Request bodies are limited to 1 MiB.".into());
            }
            let headers = args["headers"].as_object().map(|h| {
                h.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).take(32).collect()
            }).unwrap_or_default();
            let (kind, connection, auth, tx) = (rt.kind.clone(), rt.connection.clone(), rt.auth, rt.tx.clone());
            tauri::async_runtime::spawn(async move {
                let result = send(&kind, connection.as_ref(), auth, Request { url, method, headers, body }).await;
                let _ = tx.send(Event::Fetch { id, result });
            });
            Ok(Value::Null)
        }
        "timer" => {
            let id = args["id"].as_i64().ok_or("Missing timer ID")?;
            let ms = args["ms"].as_u64().unwrap_or(0).clamp(0, 24 * 3600 * 1000);
            let every = args["repeat"].as_bool().unwrap_or(false).then(|| Duration::from_millis(ms.max(10)));
            let mut timers = rt.timers.lock().unwrap();
            if timers.len() >= 256 {
                return Err("Too many timers".into());
            }
            timers.push(Timer { id, at: Instant::now() + Duration::from_millis(ms), every });
            Ok(Value::Null)
        }
        "clearTimer" => {
            let id = args["id"].as_i64().unwrap_or(-1);
            rt.timers.lock().unwrap().retain(|t| t.id != id);
            Ok(Value::Null)
        }
        "emit" => {
            let data = args.get("data").cloned().unwrap_or(Value::Null);
            if data.to_string().len() > EMIT_LIMIT {
                return Err("emit() data is limited to 1 MiB.".into());
            }
            let mut out = rt.output.lock().unwrap();
            out.data = data;
            out.error = None;
            out.rev += 1;
            Ok(Value::Null)
        }
        "storageGet" => Ok(rt.storage.lock().unwrap().get(args["key"].as_str().unwrap_or("")).cloned().unwrap_or(Value::Null)),
        "storageSet" => {
            let key = args["key"].as_str().ok_or("Missing key")?.to_string();
            if key.is_empty() || key.len() > 128 {
                return Err("Storage keys are 1–128 characters.".into());
            }
            let mut storage = rt.storage.lock().unwrap();
            let mut next = storage.clone();
            match args.get("value") {
                None | Some(Value::Null) => { next.remove(&key); }
                Some(value) => { next.insert(key, value.clone()); }
            }
            let encoded = Value::Object(next.clone()).to_string();
            if encoded.len() > rt.storage_limit {
                return Err(format!("Storage is limited to {} bytes.", rt.storage_limit));
            }
            if let Some(file) = &rt.storage_file {
                if let Some(dir) = file.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                std::fs::write(file, &encoded).map_err(|e| e.to_string())?;
            }
            *storage = next;
            Ok(Value::Null)
        }
        "log" => {
            let mut log = rt.log.lock().unwrap();
            log.push(args["message"].as_str().unwrap_or("").chars().take(500).collect());
            if log.len() > 50 {
                log.remove(0);
            }
            Ok(Value::Null)
        }
        "wsOpen" => {
            let local = args["id"].as_i64().ok_or("Missing socket ID")?;
            let url = check_url(args["url"].as_str().unwrap_or(""), &rt.origins)?;
            if !matches!(url.scheme(), "ws" | "wss") {
                return Err("WebSocket URLs use ws or wss.".into());
            }
            let mut sockets = rt.sockets.lock().unwrap();
            if sockets.len() >= 8 {
                return Err("A connector may keep at most 8 sockets open.".into());
            }
            let global = NEXT_SOCKET.fetch_add(1, Ordering::SeqCst);
            sockets.insert(global, local);
            let (name, value) = match rt.connection.as_ref().filter(|c| same_origin(&url, Some(c))) {
                Some(base) => credential_header(rt.auth, &crate::connections::credential(&rt.kind, base)?)
                    .map_or((String::new(), String::new()), |(n, v)| (n.to_string(), v)),
                None => (String::new(), String::new()),
            };
            let (url, name, value) = (CString::new(url.as_str()).unwrap(), CString::new(name).unwrap(), CString::new(value).unwrap_or_default());
            unsafe { connector_ws_open(rt.handle, global, url.as_ptr(), name.as_ptr(), value.as_ptr()) };
            Ok(Value::Null)
        }
        "wsSend" | "wsClose" => {
            let local = args["id"].as_i64().unwrap_or(-1);
            let global = rt.sockets.lock().unwrap().iter().find(|(_, l)| **l == local).map(|(g, _)| *g);
            let Some(global) = global else { return Ok(Value::Null) };
            if op == "wsSend" {
                let text = args["text"].as_str().unwrap_or("");
                if text.len() > 4 * 1024 * 1024 {
                    return Err("Messages are limited to 4 MiB.".into());
                }
                let text = CString::new(text).map_err(|_| "Invalid message")?;
                unsafe { connector_ws_send(global, text.as_ptr()) };
            } else {
                rt.sockets.lock().unwrap().remove(&global);
                unsafe { connector_ws_close(global) };
            }
            Ok(Value::Null)
        }
        _ => Err(format!("Unknown connector operation {op}")),
    }
}

#[no_mangle]
pub extern "C" fn dashledge_connector_host(handle: usize, op: *const c_char, json: *const c_char) -> *mut c_char {
    let op = unsafe { CStr::from_ptr(op) }.to_string_lossy().into_owned();
    let args: Value = serde_json::from_slice(unsafe { CStr::from_ptr(json) }.to_bytes()).unwrap_or(Value::Null);
    let reply = match runtime(handle) {
        Some(rt) => match host_op(&rt, &op, args) {
            Ok(value) => json!({"ok": value}),
            Err(error) => json!({"error": error}),
        },
        None => json!({"error": "Connector stopped"}),
    };
    CString::new(reply.to_string()).unwrap_or_default().into_raw()
}

#[no_mangle]
pub extern "C" fn dashledge_connector_free(value: *mut c_char) {
    if !value.is_null() {
        drop(unsafe { CString::from_raw(value) });
    }
}

#[no_mangle]
pub extern "C" fn dashledge_connector_ws_event(handle: usize, socket: i64, kind: *const c_char, data: *const c_char) {
    let Some(rt) = runtime(handle) else { return };
    let Some(local) = rt.sockets.lock().unwrap().get(&socket).copied() else { return };
    let kind = unsafe { CStr::from_ptr(kind) }.to_string_lossy().into_owned();
    let data = unsafe { CStr::from_ptr(data) }.to_string_lossy().into_owned();
    if kind == "close" {
        rt.sockets.lock().unwrap().remove(&socket);
    }
    let _ = rt.tx.send(Event::Socket { id: local, kind, data });
}

struct Context(*mut c_void);
impl Context {
    fn eval(&self, source: &str, url: &str) -> Result<(), String> {
        let source = CString::new(source).map_err(|_| "Connector source contains a NUL byte")?;
        let url = CString::new(url).unwrap();
        let error = unsafe { connector_eval(self.0, source.as_ptr(), url.as_ptr()) };
        if error.is_null() {
            return Ok(());
        }
        let message = unsafe { CStr::from_ptr(error) }.to_string_lossy().into_owned();
        unsafe { free(error.cast()) };
        Err(message)
    }
    fn dispatch(&self, event: Value) -> Result<(), String> {
        self.eval(&format!("__dashledge_dispatch({event})"), "dashledge://dispatch")
    }
}
impl Drop for Context {
    fn drop(&mut self) {
        unsafe { connector_free(self.0) };
    }
}

pub(crate) struct ConnectorSetup {
    pub kind: String,
    pub package: String,
    pub source: String,
    pub connection: Option<(Url, String)>,
    pub manifest: Manifest,
    pub storage_file: Option<PathBuf>,
}

/// Run a connector on its own thread until `stop` is set.
pub(crate) fn run_connector(setup: ConnectorSetup, output: Arc<Mutex<Output>>, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel();
        let storage = setup.storage_file.as_ref()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice::<Map<String, Value>>(&b).ok())
            .unwrap_or_default();
        let connection_url = setup.connection.as_ref().map(|(u, _)| u.clone());
        let handle = NEXT_HANDLE.fetch_add(1, Ordering::SeqCst) as usize;
        let rt = Arc::new(Runtime {
            handle,
            kind: setup.kind.clone(),
            origins: allowed_origins(connection_url.as_ref(), &setup.manifest),
            auth: setup.manifest.sources.as_ref().map_or(Auth::None, |s| s.auth),
            connection: connection_url,
            tx,
            output: output.clone(),
            timers: Mutex::new(Vec::new()),
            storage: Mutex::new(storage),
            storage_file: setup.storage_file.clone(),
            storage_limit: setup.manifest.connector.as_ref().map_or(64 * 1024, |c| c.storage as usize),
            sockets: Mutex::new(HashMap::new()),
            log: Mutex::new(Vec::new()),
        });
        RUNTIMES.lock().unwrap().insert(handle, rt.clone());
        let context = Context(unsafe { connector_new(handle, WATCHDOG_SECONDS) });
        let connection = setup.connection.as_ref().map(|(u, name)| json!({"address": u.as_str(), "name": name}));
        let fail = |error: String| {
            let mut out = output.lock().unwrap();
            out.error = Some(error);
            out.rev += 1;
        };
        let start = context.eval(PRELUDE, "dashledge://prelude")
            .and_then(|_| context.eval(&format!("__dashledge_start({})", json!({"connection": connection})), "dashledge://start"))
            .and_then(|_| context.eval(&setup.source, &format!("package://{}/connector.js", setup.package)));
        if let Err(error) = start {
            fail(error);
        }
        while !stop.load(Ordering::SeqCst) {
            let next = rt.timers.lock().unwrap().iter().map(|t| t.at).min();
            let wait = next.map_or(Duration::from_millis(250), |at| at.saturating_duration_since(Instant::now()).min(Duration::from_millis(250)));
            let result = match rx.recv_timeout(wait) {
                Ok(Event::Fetch { id, result }) => context.dispatch(match result {
                    Ok(response) => json!({"type": "fetch", "id": id, "response": response}),
                    Err(error) => json!({"type": "fetch", "id": id, "error": error}),
                }),
                Ok(Event::Socket { id, kind, data }) => context.dispatch(json!({"type": "socket", "id": id, "event": kind, "data": data})),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let now = Instant::now();
                    let fired: Vec<i64> = {
                        let mut timers = rt.timers.lock().unwrap();
                        let ids = timers.iter().filter(|t| t.at <= now).map(|t| t.id).collect::<Vec<_>>();
                        timers.retain_mut(|t| {
                            if t.at > now { return true; }
                            match t.every { Some(every) => { t.at = now + every; true } None => false }
                        });
                        ids
                    };
                    fired.into_iter().try_for_each(|id| context.dispatch(json!({"type": "timer", "id": id})))
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            if let Err(error) = result {
                fail(error);
            }
        }
        for (global, _) in rt.sockets.lock().unwrap().drain() {
            unsafe { connector_ws_close(global) };
        }
        RUNTIMES.lock().unwrap().remove(&handle);
        drop(context);
    });
}

// ---------------------------------------------------------------- commands ----

fn installed_package(kind: &str) -> Result<(Manifest, PathBuf), String> {
    let (info, dir) = crate::package_store::lookup(kind).ok_or("This widget package isn’t installed.")?;
    if info.manifest.collector.is_some() {
        return Err("Bundled widgets use their own collector.".into());
    }
    Ok((info.manifest, dir))
}

pub fn reap_idle(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(15));
        let windows = app.webview_windows();
        FEEDS.lock().unwrap().retain(|_, feed| {
            feed.viewers.retain(|_, label| windows.contains_key(label));
            if !feed.viewers.is_empty() {
                feed.last_attached = Instant::now();
            }
            feed.last_attached.elapsed() < Duration::from_secs(90)
        });
    });
}

pub fn shutdown() {
    FEEDS.lock().unwrap().clear();
}

/// The view folder of a running package feed, for the widget host to serve.
pub fn view_root(id: &str) -> Option<PathBuf> {
    FEEDS.lock().unwrap().get(id).map(|f| f.view.clone())
}

#[tauri::command]
pub fn package_open(window: tauri::WebviewWindow, app: tauri::AppHandle, kind: String, connection: Option<Connection>, viewer: String) -> Result<Value, String> {
    if viewer.is_empty() || viewer.len() > 80 {
        return Err("Invalid viewer".into());
    }
    let (manifest, dir) = installed_package(&kind)?;
    let entry = std::path::Path::new(&manifest.view.entry).file_name().and_then(|n| n.to_str()).unwrap_or("index.html").to_string();
    let needs = manifest.sources.as_ref().is_some_and(|s| s.min > 0);
    if needs && connection.is_none() {
        return Err("Choose a connection for this widget in Widget Studio.".into());
    }
    let mut feeds = FEEDS.lock().unwrap();
    if let Some((id, feed)) = feeds.iter_mut().find(|(_, f)| f.kind == kind && f.connection == connection) {
        feed.viewers.insert(viewer, window.label().into());
        feed.last_attached = Instant::now();
        return Ok(json!({"id": id, "entry": entry}));
    }
    let base = connection.as_ref().map(|c| crate::connections::endpoint(&c.address)).transpose()?;
    let output = Arc::new(Mutex::new(Output::default()));
    let stop = Arc::new(AtomicBool::new(false));
    match manifest.tier() {
        Tier::Connector => {
            let entry = &manifest.connector.as_ref().unwrap().entry;
            let source = std::fs::read_to_string(dir.join(entry)).map_err(|_| "The connector script is missing.")?;
            let storage_file = app.path().app_data_dir().ok().map(|d| d.join("package-data").join(format!("{kind}.json")));
            run_connector(ConnectorSetup {
                kind: kind.clone(), package: kind.clone(), source,
                connection: base.clone().zip(connection.as_ref().map(|c| c.name.clone())),
                manifest: manifest.clone(), storage_file,
            }, output.clone(), stop.clone());
        }
        Tier::Declarative => run_declarative(kind.clone(), manifest.clone(), base.clone().ok_or("Choose a connection")?, output.clone(), stop.clone()),
        Tier::View | Tier::Collector => {}
    }
    let view = dir.join(std::path::Path::new(&manifest.view.entry).parent().unwrap_or(std::path::Path::new("")));
    let id = format!("pkg-{}", NEXT_FEED.fetch_add(1, Ordering::SeqCst));
    let mut viewers = HashMap::new();
    viewers.insert(viewer, window.label().to_string());
    feeds.insert(id.clone(), Feed { kind, connection, view, viewers, last_attached: Instant::now(), output, stop });
    Ok(json!({"id": id, "entry": entry}))
}

#[tauri::command]
pub fn package_read(id: String, viewer: String, since: u64) -> Result<Value, String> {
    let feeds = FEEDS.lock().unwrap();
    let feed = feeds.get(&id).filter(|f| f.viewers.contains_key(&viewer)).ok_or("Widget disconnected")?;
    let out = feed.output.lock().unwrap();
    if out.rev == since {
        return Ok(Value::Null);
    }
    Ok(json!({"rev": out.rev, "data": out.data, "error": out.error}))
}

#[tauri::command]
pub fn package_ping(id: String, viewer: String) -> bool {
    FEEDS.lock().unwrap().get(&id).is_some_and(|f| f.viewers.contains_key(&viewer))
}

#[tauri::command]
pub fn package_close(id: String, viewer: String) {
    if let Some(feed) = FEEDS.lock().unwrap().get_mut(&id) {
        feed.viewers.remove(&viewer);
        feed.last_attached = Instant::now();
    }
}

/// Run a manifest-declared action against the placement's connection.
#[tauri::command]
pub async fn package_action(id: String, viewer: String, action: String, args: Map<String, Value>) -> Result<Value, String> {
    let (kind, connection) = {
        let feeds = FEEDS.lock().unwrap();
        let feed = feeds.get(&id).filter(|f| f.viewers.contains_key(&viewer)).ok_or("Widget disconnected")?;
        (feed.kind.clone(), feed.connection.clone())
    };
    let (manifest, _) = installed_package(&kind)?;
    let declared = manifest.actions.iter().find(|a| a.id == action).ok_or("This widget didn’t declare that action.")?;
    let base = crate::connections::endpoint(&connection.ok_or("Choose a connection")?.address)?;
    let path = fill(&declared.path, &args)?;
    let body = declared.body.as_ref().map(|b| fill_body(b, &args)).transpose()?.map(|b| b.to_string());
    let method = match declared.method { Method::Post => "POST", Method::Put => "PUT", Method::Delete => "DELETE" };
    let mut headers = vec![("Accept".to_string(), "application/json".to_string())];
    if body.is_some() {
        headers.push(("Content-Type".into(), "application/json".into()));
    }
    let auth = manifest.sources.as_ref().map_or(Auth::Bearer, |s| s.auth);
    let response = send(&kind, Some(&base), auth, Request { url: route_url(&base, &path), method: method.into(), headers, body }).await?;
    let status = response["status"].as_u64().unwrap_or(0);
    if !(200..300).contains(&status) {
        return Err(format!("Server returned HTTP {status}"));
    }
    Ok(json!({"status": status}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn manifest(hosts: &[&str]) -> Manifest {
        let raw = json!({"apiVersion": 2, "id": "plugin.test", "title": "Test", "icon": "i.png", "view": {"entry": "index.html"},
            "sources": {"min": 0, "max": 1, "auth": "none"},
            "connector": {"entry": "connector.js", "hosts": hosts}});
        package_manifest::validate(&raw, package_manifest::Origin::Installed).unwrap()
    }

    #[test]
    fn requests_reach_only_the_connection_and_declared_hosts() {
        let connection = Url::parse("http://10.0.0.5:8123/api/").unwrap();
        let origins = allowed_origins(Some(&connection), &manifest(&["https://api.example.com"]));
        assert!(check_url("http://10.0.0.5:8123/api/states", &origins).is_ok());
        assert!(check_url("ws://10.0.0.5:8123/api/websocket", &origins).is_ok());
        assert!(check_url("https://api.example.com/v1/x?y=1", &origins).is_ok());
        for denied in ["http://10.0.0.5:9999/", "https://10.0.0.5:8123/", "https://evil.example.com/", "http://api.example.com/",
            "file:///etc/passwd", "https://user:pw@api.example.com/", "javascript:alert(1)"] {
            assert!(check_url(denied, &origins).is_err(), "{denied}");
        }
    }

    #[test]
    fn credentials_go_only_to_the_connection_and_packages_cannot_set_them() {
        let connection = Url::parse("https://ha.local:8123/").unwrap();
        assert!(same_origin(&Url::parse("https://ha.local:8123/api").unwrap(), Some(&connection)));
        assert!(same_origin(&Url::parse("wss://ha.local:8123/ws").unwrap(), Some(&connection)));
        assert!(!same_origin(&Url::parse("https://api.example.com/").unwrap(), Some(&connection)));
        assert_eq!(credential_header(Auth::Bearer, "k").unwrap(), ("Authorization", "Bearer k".to_string()));
        assert_eq!(credential_header(Auth::EmbyToken, "k").unwrap().0, "X-Emby-Token");
        assert!(credential_header(Auth::Bearer, "").is_none() && credential_header(Auth::None, "k").is_none());
        for header in ["Authorization", "cookie", "X-Emby-Token", "Host"] {
            assert!(forbidden_header(header));
        }
        assert!(!forbidden_header("Accept"));
    }

    #[test]
    fn action_placeholders_take_only_safe_values() {
        let args = json!({"entity": "light.desk", "state": "on"}).as_object().unwrap().clone();
        assert_eq!(fill("api/{entity}/{state}", &args).unwrap(), "api/light.desk/on");
        let bad = json!({"entity": "../admin"}).as_object().unwrap().clone();
        assert!(fill("api/{entity}", &bad).is_err());
        assert!(fill("api/{missing}", &args).is_err());
        let body = fill_body(&json!({"entity_id": "{entity}", "n": 1, "note": "{not a placeholder"}), &args).unwrap();
        assert_eq!(body, json!({"entity_id": "light.desk", "n": 1, "note": "{not a placeholder"}));
    }

    /// One HTTP response from a local server, for end-to-end connector tests.
    fn serve_once(body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let n = stream.read(&mut request).unwrap();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            String::from_utf8_lossy(&request[..n]).into_owned()
        });
        (address, handle)
    }

    fn wait_for(output: &Arc<Mutex<Output>>, pred: impl Fn(&Output) -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(8) {
            if pred(&output.lock().unwrap()) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn start(source: &str, connection: Option<Url>, hosts: &[&str]) -> (Arc<Mutex<Output>>, Arc<AtomicBool>) {
        let output = Arc::new(Mutex::new(Output::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let setup = ConnectorSetup {
            kind: "plugin.test".into(), package: "plugin.test".into(), source: source.into(),
            connection: connection.map(|u| (u, "Test".to_string())), manifest: manifest(hosts), storage_file: None,
        };
        run_connector(setup, output.clone(), stop.clone());
        (output, stop)
    }

    #[test]
    fn a_connector_fetches_its_connection_keeps_state_and_emits_to_the_view() {
        let (address, server) = serve_once("{\"temperature\": 21.5}");
        let source = r#"
            let readings = [];
            async function poll() {
              const response = await fetch(dashledge.connection.address + 'sensor');
              const body = await response.json();
              readings.push(body.temperature);
              let denied = 'allowed';
              try { await fetch('https://evil.example.com/'); } catch (e) { denied = String(e.message); }
              setTimeout(() => dashledge.emit({readings, denied, globals: [typeof require, typeof process, typeof XMLHttpRequest]}), 10);
            }
            poll();
        "#;
        let (output, stop) = start(source, Some(Url::parse(&format!("{address}/")).unwrap()), &[]);
        assert!(wait_for(&output, |o| o.data.get("readings").is_some()), "error: {:?}", output.lock().unwrap().error);
        let data = output.lock().unwrap().data.clone();
        assert_eq!(data["readings"], json!([21.5]));
        assert!(data["denied"].as_str().unwrap().contains("isn’t a host this widget declared"));
        assert_eq!(data["globals"], json!(["undefined", "undefined", "undefined"]));
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /sensor "));
        stop.store(true, Ordering::SeqCst);
    }

    #[test]
    fn the_example_connector_runs_and_reports_a_refused_host_to_its_view() {
        // Without its declared host the example can't reach Open-Meteo; it must say so.
        let (output, stop) = start(include_str!("../../widgets/example/connector.js"), None, &[]);
        assert!(wait_for(&output, |o| o.data.get("status").is_some() || o.error.is_some()), "{:?}", output.lock().unwrap().error);
        let data = output.lock().unwrap().data.clone();
        assert_eq!(data["status"], "error");
        assert!(data["error"].as_str().unwrap().contains("isn’t a host this widget declared"));
        stop.store(true, Ordering::SeqCst);
    }

    #[test]
    fn the_watchdog_stops_a_runaway_connector_and_reports_it() {
        let (output, stop) = start("while (true) {}", None, &[]);
        assert!(wait_for(&output, |o| o.error.is_some()));
        assert!(output.lock().unwrap().error.as_deref().unwrap().contains("terminated"));
        stop.store(true, Ordering::SeqCst);
    }
}
