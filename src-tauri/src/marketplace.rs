//! The Marketplace: reviewed plugins from Dashledge's registry.
//!
//! The registry (github.com/dgruhin-hrizn/dashledge-plugins) publishes a catalog signed
//! with a key only its CI holds. This module trusts a catalog only when a pinned public
//! key verifies it and its sequence isn't lower than one this Mac has seen, downloads
//! packages, icons and screenshots only from the registry's own folder, checks each
//! against the sha256 the catalog gives, and installs a package only from bytes it
//! verified itself. The settings UI never hands it package bytes or URLs.
use crate::package_store::{self, PackageInfo};
use dashledge_package_core::{catalog::{self, Catalog}, grants::{grants, Grant}};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

/// Where the registry publishes, and the public keys its catalog may be signed with.
/// More than one key lets the registry rotate without breaking older apps. These are
/// public keys: they only verify. The private key lives in the registry's CI secret
/// `CATALOG_SIGNING_KEY` and never in this repository.
const REGISTRY: &str = "https://dgruhin-hrizn.github.io/dashledge-plugins/v1/";
const KEYS: &[&str] = &[
    // 2026-11-27, generated with `dashledge-package keygen`.
    "gBAtUvk7+SzrYp1+tWNfGXRFI94wqe0BJx5+RbnyWNo=",
];

const MAX_CATALOG: usize = 4 * 1024 * 1024;
const MAX_IMAGE: usize = 1024 * 1024;
const KEEP_DOWNLOADS: usize = 4;

/// A registry to talk to. The app uses the pinned one; tests serve their own.
#[derive(Clone)]
pub struct Registry {
    pub base: Url,
    pub keys: Vec<String>,
}

impl Registry {
    pub fn pinned() -> Result<Registry, String> {
        if let Some(registry) = dev_registry() {
            return Ok(registry);
        }
        if KEYS.is_empty() {
            return Err("The Marketplace isn’t available in this build yet.".into());
        }
        Ok(Registry { base: Url::parse(REGISTRY).map_err(|e| e.to_string())?, keys: KEYS.iter().map(|k| k.to_string()).collect() })
    }

    /// A file the catalog names, by its path relative to the catalog. Anything that
    /// would leave the registry's folder is refused.
    fn url(&self, path: &str) -> Result<Url, String> {
        let safe = !path.is_empty()
            && path.len() <= 300
            && !path.starts_with('/')
            && path.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
            && path.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._/".contains(&b));
        let url = self.base.join(path).ok().filter(|u| safe && u.as_str().starts_with(self.base.as_str()));
        url.ok_or_else(|| format!("The catalog names a file outside the registry: {path}"))
    }
}

/// What this Mac remembers about the Marketplace, in `<app_data>/marketplace.json`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// The highest catalog sequence seen. An older catalog is refused.
    #[serde(default)]
    pub sequence: u64,
    /// Install updates that add no grants without asking.
    #[serde(default = "yes")]
    pub auto_update: bool,
    /// Packages installed from the Marketplace, by ID.
    #[serde(default)]
    pub installed: BTreeMap<String, Installed>,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub version: String,
    pub sha256: String,
    pub installed_at: u64,
}

/// Debug builds only: a test registry from `DASHLEDGE_REGISTRY` (its `v1/` URL) and
/// `DASHLEDGE_REGISTRY_KEY` (its base64 public key), for trying a registry or a catalog
/// change in `npm run dev`. Release builds always use the pinned registry.
fn dev_registry() -> Option<Registry> {
    #[cfg(debug_assertions)]
    {
        dev_registry_from(std::env::var("DASHLEDGE_REGISTRY").ok(), std::env::var("DASHLEDGE_REGISTRY_KEY").ok())
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn dev_registry_from(url: Option<String>, key: Option<String>) -> Option<Registry> {
    let url = url.filter(|u| !u.is_empty())?;
    let key = key.filter(|k| !k.is_empty())?;
    let base = Url::parse(&if url.ends_with('/') { url } else { url + "/" }).ok()?;
    Some(Registry { base, keys: vec![key] })
}

/// A test registry keeps its own record, so its catalog sequence never blocks the real one.
pub fn record_path(dir: &Path) -> PathBuf {
    dir.join(if dev_registry().is_some() { "marketplace-dev.json" } else { "marketplace.json" })
}

pub fn load(dir: &Path) -> Record {
    fs::read(record_path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Record { auto_update: true, ..Record::default() })
}

pub fn save(dir: &Path, record: &Record) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = record_path(dir);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

static LOCK: Mutex<()> = Mutex::new(());
/// The last verified catalog per registry, and verified package bytes by registry, ID and version.
static CATALOGS: Mutex<Option<HashMap<String, Catalog>>> = Mutex::new(None);
static DOWNLOADS: Mutex<Vec<(String, Vec<u8>)>> = Mutex::new(Vec::new());

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn client(timeout: u64) -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(timeout))
        .user_agent(concat!("Dashledge/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

/// GET a registry file, refusing redirects and anything larger than `max`.
async fn get(url: Url, max: usize, timeout: u64) -> Result<Vec<u8>, String> {
    let unreachable = |_| "Could not reach the Marketplace. Check this Mac’s connection and try again.".to_string();
    let mut res = client(timeout)?.get(url).send().await.map_err(unreachable)?;
    if !res.status().is_success() {
        return Err(format!("The Marketplace answered {}.", res.status()));
    }
    if res.content_length().is_some_and(|n| n > max as u64) {
        return Err("A Marketplace download is larger than allowed.".into());
    }
    let mut out = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(unreachable)? {
        out.extend_from_slice(&chunk);
        if out.len() > max {
            return Err("A Marketplace download is larger than allowed.".into());
        }
    }
    Ok(out)
}

/// Download and verify the catalog, remembering its sequence.
pub async fn fetch_catalog(registry: &Registry, dir: &Path) -> Result<Catalog, String> {
    let bytes = get(registry.url("catalog.json")?, MAX_CATALOG, 20).await?;
    let signature = get(registry.url("catalog.json.sig")?, 1024, 20).await?;
    let signature = String::from_utf8(signature).map_err(|_| "The catalog signature isn't valid.")?;
    let keys: Vec<&str> = registry.keys.iter().map(String::as_str).collect();
    let _guard = LOCK.lock().unwrap();
    let mut record = load(dir);
    let catalog = catalog::verify(&bytes, &signature, &keys, record.sequence)?;
    if catalog.sequence > record.sequence {
        record.sequence = catalog.sequence;
        save(dir, &record)?;
    }
    CATALOGS.lock().unwrap().get_or_insert_with(HashMap::new).insert(registry.base.to_string(), catalog.clone());
    Ok(catalog)
}

/// The catalog verified most recently in this session, else a fresh one.
pub async fn catalog_for(registry: &Registry, dir: &Path) -> Result<Catalog, String> {
    let cached = CATALOGS.lock().unwrap().as_ref().and_then(|c| c.get(registry.base.as_str()).cloned());
    match cached {
        Some(catalog) => Ok(catalog),
        None => fetch_catalog(registry, dir).await,
    }
}

fn download_key(registry: &Registry, id: &str, version: &str) -> String {
    format!("{}|{id}|{version}", registry.base)
}

/// The package bytes for one catalog version, checked against its sha256.
async fn package(registry: &Registry, catalog: &Catalog, id: &str, version: &str) -> Result<Vec<u8>, String> {
    let plugin = catalog.plugin(id).ok_or("This plugin isn’t in the Marketplace.")?;
    let entry = plugin.versions.iter().find(|v| v.version == version).ok_or("That version isn’t in the Marketplace.")?;
    if let Some(revoked) = catalog.revoked(id, version) {
        return Err(format!("This version was pulled from the Marketplace: {}", revoked.reason));
    }
    if catalog.expired(now()) {
        return Err("The Marketplace catalog is out of date. Try again later.".into());
    }
    let key = download_key(registry, id, version);
    if let Some((_, bytes)) = DOWNLOADS.lock().unwrap().iter().find(|(k, _)| *k == key) {
        return Ok(bytes.clone());
    }
    let bytes = get(registry.url(&entry.path)?, package_store::MAX_PACKAGE, 120).await?;
    if catalog::sha256_hex(&bytes) != entry.sha256 {
        return Err("The downloaded package doesn’t match the Marketplace catalog, so it wasn’t installed.".into());
    }
    let mut downloads = DOWNLOADS.lock().unwrap();
    downloads.retain(|(k, _)| *k != key);
    downloads.push((key, bytes.clone()));
    while downloads.len() > KEEP_DOWNLOADS {
        downloads.remove(0);
    }
    Ok(bytes)
}

fn refuse_unpacked(id: &str) -> Result<(), String> {
    if package_store::lookup(id).is_some_and(|(p, _)| p.origin == "unpacked") {
        return Err("An unpacked folder with this ID is loaded in Widget Studio. Remove it there first.".into());
    }
    Ok(())
}

/// What the install sheet shows for a Marketplace version, including the grants it adds
/// to an installed version.
pub async fn inspect(registry: &Registry, dir: &Path, id: &str, version: &str) -> Result<Value, String> {
    refuse_unpacked(id)?;
    let catalog = catalog_for(registry, dir).await?;
    let bytes = package(registry, &catalog, id, version).await?;
    let (raw, files) = package_store::extract(&bytes)?;
    let manifest = package_store::check_for_this_app(&raw, &files)?;
    if manifest.id != id || manifest.version.as_deref() != Some(version) {
        return Err("The downloaded package isn’t the version the Marketplace lists.".into());
    }
    let mut sheet = package_store::sheet_info(manifest, &files, package_store::lookup_installed)?;
    sheet["marketplace"] = json!({"id": id, "version": version});
    Ok(sheet)
}

/// Install a Marketplace version from bytes verified here, and remember it.
pub async fn install(registry: &Registry, dir: &Path, root: &Path, id: &str, version: &str) -> Result<PackageInfo, String> {
    refuse_unpacked(id)?;
    let catalog = catalog_for(registry, dir).await?;
    let bytes = package(registry, &catalog, id, version).await?;
    let info = package_store::install_bytes(root, &bytes)?;
    if info.manifest.id != id {
        return Err("The downloaded package isn’t the plugin the Marketplace lists.".into());
    }
    let _guard = LOCK.lock().unwrap();
    let mut record = load(dir);
    record.installed.insert(id.to_string(), Installed { version: version.to_string(), sha256: catalog::sha256_hex(&bytes), installed_at: now() });
    save(dir, &record)?;
    Ok(info)
}

/// Forget that a package came from the Marketplace, after it is removed or replaced
/// from a file.
pub fn forget(dir: &Path, id: &str) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap();
    let mut record = load(dir);
    if record.installed.remove(id).is_some() {
        save(dir, &record)?;
    }
    Ok(())
}

/// An icon or screenshot the catalog names, as a data URI.
pub async fn image(registry: &Registry, dir: &Path, path: &str) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let catalog = catalog_for(registry, dir).await?;
    let asset = catalog
        .plugins
        .iter()
        .flat_map(|p| std::iter::once(&p.icon).chain(&p.screenshots))
        .find(|a| a.path == path)
        .ok_or("The catalog doesn’t list that image.")?;
    let bytes = get(registry.url(&asset.path)?, MAX_IMAGE, 30).await?;
    if catalog::sha256_hex(&bytes) != asset.sha256 {
        return Err("A Marketplace image doesn’t match the catalog.".into());
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if path.ends_with(".svg") && std::str::from_utf8(&bytes).is_ok_and(|s| s.contains("<svg")) {
        "image/svg+xml"
    } else {
        return Err("A Marketplace image isn’t a PNG, JPEG or SVG.".into());
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// The newest version this app can run that hasn't been pulled.
pub fn newest_for_this_app<'a>(catalog: &'a Catalog, plugin: &'a catalog::Plugin) -> Option<&'a catalog::Version> {
    let app = semver::Version::parse(env!("CARGO_PKG_VERSION")).ok()?;
    plugin.versions.iter().find(|v| {
        catalog.revoked(&plugin.id, &v.version).is_none()
            && v.min_app_version.as_deref().and_then(|m| semver::Version::parse(m).ok()).map_or(true, |m| m <= app)
    })
}

/// A package as this Mac has it: its origin, version and grants.
pub struct Here {
    pub origin: String,
    pub version: String,
    pub grants: BTreeSet<Grant>,
}

fn newer(next: &str, current: &str) -> bool {
    semver::Version::parse(next).ok() > semver::Version::parse(current).ok()
}

/// The catalog as the Marketplace tab shows it: each plugin with what this Mac has,
/// the update it can take and the grants that update would add.
pub fn view(catalog: &Catalog, record: &Record, installed: impl Fn(&str) -> Option<Here>) -> Value {
    let expired = catalog.expired(now());
    let plugins: Vec<Value> = catalog
        .plugins
        .iter()
        .map(|plugin| {
            let available = newest_for_this_app(catalog, plugin);
            let here = installed(&plugin.id);
            let from_marketplace = here.as_ref().is_some_and(|h| {
                h.origin == "installed" && record.installed.get(&plugin.id).is_some_and(|i| i.version == h.version)
            });
            let pulled = here.as_ref().and_then(|h| catalog.revoked(&plugin.id, &h.version)).map(|r| r.reason.clone());
            let (update, adds) = match (&here, available) {
                (Some(h), Some(next)) if from_marketplace && newer(&next.version, &h.version) => {
                    let adds: Vec<&Grant> = next.grants.iter().filter(|g| !h.grants.contains(g)).collect();
                    (Some(next.version.clone()), adds)
                }
                _ => (None, Vec::new()),
            };
            json!({
                "id": plugin.id, "publisher": plugin.publisher, "title": plugin.title, "summary": plugin.summary,
                "category": plugin.category, "homepage": plugin.homepage, "license": plugin.license,
                "icon": plugin.icon.path, "screenshots": plugin.screenshots.iter().map(|s| &s.path).collect::<Vec<_>>(),
                "versions": plugin.versions, "available": available.map(|v| &v.version),
                "installed": here.as_ref().map(|h| &h.version),
                "origin": here.as_ref().map(|h| if from_marketplace { "marketplace" } else { h.origin.as_str() }),
                "update": update, "updateAdds": adds, "pulled": pulled,
            })
        })
        .collect();
    json!({"sequence": catalog.sequence, "expired": expired, "autoUpdate": record.auto_update, "plugins": plugins})
}

/// What a check did: packages updated on their own, updates that wait for approval
/// because they add grants (or automatic updates are off), and pulled versions now off.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    pub updated: Vec<String>,
    pub needs_approval: Vec<String>,
    pub pulled: Vec<String>,
}

/// Fetch the catalog, turn off installed versions it pulls (and back on ones it no longer
/// pulls), and install updates that add no grants when automatic updates are on.
pub async fn check(registry: &Registry, dir: &Path, root: &Path) -> Result<Checked, String> {
    let catalog = fetch_catalog(registry, dir).await?;
    let mut out = Checked::default();
    let installed = package_store::read_root(root, dashledge_package_core::manifest::Origin::Installed);
    let mut disabled = BTreeMap::new();
    for info in &installed {
        let Some(version) = &info.manifest.version else { continue };
        if let Some(revoked) = catalog.revoked(&info.manifest.id, version) {
            disabled.insert(info.manifest.id.clone(), package_store::Disabled { version: version.clone(), reason: revoked.reason.clone() });
            out.pulled.push(info.manifest.id.clone());
        }
    }
    package_store::write_disabled(root, &disabled)?;
    if catalog.expired(now()) {
        return Ok(out);
    }
    let record = load(dir);
    for (id, from) in &record.installed {
        let Some(info) = installed.iter().find(|i| &i.manifest.id == id) else { continue };
        if info.manifest.version.as_deref() != Some(from.version.as_str()) {
            continue;
        }
        let Some(next) = catalog.plugin(id).and_then(|p| newest_for_this_app(&catalog, p)) else { continue };
        if !newer(&next.version, &from.version) {
            continue;
        }
        let have = grants(&info.manifest);
        if !record.auto_update || next.grants.iter().any(|g| !have.contains(g)) {
            out.needs_approval.push(id.clone());
        } else if install(registry, dir, root, id, &next.version).await.is_ok() {
            out.updated.push(id.clone());
        } else {
            out.needs_approval.push(id.clone());
        }
    }
    Ok(out)
}

/// Check at launch and once a day while Dashledge runs.
pub fn start_checks(app: tauri::AppHandle) {
    let Ok(registry) = Registry::pinned() else { return };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        loop {
            if let (Ok(dir), Ok(root)) = (data_dir(&app), package_store::installed_root(&app)) {
                if let Ok(checked) = tauri::async_runtime::block_on(check(&registry, &dir, &root)) {
                    use tauri::Emitter;
                    let _ = app.emit("marketplace-checked", &checked);
                }
            }
            std::thread::sleep(Duration::from_secs(24 * 60 * 60));
        }
    });
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// What a listed package looks like on this Mac, pulled or not.
fn installed_here(id: &str) -> Option<Here> {
    package_store::lookup_any(id).filter(|(p, _)| p.origin != "bundled").map(|(p, _)| Here {
        origin: p.origin.to_string(),
        version: p.manifest.version.clone().unwrap_or_default(),
        grants: grants(&p.manifest),
    })
}

#[tauri::command]
pub async fn marketplace_check(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Checked, String> {
    package_store::settings_only(&window)?;
    check(&Registry::pinned()?, &data_dir(&app)?, &package_store::installed_root(&app)?).await
}

/// The registry's GitHub repository, where authors open listing pull requests.
const REGISTRY_REPO: &str = "https://github.com/dgruhin-hrizn/dashledge-plugins";

/// A package ready to submit: its ZIP, and the listing file the author proposes.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submission {
    pub id: String,
    pub version: String,
    pub publisher: String,
    pub file_name: String,
    pub sha256: String,
    pub size: usize,
    pub listing: Value,
    /// GitHub's new-file page in the registry with the listing filled in. GitHub forks
    /// the registry and opens the pull request for authors who can't push to it.
    pub new_file_url: String,
    #[serde(skip)]
    pub bytes: Vec<u8>,
}

/// Prepare a package folder's files for the Marketplace, refusing what registry CI
/// would refuse: an ID outside `plugin.<github-login>.<name>`, a version that isn't
/// `major.minor.patch`, or a package the validator rejects.
pub fn submission(raw: &Value, files: &package_store::Files) -> Result<Submission, String> {
    let manifest = package_store::check_for_this_app(raw, files)?;
    let parts: Vec<&str> = manifest.id.splitn(3, '.').collect();
    let [_, publisher, name] = parts.as_slice() else {
        return Err("A Marketplace ID is plugin.<your GitHub login>.<name>, such as plugin.alice.radarr-queue.".into());
    };
    let version = manifest.version.clone().filter(|v| semver::Version::parse(v).is_ok_and(|s| s.build.is_empty()))
        .ok_or("Give widget.json a version such as 1.0.0 before you submit.")?;
    let bytes = dashledge_package_core::archive::pack(files)?;
    let sha256 = catalog::sha256_hex(&bytes);
    let file_name = format!("{name}-{version}.zip");
    let summary = manifest.description.clone().filter(|d| d.chars().count() <= 140);
    let listing = catalog::Listing {
        id: manifest.id.clone(),
        version: version.clone(),
        publisher: publisher.to_string(),
        source: catalog::Source { repo: format!("{publisher}/{name}"), tag: format!("v{version}"), asset: file_name.clone() },
        sha256: sha256.clone(),
        summary,
        screenshots: vec![],
        notes: None,
    };
    // The same check registry CI runs. Maintainers' `plugin.dashledge.` IDs pass here and
    // are checked against the maintainer list there.
    catalog::check_listing(&listing, &bytes, &[publisher.to_string()])?;
    let listing = serde_json::to_value(&listing).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&listing).map_err(|e| e.to_string())? + "\n";
    let new_file_url = Url::parse_with_params(
        &format!("{REGISTRY_REPO}/new/main"),
        &[("filename", format!("listings/{}/{version}.json", manifest.id)), ("value", text)],
    )
    .map_err(|e| e.to_string())?
    .to_string();
    Ok(Submission { id: manifest.id.clone(), version, publisher: publisher.to_string(), file_name, sha256, size: bytes.len(), listing, new_file_url, bytes })
}

/// Pack an unpacked package for the Marketplace and save the ZIP where the author
/// chooses. Returns `None` when they cancel the save dialog.
#[tauri::command]
pub async fn marketplace_prepare_submission(window: tauri::WebviewWindow, id: String) -> Result<Option<Value>, String> {
    package_store::settings_only(&window)?;
    let (_, dir) = package_store::lookup_any(&id)
        .filter(|(p, _)| p.origin == "unpacked")
        .ok_or("Load the package’s folder in Widget Studio, then submit it from there.")?;
    let (raw, files) = package_store::read_folder(&dir)?;
    let prepared = submission(&raw, &files)?;
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Save the package to attach to your GitHub release")
        .set_file_name(&prepared.file_name)
        .add_filter("ZIP", &["zip"])
        .save_file()
        .await
    else {
        return Ok(None);
    };
    fs::write(file.path(), &prepared.bytes).map_err(|e| e.to_string())?;
    let mut value = serde_json::to_value(&prepared).map_err(|e| e.to_string())?;
    value["savedTo"] = json!(file.path().to_string_lossy());
    Ok(Some(value))
}

/// Open a page of the registry repository in the browser, and nothing else.
#[tauri::command]
pub fn open_registry_page(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    package_store::settings_only(&window)?;
    let ok = Url::parse(&url).is_ok_and(|u| u.scheme() == "https" && u.host_str() == Some("github.com") && u.path().starts_with("/dgruhin-hrizn/dashledge-plugins"));
    if !ok || !url.starts_with(REGISTRY_REPO) {
        return Err("Only the Marketplace registry opens from here.".into());
    }
    std::process::Command::new("/usr/bin/open").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// IDs installed from the Marketplace, so Widget Studio can label the rest Unverified.
/// Reads only this Mac's record; nothing is fetched.
#[tauri::command]
pub fn marketplace_installed(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Vec<String>, String> {
    package_store::settings_only(&window)?;
    Ok(load(&data_dir(&app)?).installed.into_keys().collect())
}

#[tauri::command]
pub fn marketplace_set_auto_update(window: tauri::WebviewWindow, app: tauri::AppHandle, on: bool) -> Result<(), String> {
    package_store::settings_only(&window)?;
    let dir = data_dir(&app)?;
    let _guard = LOCK.lock().unwrap();
    let mut record = load(&dir);
    record.auto_update = on;
    save(&dir, &record)
}

#[tauri::command]
pub async fn marketplace_catalog(window: tauri::WebviewWindow, app: tauri::AppHandle, refresh: bool) -> Result<Value, String> {
    package_store::settings_only(&window)?;
    let registry = Registry::pinned()?;
    let dir = data_dir(&app)?;
    let catalog = if refresh { fetch_catalog(&registry, &dir).await? } else { catalog_for(&registry, &dir).await? };
    Ok(view(&catalog, &load(&dir), installed_here))
}

#[tauri::command]
pub async fn marketplace_image(window: tauri::WebviewWindow, app: tauri::AppHandle, path: String) -> Result<String, String> {
    package_store::settings_only(&window)?;
    image(&Registry::pinned()?, &data_dir(&app)?, &path).await
}

#[tauri::command]
pub async fn marketplace_inspect(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String, version: String) -> Result<Value, String> {
    package_store::settings_only(&window)?;
    inspect(&Registry::pinned()?, &data_dir(&app)?, &id, &version).await
}

#[tauri::command]
pub async fn marketplace_install(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String, version: String) -> Result<PackageInfo, String> {
    package_store::settings_only(&window)?;
    install(&Registry::pinned()?, &data_dir(&app)?, &package_store::installed_root(&app)?, &id, &version).await
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use dashledge_package_core::catalog::{fixtures, Build, Listing, Revoked, Source, Submitted};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::Arc,
    };

    /// A registry served from memory on 127.0.0.1, with a fresh key.
    pub struct TestRegistry {
        pub registry: Registry,
        pub files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
        pub key: Vec<u8>,
    }

    impl TestRegistry {
        pub fn start() -> TestRegistry {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let files: Arc<Mutex<BTreeMap<String, Vec<u8>>>> = Arc::default();
            let served = files.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let served = served.clone();
                    std::thread::spawn(move || {
                        let mut stream = stream;
                        let mut buf = [0u8; 4096];
                        let n = stream.read(&mut buf).unwrap_or(0);
                        let request = String::from_utf8_lossy(&buf[..n]);
                        let path = request.split_whitespace().nth(1).unwrap_or("/").trim_start_matches("/v1/").to_string();
                        let body = served.lock().unwrap().get(&path).cloned();
                        let head = match &body {
                            Some(b) => format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", b.len()),
                            None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                        };
                        let _ = stream.write_all(head.as_bytes());
                        if let Some(b) = body {
                            let _ = stream.write_all(&b);
                        }
                    });
                }
            });
            let (key, public) = catalog::generate_key().unwrap();
            TestRegistry {
                registry: Registry { base: Url::parse(&format!("http://127.0.0.1:{port}/v1/")).unwrap(), keys: vec![public] },
                files,
                key,
            }
        }

        /// Publish a catalog of these packages (id, version, extra manifest fields).
        pub fn publish(&self, packages: &[(&str, &str, Value)], revoked: Vec<Revoked>, previous: Option<Catalog>, lifetime: u64) -> Catalog {
            let submitted = packages
                .iter()
                .map(|(id, version, extra)| {
                    let package = fixtures::package(id, version, extra.clone());
                    Submitted {
                        listing: Listing {
                            id: id.to_string(), version: version.to_string(), publisher: id.split('.').nth(1).unwrap().to_string(),
                            source: Source { repo: "a/b".into(), tag: "t".into(), asset: "a.zip".into() },
                            sha256: catalog::sha256_hex(&package), summary: None, screenshots: vec![], notes: None,
                        },
                        package,
                        screenshots: BTreeMap::new(),
                    }
                })
                .collect();
            let built = catalog::build(Build { submitted, previous, revoked, maintainers: vec![], now: now(), lifetime }).unwrap();
            let bytes = serde_json::to_vec(&built.catalog).unwrap();
            let mut files = self.files.lock().unwrap();
            files.extend(built.files);
            files.insert("catalog.json.sig".into(), catalog::sign(&bytes, &self.key).unwrap().into_bytes());
            files.insert("catalog.json".into(), bytes);
            built.catalog
        }
    }

    fn block<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn a_verified_package_installs_and_is_remembered() {
        let server = TestRegistry::start();
        server.publish(&[("plugin.alice.queue", "1.0.0", json!({})), ("plugin.alice.queue", "1.1.0", json!({"images": [], "license": "MIT"}))], vec![], None, 3600);
        let dir = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let catalog = block(fetch_catalog(&server.registry, dir.path())).unwrap();
        assert_eq!(load(dir.path()).sequence, 1);
        let shown = view(&catalog, &load(dir.path()), |_| None);
        assert_eq!(shown["plugins"][0]["available"], "1.1.0");
        let sheet = block(inspect(&server.registry, dir.path(), "plugin.alice.queue", "1.1.0")).unwrap();
        assert_eq!(sheet["license"], "MIT");
        assert_eq!(sheet["marketplace"]["version"], "1.1.0");
        let info = block(install(&server.registry, dir.path(), root.path(), "plugin.alice.queue", "1.1.0")).unwrap();
        assert_eq!(info.manifest.version.as_deref(), Some("1.1.0"));
        assert!(root.path().join("plugin.alice.queue/widget.json").is_file());
        let record = load(dir.path());
        assert_eq!(record.installed["plugin.alice.queue"].version, "1.1.0");
        let shown = view(&catalog, &record, |_| Some(Here { origin: "installed".into(), version: "1.0.0".into(), grants: BTreeSet::new() }));
        assert_eq!(shown["plugins"][0]["origin"], "installed", "a version the record doesn't know came from a file");
        forget(dir.path(), "plugin.alice.queue").unwrap();
        assert!(load(dir.path()).installed.is_empty());
        let icon = block(image(&server.registry, dir.path(), &catalog.plugins[0].icon.path)).unwrap();
        assert!(icon.starts_with("data:image/png;base64,"));
        assert!(block(image(&server.registry, dir.path(), "packages/plugin.alice.queue/1.0.0.zip")).is_err(), "only listed images");
    }

    #[test]
    fn tampered_downloads_wrong_keys_rollbacks_and_pulled_versions_are_refused() {
        let server = TestRegistry::start();
        let first = server.publish(&[("plugin.alice.queue", "1.0.0", json!({}))], vec![], None, 3600);
        let dir = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();

        let stranger = Registry { keys: vec![catalog::generate_key().unwrap().1], ..server.registry.clone() };
        assert!(block(fetch_catalog(&stranger, dir.path())).unwrap_err().contains("isn't signed"));

        block(fetch_catalog(&server.registry, dir.path())).unwrap();
        server.files.lock().unwrap().insert("packages/plugin.alice.queue/1.0.0.zip".into(), fixtures::package("plugin.alice.queue", "1.0.0", json!({"license": "evil"})));
        assert!(block(install(&server.registry, dir.path(), root.path(), "plugin.alice.queue", "1.0.0")).unwrap_err().contains("doesn’t match"));
        assert!(!root.path().join("plugin.alice.queue").exists());

        let second = server.publish(&[("plugin.alice.queue", "1.0.0", json!({}))],
            vec![Revoked { id: "plugin.alice.queue".into(), version: "1.0.0".into(), reason: "Leaks keys.".into() }], Some(first.clone()), 3600);
        let catalog = block(fetch_catalog(&server.registry, dir.path())).unwrap();
        assert_eq!(catalog.sequence, second.sequence);
        assert!(block(inspect(&server.registry, dir.path(), "plugin.alice.queue", "1.0.0")).unwrap_err().contains("pulled"));
        let shown = view(&catalog, &load(dir.path()), |_| Some(Here { origin: "installed".into(), version: "1.0.0".into(), grants: BTreeSet::new() }));
        assert_eq!(shown["plugins"][0]["pulled"], "Leaks keys.");
        assert!(shown["plugins"][0]["available"].is_null());

        // An attacker replays the older, still validly signed catalog.
        let bytes = serde_json::to_vec(&first).unwrap();
        let mut files = server.files.lock().unwrap();
        files.insert("catalog.json.sig".into(), catalog::sign(&bytes, &server.key).unwrap().into_bytes());
        files.insert("catalog.json".into(), bytes);
        drop(files);
        assert!(block(fetch_catalog(&server.registry, dir.path())).unwrap_err().contains("older"));
    }

    #[test]
    fn a_check_updates_quietly_asks_for_new_grants_and_turns_off_pulled_versions() {
        let server = TestRegistry::start();
        let id = "plugin.alice.queue";
        let v1 = server.publish(&[(id, "1.0.0", json!({}))], vec![], None, 3600);
        let dir = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        block(install(&server.registry, dir.path(), root.path(), id, "1.0.0")).unwrap();

        let v2 = server.publish(&[(id, "1.0.0", json!({})), (id, "1.1.0", json!({}))], vec![], Some(v1), 3600);
        let checked = block(check(&server.registry, dir.path(), root.path())).unwrap();
        assert_eq!(checked.updated, [id], "an update that adds nothing installs on its own");
        assert_eq!(load(dir.path()).installed[id].version, "1.1.0");

        let host = json!({"connector": {"entry": "connector.js", "hosts": ["https://api.example.com"]}});
        let v3 = server.publish(&[(id, "1.0.0", json!({})), (id, "1.1.0", json!({})), (id, "1.2.0", host.clone())],
            vec![Revoked { id: id.into(), version: "1.1.0".into(), reason: "Crashes the Edge.".into() }], Some(v2), 3600);
        let checked = block(check(&server.registry, dir.path(), root.path())).unwrap();
        assert_eq!((checked.pulled.as_slice(), checked.needs_approval.as_slice(), checked.updated.len()), ([id.to_string()].as_slice(), [id.to_string()].as_slice(), 0));
        let disabled = package_store::read_disabled(root.path());
        assert_eq!(disabled[id].reason, "Crashes the Edge.");
        let listed = package_store::read_root(root.path(), dashledge_package_core::manifest::Origin::Installed);
        assert_eq!(package_store::disabled_reason(&disabled, &listed[0].manifest).as_deref(), Some("Crashes the Edge."));
        let here = |_: &str| Some(Here { origin: "installed".into(), version: "1.1.0".into(), grants: grants(&listed[0].manifest) });
        let shown = view(&v3, &load(dir.path()), here);
        assert_eq!(shown["plugins"][0]["update"], "1.2.0");
        assert_eq!(shown["plugins"][0]["updateAdds"].as_array().unwrap().len(), 2, "the connector and its host");

        // Approving installs 1.2.0, which the pulled entry doesn't name, so it runs again.
        block(install(&server.registry, dir.path(), root.path(), id, "1.2.0")).unwrap();
        let listed = package_store::read_root(root.path(), dashledge_package_core::manifest::Origin::Installed);
        assert!(package_store::disabled_reason(&package_store::read_disabled(root.path()), &listed[0].manifest).is_none());
        let mut record = load(dir.path());
        record.auto_update = false;
        save(dir.path(), &record).unwrap();
        let checked = block(check(&server.registry, dir.path(), root.path())).unwrap();
        assert!(checked.pulled.is_empty() && package_store::read_disabled(root.path()).is_empty(), "nothing installed is pulled now");
    }

    #[test]
    fn a_submission_carries_the_zip_and_a_listing_registry_ci_accepts() {
        let package = fixtures::package("plugin.alice.queue", "1.2.0", json!({"description": "Downloads now."}));
        let (raw, files) = package_store::extract(&package).unwrap();
        let s = submission(&raw, &files).unwrap();
        assert_eq!((s.publisher.as_str(), s.file_name.as_str(), s.size), ("alice", "queue-1.2.0.zip", s.bytes.len()));
        assert_eq!(s.listing["source"], json!({"repo": "alice/queue", "tag": "v1.2.0", "asset": "queue-1.2.0.zip"}));
        assert_eq!(s.listing["sha256"], catalog::sha256_hex(&s.bytes));
        assert_eq!(s.listing["summary"], "Downloads now.");
        let listing: catalog::Listing = serde_json::from_value(s.listing.clone()).unwrap();
        assert!(catalog::check_listing(&listing, &s.bytes, &[]).is_ok(), "registry CI accepts it as is");
        let url = Url::parse(&s.new_file_url).unwrap();
        assert!(s.new_file_url.starts_with("https://github.com/dgruhin-hrizn/dashledge-plugins/new/main?"));
        let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["filename"], "listings/plugin.alice.queue/1.2.0.json");
        assert_eq!(serde_json::from_str::<Value>(&query["value"]).unwrap(), s.listing);

        for (id, version, message) in [("plugin.queue", "1.0.0", "plugin.<your GitHub login>"), ("plugin.alice.queue", "1.0", "1.0.0")] {
            let (raw, files) = package_store::extract(&fixtures::package(id, version, json!({}))).unwrap();
            assert!(submission(&raw, &files).unwrap_err().contains(message), "{id} {version}");
        }
    }

    #[test]
    fn a_dev_registry_needs_both_its_address_and_key() {
        assert!(dev_registry_from(None, Some("k".into())).is_none());
        assert!(dev_registry_from(Some("http://127.0.0.1:8000/v1".into()), None).is_none());
        assert!(dev_registry_from(Some(String::new()), Some("k".into())).is_none());
        let registry = dev_registry_from(Some("http://127.0.0.1:8000/v1".into()), Some("k".into())).unwrap();
        assert_eq!(registry.base.as_str(), "http://127.0.0.1:8000/v1/");
        assert_eq!(registry.keys, ["k"]);
    }

    #[test]
    fn the_pinned_registry_is_https_with_ed25519_public_keys() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let registry = Registry::pinned().unwrap();
        assert_eq!(registry.base.scheme(), "https");
        assert!(registry.base.as_str().ends_with("/v1/"));
        assert!(!registry.keys.is_empty());
        for key in &registry.keys {
            assert_eq!(STANDARD.decode(key).unwrap().len(), 32, "an Ed25519 public key, never a private key");
        }
    }

    #[test]
    fn registry_paths_stay_inside_the_registry_and_expired_catalogs_install_nothing() {
        let server = TestRegistry::start();
        for path in ["../x", "/etc/passwd", "a//b", "https://evil.example/x", "a/./b", "a?b", ""] {
            assert!(server.registry.url(path).is_err(), "{path}");
        }
        assert!(server.registry.url("packages/plugin.a.b/1.0.0.zip").is_ok());
        server.publish(&[("plugin.alice.queue", "1.0.0", json!({}))], vec![], None, 0);
        let dir = tempfile::tempdir().unwrap();
        block(fetch_catalog(&server.registry, dir.path())).unwrap();
        assert!(block(inspect(&server.registry, dir.path(), "plugin.alice.queue", "1.0.0")).unwrap_err().contains("out of date"));
    }
}
