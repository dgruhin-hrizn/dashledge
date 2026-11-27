//! Data for installed packages: tier 1 (declarative polls and actions) and tier 2
//! (a sandboxed JavaScriptCore connector).
//!
//! The view never talks to the network. The app makes every request: to the
//! placement's connection, with its stored credential added here, and, for a
//! connector, to the hosts its manifest declares. Connector code never sees the
//! credential, cannot reach any other host, and has no file or process access.
use crate::package_manifest::{self, Auth, Manifest, Method, Tier};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, VecDeque},
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
    fn connector_ws_open(handle: usize, socket: i64, url: *const c_char, name: *const c_char, value: *const c_char, ca: *const c_char);
    fn connector_ws_send(socket: i64, text: *const c_char);
    fn connector_ws_send_binary(socket: i64, data: *const u8, length: usize);
    fn connector_ws_close(socket: i64);
    fn free(pointer: *mut c_void);
}

/// The connection a placement chose: where requests go and how they authenticate.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Connection {
    pub name: String,
    pub address: String,
    /// The manifest's connection type this connection was made for, if it has types.
    #[serde(default, rename = "type")]
    pub source_type: Option<String>,
}

/// Where a placement's requests start and which saved credential they use. `base` is
/// the address resolved with the manifest's address mode (the same base Test reads);
/// `account` is the address as typed, which keys the vault. Both share one origin.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Target {
    pub base: Url,
    pub account: Url,
}

impl Target {
    pub fn new(kind: &str, address: &str) -> Result<Self, String> {
        Ok(Target { base: crate::connections::resolve(kind, address)?, account: crate::connections::endpoint(address)? })
    }
}

/// One of a connector's connections: where it is, its name and type, and its auth.
#[derive(Clone, Debug)]
pub(crate) struct Link {
    pub target: Target,
    pub name: String,
    pub source_type: Option<String>,
    pub auth: Auth,
}

impl Link {
    fn json(&self) -> Value {
        json!({"address": self.target.base.as_str(), "name": self.name, "type": self.source_type})
    }
}

/// The connection a request is for: the one `index` names, else the connection whose
/// address the URL falls under (the longest base path wins, so two services behind one
/// reverse proxy keep their own keys), else none.
pub(crate) fn link_for<'a>(links: &'a [Link], url: &Url, index: Option<usize>) -> Result<Option<&'a Link>, String> {
    if let Some(index) = index {
        return links.get(index).map(Some).ok_or_else(|| format!("This widget has no connection {index}."));
    }
    Ok(links.iter()
        .filter(|l| same_origin(url, Some(&l.target.base)))
        .max_by_key(|l| if url.path().starts_with(l.target.base.path()) { l.target.base.path().len() } else { 0 }))
}

#[derive(Default)]
pub(crate) struct Output {
    rev: u64,
    data: Value,
    error: Option<String>,
}

struct Feed {
    kind: String,
    /// The connector runtime's handle, for a connector-tier package.
    connector: Option<usize>,
    /// The placement's connections, the one it chose first.
    connections: Vec<Connection>,
    view: PathBuf,
    /// The manifest declares `ui`: views get `/package-ui.css`.
    ui: bool,
    /// The package's revision when this feed opened. An unpacked package that has
    /// changed since then reloads.
    revision: u64,
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

/// The origins a request may reach: the connections', then the manifest's hosts.
pub fn allowed_origins(connections: &[&Url], manifest: &Manifest) -> Vec<String> {
    let mut origins: Vec<String> = connections.iter().map(|u| u.origin().ascii_serialization()).collect();
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

/// A connection's saved credential, placed on a request to that connection only.
#[derive(Clone, Debug, PartialEq)]
pub enum Credential {
    Header(String, String),
    /// A query parameter Rust sets on the URL, replacing any the package wrote.
    Query(String, String),
}

/// The saved username and key, as the manifest's auth sends them.
#[derive(Clone, Default)]
pub struct Secret {
    pub user: String,
    pub key: String,
}

impl Credential {
    pub fn for_auth(auth: &Auth, secret: &Secret) -> Option<Credential> {
        use base64::Engine;
        let (user, key) = (secret.user.as_str(), secret.key.as_str());
        let header = |name: &str, value: String| Some(Credential::Header(name.into(), value));
        match auth {
            // A sign-in session comes from `sessions`, not straight from the vault.
            Auth::None | Auth::Login(_) => None,
            Auth::Basic if user.is_empty() && key.is_empty() => None,
            Auth::Basic => header("Authorization", format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{key}")))),
            _ if key.is_empty() => None,
            Auth::Bearer => header("Authorization", format!("Bearer {key}")),
            Auth::EmbyToken => header("X-Emby-Token", key.into()),
            Auth::PveToken => header("Authorization", format!("PVEAPIToken={key}")),
            Auth::Header { name, format } => header(name, format.as_deref().map_or_else(|| key.into(), |f| f.replace("{user}", user).replace("{key}", key))),
            Auth::Query { name } => Some(Credential::Query(name.clone(), key.into())),
        }
    }

    /// Put the credential on `url`. Returns the header to send, if it is one.
    pub fn apply(&self, url: &mut Url) -> Option<(String, String)> {
        match self {
            Credential::Header(name, value) => Some((name.clone(), value.clone())),
            Credential::Query(name, value) => {
                let kept: Vec<(String, String)> = url.query_pairs().filter(|(k, _)| k != name.as_str()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
                url.query_pairs_mut().clear().extend_pairs(kept).append_pair(name, value);
                None
            }
        }
    }

    /// The secret text to keep out of anything a package reads back.
    fn secret(&self) -> &str {
        match self {
            Credential::Header(_, value) | Credential::Query(_, value) => value,
        }
    }
}

/// Replace a credential the server echoed (in a redirect's Location, a body…) before a
/// package sees it. Short values aren't scrubbed: they would mangle ordinary text.
fn scrub(text: &str, credential: Option<&Credential>, key: &str) -> String {
    let mut out = text.to_string();
    for secret in [credential.map(Credential::secret).unwrap_or(""), key] {
        if secret.len() >= 6 {
            // As `Credential::apply` writes it into a query string.
            let mut form = Url::parse("http://x/").unwrap();
            form.query_pairs_mut().append_pair("k", secret);
            let encoded = form.query().unwrap_or("k=")[2..].to_string();
            out = out.replace(secret, "[credential]").replace(&encoded, "[credential]");
        }
    }
    out
}

/// Open a WebSocket for `handle` (a connector runtime, or `STREAM_HANDLE` for view
/// streams). On the connection it carries the credential and trusts the saved CA.
pub(crate) async fn open_socket(handle: usize, socket: i64, kind: &str, connection: Option<&Target>, auth: &Auth, url: Url) -> Result<(), String> {
    let (mut url, mut name, mut value, mut ca) = (url, String::new(), String::new(), String::new());
    if let Some(t) = connection.filter(|t| *auth != Auth::None && same_origin(&url, Some(&t.base))) {
        // The connection's saved CA is trusted for wss, as `send` trusts it for https.
        let (secret, saved_ca) = crate::connections::secret_and_ca(kind, &t.account)?;
        let credential = match auth {
            Auth::Login(login) => {
                let client = crate::connections::service_client(kind, &t.account)?;
                Some(crate::sessions::credential(kind, t, login, &secret, &client, false).await?)
            }
            _ => Credential::for_auth(auth, &secret),
        };
        if let Some((n, v)) = credential.and_then(|c| c.apply(&mut url)) {
            (name, value) = (n, v);
        }
        ca = saved_ca.unwrap_or_default();
    }
    let (url, name, value) = (CString::new(url.as_str()).unwrap(), CString::new(name).unwrap(), CString::new(value).unwrap_or_default());
    let ca = CString::new(ca).unwrap_or_default();
    unsafe { connector_ws_open(handle, socket, url.as_ptr(), name.as_ptr(), value.as_ptr(), ca.as_ptr()) };
    Ok(())
}

/// The socket handle view streams use; connector runtimes start at 1.
pub(crate) const STREAM_HANDLE: usize = 0;

pub(crate) fn next_socket() -> i64 {
    NEXT_SOCKET.fetch_add(1, Ordering::SeqCst)
}

pub(crate) fn socket_send_text(socket: i64, text: &str) -> Result<(), String> {
    let text = CString::new(text).map_err(|_| "Invalid message")?;
    unsafe { connector_ws_send(socket, text.as_ptr()) };
    Ok(())
}

pub(crate) fn socket_close(socket: i64) {
    unsafe { connector_ws_close(socket) };
}

/// Headers a package may not set itself: the app's own, and the one its credential uses.
fn forbidden_header(name: &str, auth: &Auth) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(lower.as_str(), "authorization" | "x-emby-token")
        || package_manifest::RESERVED_HEADERS.contains(&lower.as_str())
        || matches!(auth, Auth::Header { name: own, .. } if own.eq_ignore_ascii_case(name))
        || matches!(auth, Auth::Login(package_manifest::Login { session: package_manifest::LoginSession::Token { header, .. }, .. }) if header.eq_ignore_ascii_case(name))
}

#[derive(Clone)]
pub(crate) struct Request {
    pub url: Url,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// How long to wait for the reply; 15 seconds unless a connector asks for longer.
    pub timeout: Option<Duration>,
}

/// A response as packages may see it: `set-cookie` and `www-authenticate` removed and
/// an echoed credential scrubbed from the headers. `body` is raw.
pub(crate) struct Exchange {
    pub status: u16,
    pub headers: Map<String, Value>,
    pub body: Vec<u8>,
    credential: Option<Credential>,
    key: String,
}

async fn send(kind: &str, connection: Option<&Target>, auth: &Auth, request: Request) -> Result<Value, String> {
    Ok(exchange(kind, connection, auth, request).await?.into_json())
}

/// Make a request, with the connection's credential and CA when it goes to the connection.
pub(crate) async fn exchange(kind: &str, connection: Option<&Target>, auth: &Auth, request: Request) -> Result<Exchange, String> {
    // Only an authenticated connection has vault data (its key and any CA). Reading the
    // vault for one without auth could ask the user to unlock their connections.
    let connection = connection.filter(|t| *auth != Auth::None && same_origin(&request.url, Some(&t.base)));
    match connection {
        Some(t) => {
            let client = crate::connections::service_client(kind, &t.account)?;
            to_connection(kind, t, auth, &client, &crate::connections::secret(kind, &t.account)?, request).await
        }
        None => deliver(&crate::connections::plain_client(), None, auth, &Secret::default(), request).await,
    }
}

/// A request to the connection with its saved credential, or its signed-in session:
/// when the server refuses the session, sign in again once.
async fn to_connection(kind: &str, t: &Target, auth: &Auth, client: &reqwest::Client, secret: &Secret, request: Request) -> Result<Exchange, String> {
    let Auth::Login(login) = auth else {
        return deliver(client, Credential::for_auth(auth, secret), auth, secret, request).await;
    };
    let session = crate::sessions::credential(kind, t, login, secret, client, false).await?;
    let first = deliver(client, Some(session), auth, secret, request.clone()).await?;
    // A fresh session that's refused means this request isn't allowed: don't sign in again.
    if !matches!(first.status, 401 | 403) || !crate::sessions::renewable(kind, &t.account) {
        return Ok(first);
    }
    let session = crate::sessions::credential(kind, t, login, secret, client, true).await?;
    deliver(client, Some(session), auth, secret, request).await
}

impl Exchange {
    /// What a connector's `fetch` receives: text stays text (with any echoed credential
    /// scrubbed); other bodies go as base64.
    fn into_json(self) -> Value {
        let (status, headers) = (self.status, self.headers);
        match String::from_utf8(self.body) {
            Ok(text) => json!({"status": status, "headers": headers, "body": scrub(&text, self.credential.as_ref(), &self.key)}),
            Err(bytes) => {
                use base64::Engine;
                json!({"status": status, "headers": headers, "base64": base64::engine::general_purpose::STANDARD.encode(bytes.into_bytes())})
            }
        }
    }
}

/// Send a request with `credential`, which `exchange` gives only to the connection.
async fn deliver(client: &reqwest::Client, credential: Option<Credential>, auth: &Auth, secret: &Secret, request: Request) -> Result<Exchange, String> {
    let mut url = request.url.clone();
    let header = credential.as_ref().and_then(|c| c.apply(&mut url));
    let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| "Unsupported method")?;
    let mut builder = client.request(method, url).timeout(request.timeout.unwrap_or(Duration::from_secs(15)));
    for (name, value) in &request.headers {
        if !forbidden_header(name, auth) {
            builder = builder.header(name.as_str(), value.as_str());
        }
    }
    if let Some((name, value)) = header {
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    // Errors are fixed text: a reqwest error names the URL, which may carry a query key.
    let mut response = builder.send().await.map_err(|_| "Server unreachable".to_string())?;
    let status = response.status().as_u16();
    let headers: Map<String, Value> = response
        .headers()
        .iter()
        .filter(|(name, _)| !matches!(name.as_str(), "set-cookie" | "www-authenticate"))
        .filter_map(|(name, value)| Some((name.as_str().to_string(), Value::String(scrub(value.to_str().ok()?, credential.as_ref(), &secret.key)))))
        .collect();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Connection interrupted")? {
        if body.len() + chunk.len() > RESPONSE_LIMIT {
            return Err("Response exceeds 8 MiB".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Exchange { status, headers, body, credential, key: secret.key.clone() })
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

pub(crate) fn route_url(base: &Url, route: &str) -> Url {
    let mut url = base.clone();
    let (path, query) = route.split_once('?').map_or((route, None), |(p, q)| (p, Some(q)));
    url.set_path(&format!("{}/{}", base.path().trim_end_matches('/'), path));
    url.set_query(query);
    url
}

fn run_declarative(kind: String, manifest: Manifest, target: Target, auth: Auth, output: Arc<Mutex<Output>>, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut due: HashMap<String, Instant> = HashMap::new();
        while !stop.load(Ordering::SeqCst) {
            for poll in &manifest.data {
                if due.get(&poll.id).is_some_and(|at| Instant::now() < *at) {
                    continue;
                }
                due.insert(poll.id.clone(), Instant::now() + Duration::from_secs(poll.every.into()));
                let request = Request { url: route_url(&target.base, &poll.path), method: "GET".into(), headers: vec![("Accept".into(), "application/json".into())], body: None, timeout: None };
                let result = tauri::async_runtime::block_on(send(&kind, Some(&target), &auth, request)).and_then(|r| {
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
    Command { id: i64, name: String, args: Value },
}

/// How long a view waits for a connector to answer a command.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(660);
static NEXT_COMMAND: AtomicI64 = AtomicI64::new(1);

struct Timer {
    id: i64,
    at: Instant,
    every: Option<Duration>,
}

struct Runtime {
    handle: usize,
    kind: String,
    links: Vec<Link>,
    origins: Vec<String>,
    tx: mpsc::Sender<Event>,
    output: Arc<Mutex<Output>>,
    timers: Mutex<Vec<Timer>>,
    storage: Mutex<Map<String, Value>>,
    storage_file: Option<PathBuf>,
    storage_limit: usize,
    sockets: Mutex<HashMap<i64, i64>>, // global socket → connector's own id
    commands: Mutex<HashMap<i64, mpsc::Sender<Result<Value, String>>>>, // waiting views
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
            let body = match (args["body"].as_str(), args["bodyBase64"].as_str()) {
                (_, Some(encoded)) => {
                    use base64::Engine;
                    Some(base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "Invalid binary body")?)
                }
                (Some(text), None) => Some(text.as_bytes().to_vec()),
                (None, None) => None,
            };
            if body.as_ref().is_some_and(|b| b.len() > BODY_LIMIT) {
                return Err("Request bodies are limited to 1 MiB.".into());
            }
            let headers = args["headers"].as_object().map(|h| {
                h.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).take(32).collect()
            }).unwrap_or_default();
            // Up to 10 minutes for slow operations such as loading a model.
            let timeout = args["timeout"].as_f64().filter(|t| *t > 0.0).map(|t| Duration::from_secs_f64(t.min(600.0)));
            let index = args["connection"].as_u64().map(|i| i as usize);
            let link = link_for(&rt.links, &url, index)?.cloned();
            let (kind, tx) = (rt.kind.clone(), rt.tx.clone());
            tauri::async_runtime::spawn(async move {
                let (target, auth) = link.map_or((None, Auth::None), |l| (Some(l.target), l.auth));
                let result = send(&kind, target.as_ref(), &auth, Request { url, method, headers, body, timeout }).await;
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
        "commandReply" => {
            let id = args["id"].as_i64().ok_or("Missing command ID")?;
            let reply = match args["error"].as_str() {
                Some(error) => Err(error.chars().take(500).collect()),
                None => {
                    let value = args.get("value").cloned().unwrap_or(Value::Null);
                    if value.to_string().len() > EMIT_LIMIT {
                        Err("Command replies are limited to 1 MiB.".to_string())
                    } else {
                        Ok(value)
                    }
                }
            };
            if let Some(waiting) = rt.commands.lock().unwrap().remove(&id) {
                let _ = waiting.send(reply);
            }
            Ok(Value::Null)
        }
        "log" => {
            let level = match args["level"].as_str() {
                Some("warn") => "warn",
                Some("error") => "error",
                Some("info") => "info",
                Some("debug") => "debug",
                _ => "log",
            };
            log_line(&rt.kind, level, args["message"].as_str().unwrap_or(""));
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
            let global = next_socket();
            sockets.insert(global, local);
            drop(sockets);
            // The connector's thread isn't async: wait here for a sign-in, if any.
            let link = match link_for(&rt.links, &url, args["connection"].as_u64().map(|i| i as usize)) {
                Ok(link) => link,
                Err(error) => {
                    rt.sockets.lock().unwrap().remove(&global);
                    return Err(error);
                }
            };
            let (target, auth) = link.map_or((None, Auth::None), |l| (Some(l.target.clone()), l.auth.clone()));
            // Open in the background, so a sign-in never holds up the connector's script.
            // A failure arrives as the socket's error and close events.
            let (handle, kind, tx) = (rt.handle, rt.kind.clone(), rt.tx.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(error) = open_socket(handle, global, &kind, target.as_ref(), &auth, url).await {
                    if let Some(rt) = runtime(handle) {
                        rt.sockets.lock().unwrap().remove(&global);
                    }
                    let _ = tx.send(Event::Socket { id: local, kind: "error".into(), data: error });
                    let _ = tx.send(Event::Socket { id: local, kind: "close".into(), data: "1006".into() });
                }
            });
            Ok(Value::Null)
        }
        "wsSend" | "wsClose" => {
            let local = args["id"].as_i64().unwrap_or(-1);
            let global = rt.sockets.lock().unwrap().iter().find(|(_, l)| **l == local).map(|(g, _)| *g);
            let Some(global) = global else { return Ok(Value::Null) };
            if op == "wsSend" {
                if let Some(encoded) = args["base64"].as_str() {
                    use base64::Engine;
                    let data = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "Invalid binary message")?;
                    if data.len() > 4 * 1024 * 1024 {
                        return Err("Messages are limited to 4 MiB.".into());
                    }
                    unsafe { connector_ws_send_binary(global, data.as_ptr(), data.len()) };
                    return Ok(Value::Null);
                }
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
    if handle == STREAM_HANDLE {
        let kind = unsafe { CStr::from_ptr(kind) }.to_string_lossy();
        let data = unsafe { CStr::from_ptr(data) }.to_string_lossy();
        crate::package_stream::event(socket, &kind, &data);
        return;
    }
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
    /// The placement's connections, each with its own auth (its type may pick it).
    pub links: Vec<Link>,
    pub manifest: Manifest,
    pub storage_file: Option<PathBuf>,
}

/// Run a connector on its own thread until `stop` is set. Returns its handle, which
/// `package_command` uses to reach it.
pub(crate) fn run_connector(setup: ConnectorSetup, output: Arc<Mutex<Output>>, stop: Arc<AtomicBool>) -> usize {
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::SeqCst) as usize;
    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel();
        let storage = setup.storage_file.as_ref()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice::<Map<String, Value>>(&b).ok())
            .unwrap_or_default();
        let bases: Vec<&Url> = setup.links.iter().map(|l| &l.target.base).collect();
        let rt = Arc::new(Runtime {
            handle,
            kind: setup.kind.clone(),
            origins: allowed_origins(&bases, &setup.manifest),
            links: setup.links.clone(),
            tx,
            output: output.clone(),
            timers: Mutex::new(Vec::new()),
            storage: Mutex::new(storage),
            storage_file: setup.storage_file.clone(),
            storage_limit: setup.manifest.connector.as_ref().map_or(64 * 1024, |c| c.storage as usize),
            sockets: Mutex::new(HashMap::new()),
            commands: Mutex::new(HashMap::new()),
        });
        RUNTIMES.lock().unwrap().insert(handle, rt.clone());
        let context = Context(unsafe { connector_new(handle, WATCHDOG_SECONDS) });
        let connections: Vec<Value> = setup.links.iter().map(Link::json).collect();
        let fail = |error: String| {
            log_line(&setup.kind, "error", &error);
            let mut out = output.lock().unwrap();
            out.error = Some(error);
            out.rev += 1;
        };
        let start = context.eval(PRELUDE, "dashledge://prelude")
            .and_then(|_| context.eval(&format!("__dashledge_start({})", json!({"connections": connections})), "dashledge://start"))
            .and_then(|_| context.eval(&setup.source, &format!("package://{}/connector.js", setup.package)));
        match start {
            Ok(()) => log_line(&setup.kind, "info", "Connector started."),
            Err(error) => fail(error),
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
                Ok(Event::Command { id, name, args }) => context.dispatch(json!({"type": "command", "id": id, "name": name, "args": args})),
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
    handle
}

// -------------------------------------------------------------------- logs ----

/// One line a connector wrote with `console`, or an error that stopped a script.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct LogLine {
    pub at: i64,
    pub level: &'static str,
    pub text: String,
}

const LOG_LINES: usize = 50;
/// The last lines from each package's connector, kept while the app runs.
static LOGS: Mutex<Option<HashMap<String, VecDeque<LogLine>>>> = Mutex::new(None);

pub fn log_line(kind: &str, level: &'static str, text: &str) {
    let mut logs = LOGS.lock().unwrap();
    let lines = logs.get_or_insert_with(HashMap::new).entry(kind.to_string()).or_default();
    lines.push_back(LogLine { at: chrono::Utc::now().timestamp_millis(), level, text: text.chars().take(500).collect() });
    while lines.len() > LOG_LINES {
        lines.pop_front();
    }
}

pub fn logs_for(kind: &str) -> Vec<LogLine> {
    LOGS.lock().unwrap().as_ref().and_then(|l| l.get(kind)).map(|l| l.iter().cloned().collect()).unwrap_or_default()
}

/// A package's recent connector output, for Widget Studio.
#[tauri::command]
pub fn package_logs(window: tauri::WebviewWindow, id: String) -> Result<Vec<LogLine>, String> {
    if window.label() != "settings" {
        return Err("Open Widget Studio in Settings.".into());
    }
    Ok(logs_for(&id))
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
        // Streams end with their viewer's window, and with their feed.
        let feeds = FEEDS.lock().unwrap();
        crate::package_stream::retain(|feed, viewer| feeds.get(feed).is_some_and(|f| f.viewers.contains_key(viewer)));
    });
}

pub fn shutdown() {
    FEEDS.lock().unwrap().clear();
}

/// The view folder of a running package feed, for the widget host to serve.
/// An installed package feed's view folder, and whether its views get the UI kit.
pub fn view_root(id: &str) -> Option<(PathBuf, bool)> {
    FEEDS.lock().unwrap().get(id).map(|f| (f.view.clone(), f.ui))
}

/// The capabilities a package's view may use, as the dashboard's bridge enforces them.
fn permission_names(manifest: &crate::package_manifest::Manifest) -> Value {
    serde_json::to_value(&manifest.permissions).unwrap_or_else(|_| json!([]))
}

#[tauri::command]
pub fn package_open(window: tauri::WebviewWindow, app: tauri::AppHandle, kind: String, connection: Option<Connection>,
    connections: Option<Vec<Connection>>, viewer: String) -> Result<Value, String> {
    if viewer.is_empty() || viewer.len() > 80 {
        return Err("Invalid viewer".into());
    }
    let (manifest, dir) = installed_package(&kind)?;
    let entry = std::path::Path::new(&manifest.view.entry).file_name().and_then(|n| n.to_str()).unwrap_or("index.html").to_string();
    let needs = manifest.sources.as_ref().is_some_and(|s| s.min > 0);
    // The placement's connections, the chosen one first, up to the manifest's count.
    let mut connections = connections.unwrap_or_else(|| connection.into_iter().collect());
    connections.truncate(manifest.sources.as_ref().map_or(0, |s| s.max as usize));
    if needs && connections.is_empty() {
        return Err("Choose a connection for this widget in Widget Studio.".into());
    }
    let revision = crate::package_store::revision(&kind);
    let mut feeds = FEEDS.lock().unwrap();
    if let Some((id, feed)) = feeds.iter_mut().find(|(_, f)| f.kind == kind && f.connections == connections && f.revision == revision) {
        feed.viewers.insert(viewer, window.label().into());
        feed.last_attached = Instant::now();
        return Ok(json!({"id": id, "entry": entry, "permissions": permission_names(&manifest), "commands": command_names(&manifest)}));
    }
    let links = connections.iter().map(|c| Ok(Link {
        target: Target::new(&kind, &c.address)?, name: c.name.clone(), source_type: c.source_type.clone(),
        auth: manifest.auth_for(c.source_type.as_deref()),
    })).collect::<Result<Vec<_>, String>>()?;
    let output = Arc::new(Mutex::new(Output::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let mut connector = None;
    match manifest.tier() {
        Tier::Connector => {
            let entry = &manifest.connector.as_ref().unwrap().entry;
            let source = std::fs::read_to_string(dir.join(entry)).map_err(|_| "The connector script is missing.")?;
            let storage_file = app.path().app_data_dir().ok().map(|d| d.join("package-data").join(format!("{kind}.json")));
            connector = Some(run_connector(ConnectorSetup {
                kind: kind.clone(), package: kind.clone(), source,
                links: links.clone(),
                manifest: manifest.clone(), storage_file,
            }, output.clone(), stop.clone()));
        }
        // Declarative polls read the placement's first connection.
        Tier::Declarative => {
            let first = links.first().cloned().ok_or("Choose a connection")?;
            run_declarative(kind.clone(), manifest.clone(), first.target, first.auth, output.clone(), stop.clone())
        }
        Tier::View | Tier::Collector => {}
    }
    let view = dir.join(std::path::Path::new(&manifest.view.entry).parent().unwrap_or(std::path::Path::new("")));
    let id = format!("pkg-{}", NEXT_FEED.fetch_add(1, Ordering::SeqCst));
    let mut viewers = HashMap::new();
    viewers.insert(viewer, window.label().to_string());
    let ui = manifest.permissions.contains(&crate::package_manifest::Permission::Ui);
    feeds.insert(id.clone(), Feed { kind, connector, connections, view, ui, revision, viewers, last_attached: Instant::now(), output, stop });
    Ok(json!({"id": id, "entry": entry, "permissions": permission_names(&manifest), "commands": command_names(&manifest)}))
}

#[tauri::command]
pub fn package_read(id: String, viewer: String, since: u64) -> Result<Value, String> {
    let feeds = FEEDS.lock().unwrap();
    let feed = feeds.get(&id).filter(|f| f.viewers.contains_key(&viewer)).ok_or("Widget disconnected")?;
    // An unpacked package's files changed: the view reopens with a fresh connector.
    if crate::package_store::revision(&feed.kind) != feed.revision {
        return Ok(json!({"reload": true}));
    }
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
    crate::package_stream::close_for(&id, Some(&viewer));
}

/// The connector commands a package declares, for the bridge.
fn command_names(manifest: &Manifest) -> Value {
    json!(manifest.connector.as_ref().map(|c| c.commands.clone()).unwrap_or_default())
}

/// Send a declared command to the feed's connector and wait for its answer.
#[tauri::command]
pub async fn package_command(id: String, viewer: String, name: String, args: Option<Value>) -> Result<Value, String> {
    let (kind, handle) = {
        let feeds = FEEDS.lock().unwrap();
        let feed = feeds.get(&id).filter(|f| f.viewers.contains_key(&viewer)).ok_or("Widget disconnected")?;
        (feed.kind.clone(), feed.connector)
    };
    let manifest = installed_manifest(&kind)?;
    if !manifest.connector.as_ref().is_some_and(|c| c.commands.contains(&name)) {
        return Err("This widget didn’t declare that command.".into());
    }
    let args = args.unwrap_or(Value::Null);
    if args.to_string().len() > BODY_LIMIT {
        return Err("Command arguments are limited to 1 MiB.".into());
    }
    ask_connector(handle.ok_or("The widget’s connector isn’t running.")?, name, args).await
}

/// Hand a command to a running connector and wait for its handler's answer.
async fn ask_connector(handle: usize, name: String, args: Value) -> Result<Value, String> {
    let rt = runtime(handle).ok_or("The widget’s connector isn’t running.")?;
    let command = NEXT_COMMAND.fetch_add(1, Ordering::SeqCst);
    let (reply, answer) = mpsc::channel();
    rt.commands.lock().unwrap().insert(command, reply);
    rt.tx.send(Event::Command { id: command, name, args }).map_err(|_| "The widget’s connector stopped.")?;
    let result = tauri::async_runtime::spawn_blocking(move || answer.recv_timeout(COMMAND_TIMEOUT)).await.map_err(|e| e.to_string())?;
    rt.commands.lock().unwrap().remove(&command);
    result.map_err(|_| "The widget’s connector didn’t answer.".to_string())?
}

/// A running feed's package kind and one of its connections (`index`, else the first),
/// for a viewer attached to it.
pub(crate) fn feed_connection(id: &str, viewer: &str, index: Option<usize>) -> Result<(String, Option<Connection>), String> {
    let feeds = FEEDS.lock().unwrap();
    let feed = feeds.get(id).filter(|f| f.viewers.contains_key(viewer)).ok_or("Widget disconnected")?;
    let connection = match index {
        Some(i) => Some(feed.connections.get(i).cloned().ok_or_else(|| format!("This widget has no connection {i}."))?),
        None => feed.connections.first().cloned(),
    };
    Ok((feed.kind.clone(), connection))
}

/// The manifest of an installed package, never a bundled one.
pub(crate) fn installed_manifest(kind: &str) -> Result<Manifest, String> {
    Ok(installed_package(kind)?.0)
}

/// Run a manifest-declared action against the placement's connection.
#[tauri::command]
pub async fn package_action(id: String, viewer: String, action: String, args: Map<String, Value>, connection: Option<usize>) -> Result<Value, String> {
    let (kind, connection) = feed_connection(&id, &viewer, connection)?;
    let (manifest, _) = installed_package(&kind)?;
    let declared = manifest.actions.iter().find(|a| a.id == action).ok_or("This widget didn’t declare that action.")?;
    let connection = connection.ok_or("Choose a connection")?;
    let target = Target::new(&kind, &connection.address)?;
    let path = fill(&declared.path, &args)?;
    let body = declared.body.as_ref().map(|b| fill_body(b, &args)).transpose()?.map(|b| b.to_string().into_bytes());
    let method = match declared.method { Method::Post => "POST", Method::Put => "PUT", Method::Delete => "DELETE" };
    let mut headers = vec![("Accept".to_string(), "application/json".to_string())];
    if body.is_some() {
        headers.push(("Content-Type".into(), "application/json".into()));
    }
    let auth = manifest.auth_for(connection.source_type.as_deref());
    let response = send(&kind, Some(&target), &auth, Request { url: route_url(&target.base, &path), method: method.into(), headers, body, timeout: None }).await?;
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
        let origins = allowed_origins(&[&connection], &manifest(&["https://api.example.com"]));
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
        let key = |key: &str| Secret { user: String::new(), key: key.into() };
        let header = |auth: &Auth, secret: &Secret| Credential::for_auth(auth, secret).and_then(|c| c.apply(&mut connection.clone()));
        assert_eq!(header(&Auth::Bearer, &key("k")).unwrap(), ("Authorization".into(), "Bearer k".into()));
        assert_eq!(header(&Auth::EmbyToken, &key("k")).unwrap().0, "X-Emby-Token");
        assert!(Credential::for_auth(&Auth::Bearer, &key("")).is_none() && Credential::for_auth(&Auth::None, &key("k")).is_none());
        for name in ["Authorization", "cookie", "X-Emby-Token", "Host", "Content-Length"] {
            assert!(forbidden_header(name, &Auth::Bearer), "{name}");
        }
        assert!(!forbidden_header("Accept", &Auth::Bearer) && !forbidden_header("X-Api-Key", &Auth::Bearer));
        assert!(forbidden_header("x-api-key", &Auth::Header { name: "X-Api-Key".into(), format: None }), "a package can't replace its own credential header");
    }

    #[test]
    fn header_query_and_basic_credentials_take_their_place() {
        let secret = Secret { user: "admin".into(), key: "s3cret-key".into() };
        let mut url = Url::parse("http://sab.local:8080/api?mode=queue&apikey=forged&output=json").unwrap();
        let query = Credential::for_auth(&Auth::Query { name: "apikey".into() }, &secret).unwrap();
        assert!(query.apply(&mut url).is_none(), "a query key isn't a header");
        assert_eq!(url.query(), Some("mode=queue&output=json&apikey=s3cret-key"), "the package's own apikey is replaced");
        let mut plain = Url::parse("http://h/").unwrap();
        let header = |auth: Auth| Credential::for_auth(&auth, &secret).unwrap().apply(&mut plain.clone()).unwrap();
        assert_eq!(header(Auth::Header { name: "X-Api-Key".into(), format: None }), ("X-Api-Key".into(), "s3cret-key".into()));
        assert_eq!(header(Auth::Header { name: "Authorization".into(), format: Some("MediaBrowser Token=\"{key}\"".into()) }).1, "MediaBrowser Token=\"s3cret-key\"");
        assert_eq!(header(Auth::Basic), ("Authorization".into(), "Basic YWRtaW46czNjcmV0LWtleQ==".into()));
        assert!(Credential::for_auth(&Auth::Basic, &Secret::default()).is_none());
        assert!(plain.query().is_none());
        plain.set_path("/x");
    }

    #[test]
    fn an_expired_session_signs_in_again_once_and_the_session_stays_hidden() {
        // An old session (SID=one) is refused, Dashledge signs in again (SID=two), the retry succeeds.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let replies = [
                "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nSet-Cookie: SID=two-session\r\nContent-Length: 3\r\nConnection: close\r\n\r\nOk.",
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 26\r\nConnection: close\r\n\r\n{\"echo\":\"SID=two-session\"}",
            ];
            let mut requests = Vec::new();
            for (reply, stream) in replies.iter().zip(listener.incoming()) {
                let mut stream = stream.unwrap();
                let mut buffer = [0u8; 4096];
                let n = stream.read(&mut buffer).unwrap();
                requests.push(String::from_utf8_lossy(&buffer[..n]).into_owned());
                stream.write_all(reply.as_bytes()).unwrap();
            }
            requests
        });
        let base = Url::parse(&address).unwrap();
        let target = Target { base: base.clone(), account: base.clone() };
        let auth: Auth = serde_json::from_value(json!({"login": {"path": "api/v2/auth/login", "fields": {"username": "{user}", "password": "{key}"}, "session": "cookie"}})).unwrap();
        let secret = Secret { user: "admin".into(), key: "pw-secret".into() };
        let request = Request { url: base.join("api/v2/torrents/info").unwrap(), method: "GET".into(),
            headers: vec![("Cookie".into(), "SID=forged".into())], body: None, timeout: None };
        crate::sessions::seed("plugin.retry-test", &base, Credential::Header("Cookie".into(), "SID=one-session".into()), crate::sessions::RENEW_AFTER);
        let result = tauri::async_runtime::block_on(to_connection("plugin.retry-test", &target, &auth, &crate::connections::plain_client(), &secret, request)).unwrap();
        assert_eq!(result.status, 200);
        let json = result.into_json();
        assert!(!json.to_string().contains("two-session"), "an echoed session is scrubbed: {json}");
        let requests = server.join().unwrap();
        assert!(requests[0].contains("cookie: SID=one-session") && !requests[0].contains("forged"), "{}", requests[0]);
        assert!(requests[1].starts_with("POST /api/v2/auth/login "), "a refused old session signs in again");
        assert!(requests[2].contains("cookie: SID=two-session"));
        crate::sessions::forget("plugin.retry-test", &base);
    }

    #[test]
    fn a_fresh_session_that_is_refused_does_not_sign_in_again() {
        // A permission 403 right after signing in must not post the form on every poll.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let replies = [
                "HTTP/1.1 200 OK\r\nSet-Cookie: SID=fresh\r\nContent-Length: 3\r\nConnection: close\r\n\r\nOk.",
                "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            ];
            let mut requests = Vec::new();
            for (reply, stream) in replies.iter().zip(listener.incoming()) {
                let mut stream = stream.unwrap();
                let mut buffer = [0u8; 4096];
                let n = stream.read(&mut buffer).unwrap();
                requests.push(String::from_utf8_lossy(&buffer[..n]).into_owned());
                stream.write_all(reply.as_bytes()).unwrap();
            }
            requests
        });
        let base = Url::parse(&address).unwrap();
        let target = Target { base: base.clone(), account: base.clone() };
        let auth: Auth = serde_json::from_value(json!({"login": {"path": "login", "fields": {"password": "{key}"}, "session": "cookie"}})).unwrap();
        let secret = Secret { user: String::new(), key: "pw".into() };
        let get = || Request { url: base.join("admin").unwrap(), method: "GET".into(), headers: vec![], body: None, timeout: None };
        let client = crate::connections::plain_client();
        for _ in 0..2 {
            let result = tauri::async_runtime::block_on(to_connection("plugin.forbidden-test", &target, &auth, &client, &secret, get())).unwrap();
            assert_eq!(result.status, 403);
        }
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("POST /login "));
        assert!(requests[1].starts_with("GET /admin ") && requests[2].starts_with("GET /admin "), "one sign-in, then the refusals come straight back");
        crate::sessions::forget("plugin.forbidden-test", &base);
    }

    #[test]
    fn an_echoed_credential_is_scrubbed_before_a_package_reads_it() {
        let credential = Credential::Query("apikey".into(), "abc/123+key".into());
        let location = "https://sab.local/api?mode=queue&apikey=abc%2F123%2Bkey";
        assert_eq!(scrub(location, Some(&credential), "abc/123+key"), "https://sab.local/api?mode=queue&apikey=[credential]");
        assert_eq!(scrub("{\"apikey\": \"abc/123+key\"}", Some(&credential), "abc/123+key"), "{\"apikey\": \"[credential]\"}");
        assert_eq!(scrub("a 1 b", Some(&Credential::Query("k".into(), "1".into())), "1"), "a 1 b", "short values are left alone");
    }

    #[test]
    fn a_query_key_reaches_the_server_but_not_the_connector() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let n = stream.read(&mut request).unwrap();
            let body = "{\"apikey\":\"sab-test-key\"}";
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: https://x/api?apikey=sab-test-key\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            String::from_utf8_lossy(&request[..n]).into_owned()
        });
        let base = Url::parse(&format!("{address}/")).unwrap();
        let auth = Auth::Query { name: "apikey".into() };
        let secret = Secret { user: String::new(), key: "sab-test-key".into() };
        let result = tauri::async_runtime::block_on(deliver(
            &crate::connections::plain_client(), Credential::for_auth(&auth, &secret), &auth, &secret,
            Request { url: base.join("api?mode=queue").unwrap(), method: "GET".into(), headers: vec![], body: None, timeout: None },
        )).unwrap().into_json();
        assert!(server.join().unwrap().starts_with("GET /api?mode=queue&apikey=sab-test-key "));
        assert!(!result.to_string().contains("sab-test-key"), "{result}");
        assert_eq!(result["status"], 302);
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

    fn link(url: Url, source_type: Option<&str>) -> Link {
        Link { target: Target { base: url.clone(), account: url }, name: "Test".into(), source_type: source_type.map(str::to_string), auth: Auth::None }
    }

    #[test]
    fn a_request_goes_to_the_connection_it_falls_under() {
        let radarr = link(Url::parse("http://media.local/radarr/").unwrap(), Some("radarr"));
        let sonarr = link(Url::parse("http://media.local/sonarr/").unwrap(), Some("sonarr"));
        let sab = link(Url::parse("http://sab.local:8080/").unwrap(), None);
        let links = vec![radarr, sonarr, sab];
        let pick = |url: &str, index| link_for(&links, &Url::parse(url).unwrap(), index).unwrap().map(|l| l.source_type.clone());
        assert_eq!(pick("http://media.local/sonarr/api/v3/queue", None), Some(Some("sonarr".into())), "two services behind one proxy keep their own keys");
        assert_eq!(pick("http://media.local/radarr/api/v3/movie", None), Some(Some("radarr".into())));
        assert_eq!(pick("http://sab.local:8080/api?mode=queue", None), Some(None));
        assert_eq!(pick("https://api.example.com/x", None), None, "a declared host is no connection");
        assert_eq!(pick("http://media.local/sonarr/api", Some(0)), Some(Some("radarr".into())), "an explicit index wins");
        assert!(link_for(&links, &Url::parse("http://sab.local:8080/").unwrap(), Some(9)).is_err());
    }

    #[test]
    fn a_view_command_reaches_the_connectors_handler_and_its_answer_returns() {
        let source = r#"
            dashledge.onCommand('pause', args => ({paused: true, minutes: args.minutes}));
            dashledge.onCommand('slow', async () => { await new Promise(r => setTimeout(r, 30)); return 'done'; });
            dashledge.onCommand('broken', () => { throw new Error('queue is locked'); });
            dashledge.emit({ready: true});
        "#;
        let output = Arc::new(Mutex::new(Output::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let handle = run_connector(ConnectorSetup {
            kind: "plugin.test".into(), package: "plugin.test".into(), source: source.into(),
            links: vec![], manifest: manifest(&[]), storage_file: None,
        }, output.clone(), stop.clone());
        assert!(wait_for(&output, |o| o.data.get("ready").is_some()), "{:?}", output.lock().unwrap().error);
        let ask = |name: &str, args: Value| tauri::async_runtime::block_on(ask_connector(handle, name.into(), args));
        assert_eq!(ask("pause", json!({"minutes": 30})).unwrap(), json!({"paused": true, "minutes": 30}));
        assert_eq!(ask("slow", Value::Null).unwrap(), json!("done"), "a handler may answer with a promise");
        assert_eq!(ask("broken", Value::Null).unwrap_err(), "queue is locked");
        assert!(ask("missing", Value::Null).unwrap_err().contains("doesn’t handle"));
        stop.store(true, Ordering::SeqCst);
    }

    #[test]
    fn a_connector_sees_every_connection_of_its_placement() {
        let source = r#"dashledge.emit({count: dashledge.connections.length, first: dashledge.connection.name, frozen: Object.isFrozen(dashledge.connections),
            types: dashledge.connections.map(c => c.type)});"#;
        let output = Arc::new(Mutex::new(Output::default()));
        let stop = Arc::new(AtomicBool::new(false));
        run_connector(ConnectorSetup {
            kind: "plugin.test".into(), package: "plugin.test".into(), source: source.into(),
            links: vec![link(Url::parse("http://a.local/").unwrap(), Some("radarr")), link(Url::parse("http://b.local/").unwrap(), Some("sonarr"))],
            manifest: manifest(&[]), storage_file: None,
        }, output.clone(), stop.clone());
        assert!(wait_for(&output, |o| o.data.get("count").is_some()), "{:?}", output.lock().unwrap().error);
        let data = output.lock().unwrap().data.clone();
        assert_eq!(data, json!({"count": 2, "first": "Test", "frozen": true, "types": ["radarr", "sonarr"]}));
        stop.store(true, Ordering::SeqCst);
    }

    fn start(source: &str, connection: Option<Url>, hosts: &[&str]) -> (Arc<Mutex<Output>>, Arc<AtomicBool>) {
        let output = Arc::new(Mutex::new(Output::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let setup = ConnectorSetup {
            kind: "plugin.test".into(), package: "plugin.test".into(), source: source.into(),
            links: connection.map(|u| link(u, None)).into_iter().collect(), manifest: manifest(hosts), storage_file: None,
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
    fn a_connection_resolves_its_base_with_the_address_mode_and_keeps_the_typed_account() {
        // oMLX uses `address: path`: requests join beneath the prefix, the vault keeps the typed address.
        let target = Target::new("omlx", "https://proxy.local/omlx").unwrap();
        assert_eq!(target.base.as_str(), "https://proxy.local/omlx/");
        assert_eq!(target.account.as_str(), "https://proxy.local/omlx");
        assert!(Target::new("omlx", "https://proxy.local/?token=x").is_err());
    }

    #[test]
    fn a_connector_sees_the_resolved_base_and_requests_go_beneath_it() {
        let (address, server) = serve_once("{\"ok\": true}");
        let source = r#"
            fetch(dashledge.connection.address + 'status').then(r => r.json())
              .then(body => dashledge.emit({address: dashledge.connection.address, type: dashledge.connection.type, ok: body.ok}));
        "#;
        let base = Url::parse(&format!("{address}/api/")).unwrap();
        let account = Url::parse(&format!("{address}/api")).unwrap();
        let output = Arc::new(Mutex::new(Output::default()));
        let stop = Arc::new(AtomicBool::new(false));
        run_connector(ConnectorSetup {
            kind: "plugin.test".into(), package: "plugin.test".into(), source: source.into(),
            links: vec![Link { target: Target { base: base.clone(), account }, name: "Test".into(), source_type: Some("sab".into()), auth: Auth::None }],
            manifest: manifest(&[]), storage_file: None,
        }, output.clone(), stop.clone());
        assert!(wait_for(&output, |o| o.data.get("ok").is_some()), "error: {:?}", output.lock().unwrap().error);
        assert_eq!(output.lock().unwrap().data["address"], base.as_str());
        assert_eq!(output.lock().unwrap().data["type"], "sab", "the connector sees its connection's type");
        assert!(server.join().unwrap().starts_with("GET /api/status "));
        stop.store(true, Ordering::SeqCst);
    }

    /// Answer one request with raw bytes; returns the request's bytes.
    fn serve_bytes(content_type: &'static str, body: Vec<u8>) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            while let Ok(n) = stream.read(&mut chunk) {
                if n == 0 { break; }
                request.extend_from_slice(&chunk[..n]);
            }
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            stream.write_all(&body).unwrap();
            request
        });
        (address, handle)
    }

    #[test]
    fn binary_bodies_reach_a_connector_intact_and_text_decodes_as_utf8() {
        // A PNG signature plus bytes that aren't valid UTF-8.
        let image = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe, 0x80];
        let (address, server) = serve_bytes("image/png", image.clone());
        let source = r#"
            fetch(dashledge.connection.address + 'poster.png').then(r => r.arrayBuffer())
              .then(buffer => dashledge.emit({bytes: Array.from(new Uint8Array(buffer))}))
              .catch(e => dashledge.emit({failed: String(e)}));
        "#;
        let (output, stop) = start(source, Some(Url::parse(&format!("{address}/")).unwrap()), &[]);
        assert!(wait_for(&output, |o| o.data.get("bytes").is_some() || o.data.get("failed").is_some()), "{:?}", output.lock().unwrap().error);
        assert_eq!(output.lock().unwrap().data["bytes"], json!(image));
        server.join().unwrap();
        stop.store(true, Ordering::SeqCst);

        let text = "héllo ✓ 😀";
        let (address, server) = serve_bytes("text/plain; charset=utf-8", text.as_bytes().to_vec());
        let source = r#"
            fetch(dashledge.connection.address + 'note', {method: 'POST', body: new Uint8Array([0, 255, 1, 128])}).then(async r => {
              const bytes = new Uint8Array(await r.arrayBuffer());
              dashledge.emit({text: await r.text(), length: bytes.length});
            }).catch(e => dashledge.emit({failed: String(e)}));
        "#;
        let (output, stop) = start(source, Some(Url::parse(&format!("{address}/")).unwrap()), &[]);
        assert!(wait_for(&output, |o| o.data.get("text").is_some() || o.data.get("failed").is_some()), "{:?}", output.lock().unwrap().error);
        let data = output.lock().unwrap().data.clone();
        assert_eq!(data["text"], text, "{data}");
        assert_eq!(data["length"], text.len());
        let request = server.join().unwrap();
        assert!(request.ends_with(&[0, 255, 1, 128]), "the binary request body arrives as sent");
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

    #[test]
    fn connector_logs_are_kept_per_package_and_capped() {
        for n in 0..60 {
            log_line("plugin.log-a", "log", &format!("line {n}"));
        }
        log_line("plugin.log-b", "error", "b only");
        let a = logs_for("plugin.log-a");
        assert_eq!(a.len(), 50);
        assert_eq!(a.first().unwrap().text, "line 10");
        assert!(a.iter().all(|line| line.text != "b only"));
        assert_eq!(logs_for("plugin.log-b"), vec![LogLine { at: logs_for("plugin.log-b")[0].at, level: "error", text: "b only".into() }]);
        assert!(logs_for("plugin.log-none").is_empty());
        log_line("plugin.log-a", "log", &"x".repeat(900));
        assert_eq!(logs_for("plugin.log-a").last().unwrap().text.len(), 500);
    }
}
