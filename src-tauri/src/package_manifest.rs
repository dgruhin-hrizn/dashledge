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
    /// Dashledge capabilities the view may use, shown at install.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permissions: Vec<Permission>,
    /// Per-placement settings, edited in Pages & layouts or from the view's own gear.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settings: Vec<Setting>,
    /// Bundled widgets only: `false` keeps a fresh layout from getting a full-screen
    /// page for this widget. Layouts that already have one keep it.
    #[serde(default = "yes", skip_serializing_if = "Clone::clone")]
    pub page: bool,
}
fn yes() -> bool {
    true
}

/// A Dashledge capability a package view asks for. The dashboard's package bridge
/// refuses every capability the manifest does not declare.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
pub enum Permission {
    /// Per-placement settings delivered in `Dashledge.subscribe` state.
    #[serde(rename = "settings")]
    Settings,
    /// The shared touch keyboard, opened by `Dashledge.keyboard.open()`.
    #[serde(rename = "keyboard")]
    Keyboard,
    /// Dashledge's tokens and reading, list and status styles (`/package-ui.css`).
    #[serde(rename = "ui")]
    Ui,
    /// This Mac's CPU, GPU, memory and network readings.
    #[serde(rename = "mac.metrics")]
    MacMetrics,
    /// Options the view finds at run time, such as accounts on this Mac, for its
    /// `dynamic` settings. The view offers them with `Dashledge.settings.offer()`.
    #[serde(rename = "settings.choices")]
    SettingsChoices,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SettingKind {
    Text,
    Number,
    Toggle,
    Choice,
    /// Several options. The value is a list; `["*"]` means every option, including
    /// ones offered later.
    Multi,
    /// The user's own name for each option of the `choice` or `multi` setting named
    /// by `for`. The value maps option values to names.
    Names,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Setting {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: SettingKind,
    /// Filled in by the validator when the manifest leaves it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<SettingOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
    /// A `choice` or `multi` setting whose options the view offers at run time
    /// (`settings.choices` permission) instead of listing them here.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dynamic: bool,
    /// For a `names` setting: the `choice` or `multi` setting whose options it names.
    #[serde(default, rename = "for", skip_serializing_if = "Option::is_none")]
    pub for_setting: Option<String>,
}

/// The most options a view may offer for one dynamic setting, and a multi value's length.
pub const MAX_CHOICES: usize = 64;

/// A value a view may offer for a dynamic setting: 1–128 letters, digits or `._:@/-`.
/// `*` is reserved for "every option" in a multi value.
pub fn choice_value(value: &str) -> bool {
    (1..=128).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:@/-".contains(&b))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingOption {
    pub value: String,
    pub label: String,
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
    /// The view follows Dashledge's text and highlight colours (the SDK theme), so
    /// each placement may override them.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub theme: bool,
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
            if !manifest.page {
                return fail("Only bundled widgets get a page of their own, so `page` applies to them only.");
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
    let mut granted = HashSet::new();
    for permission in &manifest.permissions {
        if !granted.insert(*permission) {
            return fail("A permission is declared twice.");
        }
    }
    if granted.contains(&Permission::Settings) != !manifest.settings.is_empty() {
        return fail("Declare the settings permission together with at least one setting.");
    }
    if granted.contains(&Permission::SettingsChoices) != manifest.settings.iter().any(|s| s.dynamic) {
        return fail("Declare the settings.choices permission together with at least one dynamic setting.");
    }
    if manifest.settings.len() > 16 {
        return fail("Declare at most 16 settings.");
    }
    unique(manifest.settings.iter().map(|s| s.id.as_str()), "Setting ID")?;
    for index in 0..manifest.settings.len() {
        let (before, rest) = manifest.settings.split_at_mut(index);
        let setting = &mut rest[0];
        if let Some(target) = &setting.for_setting {
            if !before.iter().any(|s| &s.id == target && matches!(s.kind, SettingKind::Choice | SettingKind::Multi)) {
                return fail(format!("Setting “{}” must name an earlier choice or multi setting in `for`.", setting.id));
            }
        }
        normalize_setting(setting)?;
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
        // These names are the bridge's own messages, so a collector can't take them.
        if let Some(reserved) = collector.commands.iter().find(|c| c.as_str() == "action") {
            return fail(format!("Collector command “{reserved}” is reserved."));
        }
    }
    Ok(manifest)
}

/// Check one setting against its type and fill in its default.
fn normalize_setting(setting: &mut Setting) -> Result<(), String> {
    let id = setting.id.clone();
    text(&setting.label, &format!("Setting “{id}” label"), 48)?;
    setting.label = setting.label.trim().to_string();
    optional_text(&setting.help, &format!("Setting “{id}” help"), 160)?;
    let numeric = setting.min.is_some() || setting.max.is_some() || setting.step.is_some();
    if setting.kind != SettingKind::Number && numeric {
        return fail(format!("Setting “{id}”: min, max and step apply to number settings."));
    }
    if !matches!(setting.kind, SettingKind::Text | SettingKind::Names) && setting.max_length.is_some() {
        return fail(format!("Setting “{id}”: maxLength applies to text and names settings."));
    }
    let listed = matches!(setting.kind, SettingKind::Choice | SettingKind::Multi);
    if !listed && !setting.options.is_empty() {
        return fail(format!("Setting “{id}”: options apply to choice and multi settings."));
    }
    if !listed && setting.dynamic {
        return fail(format!("Setting “{id}”: only choice and multi settings can be dynamic."));
    }
    if setting.dynamic && !setting.options.is_empty() {
        return fail(format!("Setting “{id}”: a dynamic setting gets its options from the view, not from options."));
    }
    if (setting.kind == SettingKind::Names) != setting.for_setting.is_some() {
        return fail(format!("Setting “{id}”: names settings, and only they, declare `for`."));
    }
    let wrong = || fail(format!("Setting “{id}” has a default that doesn’t fit its type."));
    match setting.kind {
        SettingKind::Text => {
            let limit = setting.max_length.unwrap_or(256);
            if !(1..=1024).contains(&limit) {
                return fail(format!("Setting “{id}”: maxLength must be 1–1024."));
            }
            setting.max_length = Some(limit);
            match setting.default.get_or_insert(Value::String(String::new())) {
                Value::String(v) if v.chars().count() <= limit as usize && !v.chars().any(char::is_control) => {}
                _ => return wrong(),
            }
        }
        SettingKind::Number => {
            let finite = |v: Option<f64>| v.is_none_or(f64::is_finite);
            if !finite(setting.min) || !finite(setting.max) || !finite(setting.step) {
                return fail(format!("Setting “{id}”: min, max and step must be numbers."));
            }
            if setting.min.zip(setting.max).is_some_and(|(min, max)| min > max) || setting.step.is_some_and(|s| s <= 0.0) {
                return fail(format!("Setting “{id}” needs min ≤ max and a positive step."));
            }
            let fallback = setting.min.unwrap_or(0.0).max(f64::MIN).min(setting.max.unwrap_or(f64::MAX));
            let value = setting.default.get_or_insert(serde_json::json!(fallback)).as_f64();
            if !value.is_some_and(|v| setting.min.is_none_or(|m| v >= m) && setting.max.is_none_or(|m| v <= m)) {
                return wrong();
            }
        }
        SettingKind::Toggle => {
            if !setting.default.get_or_insert(Value::Bool(false)).is_boolean() {
                return wrong();
            }
        }
        SettingKind::Choice if setting.dynamic => {
            // Nothing chosen yet is "", and the view decides what that shows.
            match setting.default.get_or_insert(Value::String(String::new())) {
                Value::String(v) if v.is_empty() || choice_value(v) => {}
                _ => return wrong(),
            }
        }
        SettingKind::Choice => {
            let values = static_options(setting)?;
            let first = Value::String(setting.options[0].value.clone());
            if !setting.default.get_or_insert(first).as_str().is_some_and(|v| values.contains(v)) {
                return wrong();
            }
        }
        SettingKind::Multi => {
            let values = if setting.dynamic { HashSet::new() } else { static_options(setting)? };
            let dynamic = setting.dynamic;
            let Some(list) = setting.default.get_or_insert(serde_json::json!(["*"])).as_array() else { return wrong() };
            let mut seen = HashSet::new();
            let every = list.len() == 1 && list[0] == "*";
            if list.len() > MAX_CHOICES
                || (!every
                    && !list.iter().all(|v| {
                        v.as_str().is_some_and(|v| {
                            (if dynamic { choice_value(v) } else { values.contains(v) }) && seen.insert(v.to_string())
                        })
                    }))
            {
                return wrong();
            }
        }
        SettingKind::Names => {
            let limit = setting.max_length.unwrap_or(48);
            if !(1..=128).contains(&limit) {
                return fail(format!("Setting “{id}”: maxLength must be 1–128."));
            }
            setting.max_length = Some(limit);
            let Some(names) = setting.default.get_or_insert(serde_json::json!({})).as_object() else { return wrong() };
            if names.len() > MAX_CHOICES
                || !names.iter().all(|(k, v)| {
                    choice_value(k)
                        && v.as_str().is_some_and(|v| v.chars().count() <= limit as usize && !v.chars().any(char::is_control))
                })
            {
                return wrong();
            }
        }
    }
    Ok(())
}

/// Check a choice or multi setting's listed options; returns their values.
fn static_options(setting: &mut Setting) -> Result<HashSet<String>, String> {
    let id = setting.id.clone();
    if !(2..=24).contains(&setting.options.len()) {
        return fail(format!("Setting “{id}” needs 2–24 options."));
    }
    let mut values = HashSet::new();
    for option in &mut setting.options {
        text(&option.value, &format!("Setting “{id}” option value"), 64)?;
        text(&option.label, &format!("Setting “{id}” option label"), 48)?;
        option.label = option.label.trim().to_string();
        if option.value == "*" || !values.insert(option.value.clone()) {
            return fail(format!("Setting “{id}” lists an option twice or uses the reserved value *."));
        }
    }
    Ok(values)
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

    fn view_only(extra: Value) -> Value {
        let mut raw = json!({"apiVersion": 2, "id": "plugin.caps", "title": "Caps", "icon": "icon.svg", "view": {"entry": "index.html"}});
        for (key, value) in extra.as_object().unwrap() {
            raw[key] = value.clone();
        }
        raw
    }

    #[test]
    fn a_view_may_follow_the_dashledge_theme() {
        let themed = validate(&view_only(json!({"view": {"entry": "index.html", "theme": true}})), Origin::Installed).unwrap();
        assert!(themed.view.theme);
        assert_eq!(serde_json::to_value(&themed).unwrap()["view"]["theme"], json!(true));
        let plain = validate(&view_only(json!({})), Origin::Installed).unwrap();
        assert!(!plain.view.theme);
        assert!(serde_json::to_value(&plain).unwrap()["view"].get("theme").is_none());
        assert!(validate(&view_only(json!({"view": {"entry": "index.html", "theme": "yes"}})), Origin::Installed).is_err());
    }

    #[test]
    fn capability_fixture_validates_with_defaults_filled() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/capabilities-package/widget.json");
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let manifest = validate(&raw, Origin::Installed).unwrap();
        assert_eq!(manifest.permissions, [Permission::Settings, Permission::Keyboard, Permission::Ui, Permission::MacMetrics]);
        let metric = manifest.settings.iter().find(|s| s.id == "metric").unwrap();
        assert_eq!(metric.default, Some(json!("cpu")));
        let label = manifest.settings.iter().find(|s| s.id == "label").unwrap();
        assert_eq!(label.max_length, Some(40));
        let json = serde_json::to_value(&manifest).unwrap();
        assert_eq!(json["permissions"], json!(["settings", "keyboard", "ui", "mac.metrics"]));
    }

    #[test]
    fn rejects_unknown_or_repeated_permissions() {
        assert!(validate(&view_only(json!({"permissions": ["camera"]})), Origin::Installed).is_err());
        assert!(validate(&view_only(json!({"permissions": ["keyboard", "keyboard"]})), Origin::Installed).is_err());
        assert!(validate(&view_only(json!({"permissions": ["keyboard", "ui"]})), Origin::Installed).is_ok());
    }

    #[test]
    fn settings_and_their_permission_come_together() {
        let setting = json!([{"id": "unit", "label": "Unit", "type": "toggle"}]);
        assert!(validate(&view_only(json!({"settings": setting})), Origin::Installed).is_err());
        assert!(validate(&view_only(json!({"permissions": ["settings"]})), Origin::Installed).is_err());
        let ok = validate(&view_only(json!({"permissions": ["settings"], "settings": setting})), Origin::Installed).unwrap();
        assert_eq!(ok.settings[0].default, Some(json!(false)));
    }

    #[test]
    fn setting_defaults_must_fit_their_type() {
        let check = |setting: Value| validate(&view_only(json!({"permissions": ["settings"], "settings": [setting]})), Origin::Installed);
        assert!(check(json!({"id": "n", "label": "N", "type": "number", "min": 1, "max": 5, "default": 9})).is_err());
        assert!(check(json!({"id": "n", "label": "N", "type": "number", "min": 5, "max": 1})).is_err());
        assert_eq!(check(json!({"id": "n", "label": "N", "type": "number", "min": 2})).unwrap().settings[0].default, Some(json!(2.0)));
        assert!(check(json!({"id": "c", "label": "C", "type": "choice", "options": [{"value": "a", "label": "A"}, {"value": "b", "label": "B"}], "default": "z"})).is_err());
        assert!(check(json!({"id": "c", "label": "C", "type": "choice", "options": [{"value": "a", "label": "A"}]})).is_err());
        assert!(check(json!({"id": "t", "label": "T", "type": "text", "maxLength": 3, "default": "long"})).is_err());
        assert!(check(json!({"id": "t", "label": "T", "type": "toggle", "options": [{"value": "a", "label": "A"}]})).is_err());
        assert!(check(json!({"id": "t", "label": "Bad\u{0007}label", "type": "toggle"})).is_err());
        assert!(check(json!({"id": "Bad", "label": "T", "type": "toggle"})).is_err());
    }

    fn dynamic(settings: Value) -> Result<Manifest, String> {
        validate(&view_only(json!({"permissions": ["settings", "settings.choices"], "settings": settings})), Origin::Installed)
    }

    #[test]
    fn dynamic_settings_need_their_permission_and_no_listed_options() {
        let accounts = json!([{"id": "accounts", "label": "Accounts", "type": "multi", "dynamic": true}]);
        let m = dynamic(accounts.clone()).unwrap();
        assert_eq!(m.settings[0].default, Some(json!(["*"])));
        assert_eq!(serde_json::to_value(&m).unwrap()["permissions"], json!(["settings", "settings.choices"]));
        // The permission and a dynamic setting come together.
        assert!(validate(&view_only(json!({"permissions": ["settings"], "settings": accounts})), Origin::Installed).is_err());
        let fixed = json!([{"id": "unit", "label": "Unit", "type": "toggle"}]);
        assert!(dynamic(fixed).unwrap_err().contains("settings.choices"));
        // Options come from the view, so listing them too is refused.
        assert!(dynamic(json!([{"id": "a", "label": "A", "type": "multi", "dynamic": true,
            "options": [{"value": "x", "label": "X"}, {"value": "y", "label": "Y"}]}])).is_err());
        assert!(dynamic(json!([{"id": "a", "label": "A", "type": "toggle", "dynamic": true}])).is_err());
        let pin = dynamic(json!([{"id": "pin", "label": "Pin", "type": "choice", "dynamic": true}])).unwrap();
        assert_eq!(pin.settings[0].default, Some(json!("")));
    }

    #[test]
    fn multi_and_names_defaults_fit_their_shape() {
        let multi = |default: Value| dynamic(json!([{"id": "a", "label": "A", "type": "multi", "dynamic": true, "default": default}]));
        assert!(multi(json!(["claude:main", "codex:work_2"])).is_ok());
        for bad in [json!("claude:main"), json!(["a", "a"]), json!(["*", "a"]), json!(["has space"]), json!([""])] {
            assert!(multi(bad.clone()).is_err(), "{bad}");
        }
        let fixed = json!([{"id": "a", "label": "A", "type": "multi", "default": ["x"],
            "options": [{"value": "x", "label": "X"}, {"value": "y", "label": "Y"}]}]);
        assert!(validate(&view_only(json!({"permissions": ["settings"], "settings": fixed})), Origin::Installed).is_ok());
        let names = |extra: Value| {
            let mut n = json!({"id": "names", "label": "Names", "type": "names", "for": "a"});
            for (k, v) in extra.as_object().unwrap() { n[k] = v.clone(); }
            dynamic(json!([{"id": "a", "label": "A", "type": "multi", "dynamic": true}, n]))
        };
        let ok = names(json!({})).unwrap();
        assert_eq!(ok.settings[1].default, Some(json!({})));
        assert_eq!(ok.settings[1].max_length, Some(48));
        assert_eq!(serde_json::to_value(&ok).unwrap()["settings"][1]["for"], json!("a"));
        assert!(names(json!({"default": {"claude:main": "Work"}})).is_ok());
        assert!(names(json!({"default": {"bad key": "Work"}})).is_err());
        assert!(names(json!({"maxLength": 4, "default": {"a": "Too long"}})).is_err());
        assert!(names(json!({"for": "missing"})).is_err());
        // `for` must point back at a listed setting declared before it.
        assert!(dynamic(json!([{"id": "names", "label": "Names", "type": "names", "for": "a"},
            {"id": "a", "label": "A", "type": "multi", "dynamic": true}])).is_err());
        assert!(dynamic(json!([{"id": "a", "label": "A", "type": "multi", "dynamic": true},
            {"id": "t", "label": "T", "type": "text", "for": "a"}])).is_err());
    }

    #[test]
    fn choice_values_are_plain_identifiers() {
        for ok in ["claude:main", "codex:work_2", "user@example.com", "a/b.c-d"] {
            assert!(choice_value(ok), "{ok}");
        }
        for bad in ["", "*", "has space", "line\nbreak", &"x".repeat(129)] {
            assert!(!choice_value(bad), "{bad}");
        }
    }

    #[test]
    fn page_is_on_by_default_and_only_bundled_widgets_turn_it_off() {
        let b = validate(&bundled(), Origin::Bundled).unwrap();
        assert!(b.page);
        assert!(serde_json::to_value(&b).unwrap().get("page").is_none(), "the default isn't written out");
        let mut off = bundled();
        off["page"] = json!(false);
        let m = validate(&off, Origin::Bundled).unwrap();
        assert!(!m.page);
        assert_eq!(serde_json::to_value(&m).unwrap()["page"], json!(false));
        off["page"] = json!("no");
        assert!(validate(&off, Origin::Bundled).is_err());
        let mut installed_off = installed();
        installed_off["page"] = json!(false);
        assert!(validate(&installed_off, Origin::Installed).unwrap_err().contains("bundled"));
        let mut installed_on = installed();
        installed_on["page"] = json!(true);
        assert!(validate(&installed_on, Origin::Installed).is_ok());
    }

    #[test]
    fn collector_commands_cannot_take_bridge_names() {
        let commands = |list: Value| { let mut p = bundled(); p["collector"]["commands"] = list; validate(&p, Origin::Bundled) };
        assert!(commands(json!(["action"])).is_err());
        assert!(commands(json!(["refresh"])).is_ok());
    }
}
