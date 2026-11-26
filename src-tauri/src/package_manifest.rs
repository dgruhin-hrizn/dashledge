//! Widget package manifest, API version 2.
//!
//! One manifest describes a widget's view and where its data comes from, in one of
//! three trust tiers:
//! 1. `data` and `actions`: declarative HTTP calls the app makes with the stored credential.
//! 2. `connector`: package JavaScript run in an isolated JavaScriptCore context whose
//!    network reaches only the connection address and the hosts declared here.
//! 3. `collector`: a Node program with full access. Only packages bundled with the app
//!    may declare one.
//!
//! Every package view runs in a sandboxed frame. Rust is the single validator: the
//! settings UI receives the normalized manifest from the commands that read packages.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub const API_VERSION: u64 = 2;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub api_version: u64,
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub icon: String,
    pub view: View,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Sources>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<DisplayName>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data: Vec<DataPoll>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<Action>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector: Option<Connector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collector: Option<Collector>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Viewport {
    /// Rendered at the display's real size when the widget fills the page.
    #[default]
    Native,
    /// Rendered on the 1920 × 540 reference canvas and scaled.
    Reference,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct View {
    pub entry: String,
    #[serde(default)]
    pub viewport: Viewport,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Auth {
    Bearer,
    EmbyToken,
    PveToken,
    None,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AddressMode {
    /// Requests are relative to the full address, path included.
    #[default]
    Path,
    /// Requests use only the address's origin.
    Origin,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sources {
    pub min: u8,
    pub max: u8,
    pub auth: Auth,
    #[serde(default)]
    pub address: AddressMode,
    /// Routes the Test button requests, relative to the address.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub test: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address_placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayName {
    /// Dot path into the widget's data where the server reports its own name.
    pub server_field: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataPoll {
    pub id: String,
    pub path: String,
    pub every: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Post,
    Put,
    Delete,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    pub id: String,
    pub method: Method,
    /// Relative route. `{name}` placeholders are filled from the view's arguments.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connector {
    pub entry: String,
    /// Origins the connector may reach besides the connection address.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<String>,
    /// Bytes of key-value storage.
    #[serde(default = "default_storage")]
    pub storage: u32,
}
fn default_storage() -> u32 {
    64 * 1024
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Collector {
    pub entry: String,
    /// Files the collector writes that the view may load: `snapshot.js`, `art/*.jpg`.
    pub outputs: Vec<String>,
    /// stdin commands the view may send through the host.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<String>,
}

/// Where a manifest came from decides what it may declare.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Bundled,
    Installed,
}

/// Highest tier a manifest uses, for the install sheet and the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    View,
    Declarative,
    Connector,
    Collector,
}

impl Manifest {
    pub fn tier(&self) -> Tier {
        if self.collector.is_some() {
            Tier::Collector
        } else if self.connector.is_some() {
            Tier::Connector
        } else if !self.data.is_empty() || !self.actions.is_empty() {
            Tier::Declarative
        } else {
            Tier::View
        }
    }
}

fn fail<T>(message: impl Into<String>) -> Result<T, String> {
    Err(message.into())
}

fn text(value: &str, field: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return fail(format!("{field} must be 1–{max} characters."));
    }
    Ok(())
}

fn optional_text(value: &Option<String>, field: &str, max: usize) -> Result<(), String> {
    value.as_deref().map_or(Ok(()), |v| text(v, field, max))
}

fn name(value: &str, field: &str) -> Result<(), String> {
    let mut chars = value.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_lowercase())
        || value.len() > 32
        || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return fail(format!("{field} “{value}” must start with a lowercase letter and use letters, digits, - or _."));
    }
    Ok(())
}

fn segment(part: &str, glob: bool) -> bool {
    let body = if glob { part.strip_prefix('*').unwrap_or(part) } else { part };
    !part.is_empty()
        && !part.starts_with('.')
        && body.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

/// A file inside the package: relative, no `..`, no hidden components.
pub fn package_path(path: &str, field: &str) -> Result<(), String> {
    let parts: Vec<_> = path.split('/').collect();
    if path.len() > 200 || parts.len() > 8 || !parts.iter().all(|p| segment(p, false)) {
        return fail(format!("{field} “{path}” must be a relative path inside the package."));
    }
    Ok(())
}

fn file_with(path: &str, field: &str, extensions: &[&str]) -> Result<(), String> {
    package_path(path, field)?;
    if !extensions.iter().any(|e| path.to_ascii_lowercase().ends_with(e)) {
        return fail(format!("{field} must be a {} file.", extensions.join(" or ")));
    }
    Ok(())
}

/// An output pattern: a package-style path whose last component may start with `*`.
fn output(pattern: &str) -> Result<(), String> {
    let parts: Vec<_> = pattern.split('/').collect();
    let (last, dirs) = parts.split_last().unwrap();
    if pattern.len() > 120
        || parts.len() > 3
        || !dirs.iter().all(|p| segment(p, false))
        || !segment(last, true)
        || last.matches('*').count() > 1
    {
        return fail(format!("Collector output “{pattern}” must be a file or `dir/*.ext` pattern."));
    }
    Ok(())
}

/// A request route relative to the connection address. `{name}` placeholders are
/// allowed only where `placeholders` is true; a query string only in data and Test routes.
fn route(route: &str, field: &str, placeholders: bool, query: bool) -> Result<(), String> {
    let (path, q) = route.split_once('?').unwrap_or((route, ""));
    let path_ok = !path.starts_with('/')
        && !path.contains("//")
        && path.split('/').all(|p| p != ".." && p != ".")
        && path.bytes().all(|b| {
            b.is_ascii_alphanumeric() || b"-_./~".contains(&b) || (placeholders && b"{}".contains(&b))
        });
    let query_ok = q.is_empty()
        || (query && q.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.=&,:%".contains(&b)));
    let braces_ok = !placeholders || placeholder_names(path).is_some();
    if route.len() > 200 || !path_ok || !query_ok || !braces_ok {
        return fail(format!("{field} “{route}” must be a route relative to the connection address."));
    }
    Ok(())
}

/// Names of the `{name}` placeholders in a route, or `None` if the braces are malformed.
pub fn placeholder_names(path: &str) -> Option<Vec<String>> {
    let mut names = Vec::new();
    let mut rest = path;
    while let Some(open) = rest.find(['{', '}']) {
        if rest.as_bytes()[open] == b'}' {
            return None;
        }
        let after = &rest[open + 1..];
        let close = after.find('}')?;
        let inner = &after[..close];
        if inner.is_empty() || inner.contains('{') || name(inner, "Placeholder").is_err() {
            return None;
        }
        names.push(inner.to_string());
        rest = &after[close + 1..];
    }
    Some(names)
}

/// A host a connector may reach: `https://host[:port]` or `http://host[:port]`, nothing else.
pub fn host_origin(host: &str) -> Result<String, String> {
    let invalid = || format!("Connector host “{host}” must be an origin such as https://api.example.com.");
    let url = reqwest::Url::parse(host).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || host.trim_end_matches('/').len() != url.origin().ascii_serialization().len()
    {
        return Err(invalid());
    }
    Ok(url.origin().ascii_serialization())
}

fn unique<'a>(ids: impl Iterator<Item = &'a str>, field: &str) -> Result<(), String> {
    let mut seen = HashSet::new();
    for id in ids {
        name(id, field)?;
        if !seen.insert(id) {
            return fail(format!("{field} “{id}” is declared twice."));
        }
    }
    Ok(())
}

/// Parse and check a manifest. `Installed` packages may not declare a collector and
/// must use a `plugin.` ID; `Bundled` ones are the app's own widgets.
pub fn validate(raw: &Value, origin: Origin) -> Result<Manifest, String> {
    if raw.get("apiVersion").and_then(Value::as_u64) != Some(API_VERSION) {
        return fail("This widget.json is not an API version 2 package.");
    }
    let mut manifest: Manifest =
        serde_json::from_value(raw.clone()).map_err(|e| format!("Invalid widget.json: {e}"))?;

    match origin {
        Origin::Installed => {
            let rest = manifest.id.strip_prefix("plugin.").unwrap_or("");
            if rest.is_empty()
                || rest.len() > 72
                || !rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-.".contains(&b))
            {
                return fail("A package ID must begin with plugin. and use lowercase letters, digits, - or .");
            }
            if manifest.collector.is_some() {
                return fail("Installed packages can’t run a collector. Use a connector, which runs sandboxed.");
            }
        }
        Origin::Bundled => name(&manifest.id, "Bundled widget ID")?,
    }
    text(&manifest.title, "Title", 64)?;
    manifest.title = manifest.title.trim().to_string();
    optional_text(&manifest.description, "Description", 240)?;
    optional_text(&manifest.version, "Version", 32)?;
    optional_text(&manifest.category, "Category", 40)?;
    file_with(&manifest.icon, "Icon", &[".png", ".svg"])?;
    file_with(&manifest.view.entry, "View entry", &[".html"])?;

    if let Some(sources) = &manifest.sources {
        if sources.min > sources.max || sources.max == 0 || sources.max > 20 {
            return fail("Sources need 0 ≤ min ≤ max and 1 ≤ max ≤ 20.");
        }
        if sources.test.len() > 8 {
            return fail("Declare at most 8 Test routes.");
        }
        for test in &sources.test {
            route(test, "Test route", false, true)?;
        }
        optional_text(&sources.address_label, "Address label", 40)?;
        optional_text(&sources.address_placeholder, "Address placeholder", 120)?;
        optional_text(&sources.credential_label, "Credential label", 40)?;
    }
    if let Some(display) = &manifest.display_name {
        let parts: Vec<_> = display.server_field.split('.').collect();
        if parts.len() > 6
            || !parts.iter().all(|p| {
                !p.is_empty() && p.len() <= 64 && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
        {
            return fail("displayName.serverField must be a dot path such as system.hostname.");
        }
    }

    let needs_connection = !manifest.data.is_empty() || !manifest.actions.is_empty();
    if needs_connection && manifest.sources.as_ref().is_none_or(|s| s.max == 0) {
        return fail("Data and actions need a connection: declare sources.");
    }
    if manifest.data.len() > 16 || manifest.actions.len() > 16 {
        return fail("Declare at most 16 data polls and 16 actions.");
    }
    unique(manifest.data.iter().map(|d| d.id.as_str()), "Data ID")?;
    for poll in &manifest.data {
        route(&poll.path, "Data route", false, true)?;
        if !(2..=3600).contains(&poll.every) {
            return fail(format!("Data “{}” must poll every 2–3600 seconds.", poll.id));
        }
    }
    unique(manifest.actions.iter().map(|a| a.id.as_str()), "Action ID")?;
    for action in &manifest.actions {
        route(&action.path, "Action route", true, false)?;
        if let Some(body) = &action.body {
            if !body.is_object() || body.to_string().len() > 4096 {
                return fail(format!("Action “{}” body must be a JSON object up to 4 KiB.", action.id));
            }
        }
    }

    if manifest.connector.is_some() && manifest.collector.is_some() {
        return fail("Declare a connector or a collector, not both.");
    }
    if let Some(connector) = &mut manifest.connector {
        file_with(&connector.entry, "Connector entry", &[".js"])?;
        if connector.hosts.len() > 8 {
            return fail("A connector may declare at most 8 hosts.");
        }
        connector.hosts = connector.hosts.iter().map(|h| host_origin(h)).collect::<Result<_, _>>()?;
        if connector.storage > 1024 * 1024 {
            return fail("Connector storage is limited to 1 MiB.");
        }
    }
    if let Some(collector) = &manifest.collector {
        file_with(&collector.entry, "Collector entry", &[".mjs", ".js"])?;
        if collector.outputs.is_empty() || collector.outputs.len() > 12 {
            return fail("A collector must declare 1–12 outputs.");
        }
        for pattern in &collector.outputs {
            output(pattern)?;
        }
        unique(collector.commands.iter().map(String::as_str), "Collector command")?;
    }
    Ok(manifest)
}

/// Does `file`, requested by a view, match one of a collector's output patterns?
pub fn matches_output(patterns: &[String], file: &str) -> bool {
    patterns.iter().any(|pattern| {
        let (p_dir, p_name) = pattern.rsplit_once('/').map_or(("", pattern.as_str()), |(d, n)| (d, n));
        let (f_dir, f_name) = file.rsplit_once('/').map_or(("", file), |(d, n)| (d, n));
        p_dir == f_dir
            && match p_name.strip_prefix('*') {
                Some(suffix) => {
                    f_name.len() > suffix.len() && f_name.ends_with(suffix) && segment(f_name, false)
                }
                None => p_name == f_name,
            }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn installed() -> Value {
        json!({
            "apiVersion": 2, "id": "plugin.home-status", "title": "Home status",
            "icon": "icon.png", "view": {"entry": "index.html"},
            "sources": {"min": 1, "max": 1, "auth": "bearer", "test": ["api/status"]},
            "data": [{"id": "status", "path": "api/status?verbose=1", "every": 10}],
            "actions": [{"id": "toggle", "method": "POST", "path": "api/entities/{entity}/toggle", "body": {"source": "dashledge"}}],
            "connector": {"entry": "connector.js", "hosts": ["https://api.example.com"]}
        })
    }
    fn bundled() -> Value {
        json!({
            "apiVersion": 2, "id": "emby", "title": "Emby", "icon": "icon.svg",
            "view": {"entry": "view/index.html", "viewport": "native"},
            "sources": {"min": 1, "max": 1, "auth": "emby-token", "address": "path", "test": ["Sessions"]},
            "displayName": {"serverField": "info.ServerName"},
            "collector": {"entry": "collector/capture.mjs", "outputs": ["snapshot.js", "art/*.jpg"]}
        })
    }
    fn with(mut base: Value, pointer: &str, value: Value) -> Value {
        *base.pointer_mut(pointer).unwrap() = value;
        base
    }

    #[test]
    fn accepts_each_tier_and_reports_it() {
        let m = validate(&installed(), Origin::Installed).unwrap();
        assert_eq!(m.tier(), Tier::Connector);
        assert_eq!(m.connector.unwrap().storage, 64 * 1024);
        let b = validate(&bundled(), Origin::Bundled).unwrap();
        assert_eq!(b.tier(), Tier::Collector);
        let mut declarative = installed();
        declarative.as_object_mut().unwrap().remove("connector");
        assert_eq!(validate(&declarative, Origin::Installed).unwrap().tier(), Tier::Declarative);
        let view_only = json!({"apiVersion": 2, "id": "plugin.clock", "title": "Clock", "icon": "i.svg", "view": {"entry": "index.html"}});
        assert_eq!(validate(&view_only, Origin::Installed).unwrap().tier(), Tier::View);
    }

    #[test]
    fn installed_packages_cannot_run_a_collector_or_take_a_bundled_id() {
        let mut p = bundled();
        p["id"] = json!("plugin.emby-clone");
        assert!(validate(&p, Origin::Installed).unwrap_err().contains("can’t run a collector"));
        assert!(validate(&bundled(), Origin::Installed).is_err());
        assert!(validate(&installed(), Origin::Bundled).is_err(), "bundled IDs have no plugin. prefix");
    }

    #[test]
    fn rejects_wrong_versions_unknown_fields_and_bad_text() {
        assert!(validate(&with(installed(), "/apiVersion", json!(1)), Origin::Installed).is_err());
        let mut extra = installed();
        extra["script"] = json!("alert(1)");
        assert!(validate(&extra, Origin::Installed).is_err());
        assert!(validate(&with(installed(), "/title", json!("  ")), Origin::Installed).is_err());
        assert!(validate(&with(installed(), "/title", json!("x".repeat(65))), Origin::Installed).is_err());
    }

    #[test]
    fn package_files_stay_inside_the_package() {
        for bad in ["../index.html", "/index.html", "view/../../x.html", ".hidden/index.html", "a//b.html", "view\\index.html"] {
            assert!(validate(&with(installed(), "/view/entry", json!(bad)), Origin::Installed).is_err(), "{bad}");
        }
        assert!(validate(&with(installed(), "/icon", json!("icon.gif")), Origin::Installed).is_err());
        assert!(validate(&with(bundled(), "/collector/outputs", json!(["../snapshot.js"])), Origin::Bundled).is_err());
        assert!(validate(&with(bundled(), "/collector/outputs", json!(["art/**.jpg"])), Origin::Bundled).is_err());
    }

    #[test]
    fn connector_hosts_must_be_bare_origins() {
        for bad in ["ftp://example.com", "https://user:pw@example.com", "https://example.com/api", "https://example.com?x=1", "example.com", "file:///etc"] {
            let p = with(installed(), "/connector/hosts", json!([bad]));
            assert!(validate(&p, Origin::Installed).is_err(), "{bad}");
        }
        let p = with(installed(), "/connector/hosts", json!(["https://API.example.com:8443/", "http://10.0.0.2"]));
        assert_eq!(validate(&p, Origin::Installed).unwrap().connector.unwrap().hosts,
            vec!["https://api.example.com:8443", "http://10.0.0.2"]);
    }

    #[test]
    fn routes_are_relative_and_placeholders_only_in_actions() {
        for bad in ["/api/status", "https://evil.example/x", "api/../admin", "api//x"] {
            assert!(validate(&with(installed(), "/data/0/path", json!(bad)), Origin::Installed).is_err(), "{bad}");
        }
        assert!(validate(&with(installed(), "/data/0/path", json!("api/{entity}")), Origin::Installed).is_err());
        assert!(validate(&with(installed(), "/actions/0/path", json!("api/{entity")), Origin::Installed).is_err());
        assert!(validate(&with(installed(), "/actions/0/path", json!("api/x?y=1")), Origin::Installed).is_err());
        assert_eq!(placeholder_names("api/{entity}/x/{state}").unwrap(), ["entity", "state"]);
    }

    #[test]
    fn data_and_actions_need_a_connection_and_unique_ids() {
        let mut p = installed();
        p.as_object_mut().unwrap().remove("sources");
        assert!(validate(&p, Origin::Installed).unwrap_err().contains("need a connection"));
        let p = with(installed(), "/data", json!([{"id": "a", "path": "x", "every": 5}, {"id": "a", "path": "y", "every": 5}]));
        assert!(validate(&p, Origin::Installed).unwrap_err().contains("twice"));
        assert!(validate(&with(installed(), "/data/0/every", json!(1)), Origin::Installed).is_err());
        assert!(validate(&with(installed(), "/actions/0/body", json!([1])), Origin::Installed).is_err());
    }

    #[test]
    fn collector_outputs_match_files_and_patterns_only() {
        let outputs = vec!["snapshot.js".to_string(), "art/*.jpg".to_string()];
        assert!(matches_output(&outputs, "snapshot.js"));
        assert!(matches_output(&outputs, "art/123-abc.jpg"));
        for no in ["art/.jpg", "art/x.png", "previews/x.jpg", "art/sub/x.jpg", "model-actions.json", "art/../x.jpg"] {
            assert!(!matches_output(&outputs, no), "{no}");
        }
    }
}
