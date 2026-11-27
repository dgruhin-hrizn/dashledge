//! Widget packages on disk.
//!
//! Bundled packages ship with the app under `widgets/packages/<id>/`. Installed API
//! version 2 packages are extracted to `<app_data>/packages/<id>/`. Both are described
//! by a `widget.json` that `package_manifest` validates; installed packages may not
//! declare a collector.
//!
//! For package authors, Widget Studio can also load an unpacked folder. It is checked
//! like an installed package but served from where it is, and a watcher reloads its
//! views and connector when its files change.
use crate::package_manifest::{self, Manifest, Origin, Tier};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    collections::HashMap,
    hash::{Hash, Hasher},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::Manager;

pub use dashledge_package_core::archive::{check, extract, icon_data, Files, MAX_PACKAGE};
use dashledge_package_core::archive::{allowed_name, MAX_FILE, MAX_FILES};
use dashledge_package_core::grants;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    #[serde(flatten)]
    pub manifest: Manifest,
    pub origin: &'static str,
    pub tier: Tier,
    pub icon_data: Option<String>,
    /// The folder an unpacked package is loaded from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// `check`, plus the package's `minAppVersion` against this build. Listing what is
/// already installed skips this, so an app downgrade never hides a package silently.
pub fn check_for_this_app(raw: &Value, files: &Files) -> Result<Manifest, String> {
    let manifest = check(raw, files)?;
    manifest.runs_on(env!("CARGO_PKG_VERSION"))?;
    Ok(manifest)
}

fn info(manifest: Manifest, origin: Origin, dir: &Path) -> PackageInfo {
    let icon_data = fs::read(dir.join(&manifest.icon)).ok().and_then(|b| icon_data(&manifest.icon, &b));
    PackageInfo {
        tier: manifest.tier(),
        origin: if origin == Origin::Bundled { "bundled" } else { "installed" },
        icon_data,
        manifest,
        path: None,
    }
}

/// Files of an unpacked package folder, within the limits of a package ZIP. Hidden
/// entries, `node_modules` and file types a package can't include (TypeScript sources,
/// for example) are skipped. Links are refused.
pub fn read_folder(root: &Path) -> Result<(Value, Files), String> {
    fn walk(root: &Path, dir: &Path, files: &mut Files, total: &mut u64) -> Result<(), String> {
        let mut entries: Vec<_> = fs::read_dir(dir).map_err(|e| e.to_string())?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            let path = entry.path();
            let relative = path.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
            let kind = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if kind.file_type().is_symlink() {
                return Err(format!("“{relative}” is a link. Packages can’t contain links."));
            }
            if kind.is_dir() {
                walk(root, &path, files, total)?;
                continue;
            }
            if !allowed_name(&relative) || package_manifest::package_path(&relative, "Package file").is_err() {
                continue;
            }
            if kind.len() > MAX_FILE {
                return Err(format!("“{relative}” is larger than 4 MiB."));
            }
            *total += kind.len();
            if *total > MAX_PACKAGE as u64 || files.len() >= MAX_FILES {
                return Err(format!("The folder holds more than a package may: {MAX_FILES} files or 8 MiB."));
            }
            files.insert(relative, fs::read(&path).map_err(|e| e.to_string())?);
        }
        Ok(())
    }
    let mut files = Files::new();
    walk(root, root, &mut files, &mut 0)?;
    let raw = serde_json::from_slice(files.get("widget.json").ok_or("The folder has no widget.json.")?)
        .map_err(|e| format!("Invalid widget.json: {e}"))?;
    Ok((raw, files))
}

/// Check an unpacked folder and describe it as a package served from that folder.
pub fn unpacked_info(dir: &Path) -> Result<PackageInfo, String> {
    let (raw, files) = read_folder(dir)?;
    let manifest = check_for_this_app(&raw, &files)?;
    let mut package = info(manifest, Origin::Installed, dir);
    package.origin = "unpacked";
    package.path = Some(dir.to_string_lossy().into_owned());
    Ok(package)
}

/// Write a checked package to `root/<id>`, replacing any earlier version in one rename.
pub fn install_files(root: &Path, manifest: &Manifest, files: &Files) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let staging = tempfile::Builder::new().prefix(".staging-").tempdir_in(root).map_err(|e| e.to_string())?;
    for (relative, data) in files {
        let path = staging.path().join(relative);
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&path, data).map_err(|e| e.to_string())?;
    }
    let target = root.join(&manifest.id);
    let previous = root.join(format!(".old-{}", manifest.id));
    let _ = fs::remove_dir_all(&previous);
    if target.exists() {
        fs::rename(&target, &previous).map_err(|e| e.to_string())?;
    }
    let staged = staging.keep();
    if let Err(e) = fs::rename(&staged, &target) {
        let _ = fs::remove_dir_all(&staged);
        if previous.exists() {
            let _ = fs::rename(&previous, &target);
        }
        return Err(e.to_string());
    }
    let _ = fs::remove_dir_all(&previous);
    Ok(())
}

/// Every valid package under `root`. Invalid folders are skipped, so one broken
/// package can't hide the others.
pub fn read_root(root: &Path, origin: Origin) -> Vec<PackageInfo> {
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    let mut out: Vec<_> = entries
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with(['.', '_']))
        .filter_map(|entry| {
            let dir = entry.path();
            let raw: Value = serde_json::from_slice(&fs::read(dir.join("widget.json")).ok()?).ok()?;
            let manifest = package_manifest::validate(&raw, origin).ok()?;
            (dir.file_name()?.to_str()? == manifest.id).then(|| info(manifest, origin, &dir))
        })
        .collect();
    out.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    out
}

pub fn installed_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("packages"))
}

pub fn bundled_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?.join("widgets/packages");
    if resources.is_dir() {
        return Ok(resources);
    }
    #[cfg(debug_assertions)]
    return Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("../widgets/packages"));
    #[cfg(not(debug_assertions))]
    Ok(resources)
}

static ROOTS: OnceLock<(PathBuf, PathBuf)> = OnceLock::new();
static CACHE: Mutex<Option<Vec<(PackageInfo, PathBuf)>>> = Mutex::new(None);
/// Folders loaded as unpacked packages, kept in `<app_data>/packages-unpacked.json`.
static UNPACKED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
static UNPACKED_FILE: OnceLock<PathBuf> = OnceLock::new();
/// Bumped when an unpacked package's files change, so open views and connectors reload.
static REVISIONS: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

/// Remember where packages live. Called once at startup.
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let _ = ROOTS.set((bundled_root(app)?, installed_root(app)?));
    let file = app.path().app_data_dir().map_err(|e| e.to_string())?.join("packages-unpacked.json");
    let saved: Vec<PathBuf> = fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    *UNPACKED.lock().unwrap() = saved;
    let _ = UNPACKED_FILE.set(file);
    refresh();
    std::thread::spawn(watch_unpacked);
    Ok(())
}

fn save_unpacked(paths: &[PathBuf]) -> Result<(), String> {
    let file = UNPACKED_FILE.get().ok_or("Packages aren’t ready yet.")?;
    fs::write(file, serde_json::to_vec_pretty(paths).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// How many times an unpacked package has changed since launch; 0 for other packages.
pub fn revision(id: &str) -> u64 {
    REVISIONS.lock().unwrap().as_ref().and_then(|r| r.get(id).copied()).unwrap_or(0)
}

fn bump(id: &str) {
    *REVISIONS.lock().unwrap().get_or_insert_with(HashMap::new).entry(id.to_string()).or_insert(0) += 1;
}

/// A cheap summary of a folder's files: names, sizes and modification times.
fn fingerprint(dir: &Path) -> u64 {
    fn walk(dir: &Path, hasher: &mut std::collections::hash_map::DefaultHasher, depth: usize) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') || name == "node_modules" {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
            name.hash(hasher);
            if meta.is_dir() && depth < 8 {
                walk(&entry.path(), hasher, depth + 1);
            } else {
                meta.len().hash(hasher);
                meta.modified().ok().hash(hasher);
            }
        }
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    walk(dir, &mut hasher, 0);
    hasher.finish()
}

/// Poll unpacked folders once a second. A change refreshes the package listing and
/// bumps the package's revision; the dashboard then reopens its views and connector.
fn watch_unpacked() {
    let mut seen: HashMap<PathBuf, u64> = HashMap::new();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let paths = UNPACKED.lock().unwrap().clone();
        seen.retain(|path, _| paths.contains(path));
        for path in paths {
            let now = fingerprint(&path);
            if seen.insert(path.clone(), now).is_some_and(|before| before != now) {
                refresh();
                let id = fs::read(path.join("widget.json")).ok()
                    .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                    .and_then(|raw| raw["id"].as_str().map(str::to_owned));
                if let Some(id) = id {
                    bump(&id);
                }
            }
        }
    }
}

/// Forget the cached listing after an install or removal.
pub fn refresh() {
    *CACHE.lock().unwrap() = None;
}

/// Every package with its folder: bundled first, then installed ones whose ID no
/// bundled package uses, so an installed package can never replace a built-in widget.
pub fn all() -> Vec<(PackageInfo, PathBuf)> {
    let mut cache = CACHE.lock().unwrap();
    if let Some(list) = &*cache {
        return list.clone();
    }
    let (bundled, installed) = match ROOTS.get() {
        Some((b, i)) => (b.clone(), Some(i.clone())),
        // Tests and other code running without the app read the project's packages.
        #[cfg(debug_assertions)]
        None => (Path::new(env!("CARGO_MANIFEST_DIR")).join("../widgets/packages"), None),
        #[cfg(not(debug_assertions))]
        None => return Vec::new(),
    };
    let mut list: Vec<_> = read_root(&bundled, Origin::Bundled)
        .into_iter()
        .map(|p| { let dir = bundled.join(&p.manifest.id); (p, dir) })
        .collect();
    // An unpacked folder takes the place of an installed package with the same ID,
    // so an author can work on a new version of a widget that's already in use.
    for dir in UNPACKED.lock().unwrap().iter() {
        if let Ok(package) = unpacked_info(dir) {
            if !list.iter().any(|(p, _)| p.manifest.id == package.manifest.id) {
                list.push((package, dir.clone()));
            }
        }
    }
    if let Some(installed) = installed {
        for package in read_root(&installed, Origin::Installed) {
            if !list.iter().any(|(p, _)| p.manifest.id == package.manifest.id) {
                let dir = installed.join(&package.manifest.id);
                list.push((package, dir));
            }
        }
    }
    *cache = Some(list.clone());
    list
}

/// A package and its folder by ID.
pub fn lookup(id: &str) -> Option<(PackageInfo, PathBuf)> {
    all().into_iter().find(|(p, _)| p.manifest.id == id)
}

pub fn is_bundled(id: &str) -> bool {
    lookup(id).is_some_and(|(p, _)| p.origin == "bundled")
}

fn settings_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("Open Widget Studio in Settings.".into());
    }
    Ok(())
}

fn raw_body<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err("Send the package file’s bytes.".into()),
    }
}

/// Read a package ZIP without installing it. API version 1 packages return their
/// legacy manifest; version 2 packages return the checked manifest for the install sheet.
#[tauri::command]
pub fn inspect_widget_package(window: tauri::WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    settings_only(&window)?;
    let bytes = raw_body(&request)?;
    let (raw, files) = extract(bytes)?;
    if raw.get("apiVersion").and_then(Value::as_u64) != Some(package_manifest::API_VERSION) {
        return crate::widget_package::unpack(bytes.to_vec());
    }
    let manifest = check_for_this_app(&raw, &files)?;
    sheet_info(manifest, &files, lookup_installed)
}

/// The installed or unpacked package with this ID, if any.
fn lookup_installed(id: &str) -> Option<Manifest> {
    lookup(id).filter(|(p, _)| p.origin != "bundled").map(|(p, _)| p.manifest)
}

/// What the install sheet shows for a checked package: its info, and `added`, the grants
/// it declares that the installed version with the same ID doesn't.
pub fn sheet_info(manifest: Manifest, files: &Files, installed: impl Fn(&str) -> Option<Manifest>) -> Result<Value, String> {
    let icon = icon_data(&manifest.icon, &files[&manifest.icon]).ok_or("The icon must be a PNG or SVG up to 256 KiB.")?;
    let added = installed(&manifest.id).map(|old| grants::added_grants(&old, &manifest));
    let mut value = serde_json::to_value(PackageInfo { tier: manifest.tier(), origin: "installed", icon_data: Some(icon), manifest, path: None })
        .map_err(|e| e.to_string())?;
    if let Some(added) = added {
        value["added"] = serde_json::to_value(added).map_err(|e| e.to_string())?;
    }
    Ok(value)
}

#[tauri::command]
pub fn install_widget_package(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<PackageInfo, String> {
    settings_only(&window)?;
    install_bytes(&installed_root(&app)?, raw_body(&request)?)
}

/// Check a package ZIP and install it under `root`, replacing an earlier version.
/// Running views and connectors of that package reload. The Marketplace installs its
/// verified downloads through this too.
pub fn install_bytes(root: &Path, bytes: &[u8]) -> Result<PackageInfo, String> {
    let (raw, files) = extract(bytes)?;
    let manifest = check_for_this_app(&raw, &files)?;
    install_files(root, &manifest, &files)?;
    refresh();
    bump(&manifest.id);
    let dir = root.join(&manifest.id);
    Ok(info(manifest, Origin::Installed, &dir))
}

#[tauri::command]
pub fn list_packages() -> Vec<PackageInfo> {
    all().into_iter().map(|(p, _)| p).collect()
}

/// Load an unpacked package folder the author chooses. Widget Studio never passes a
/// path itself: the folder comes from the system's folder picker.
#[tauri::command]
pub async fn choose_unpacked_package(window: tauri::WebviewWindow) -> Result<Option<PackageInfo>, String> {
    settings_only(&window)?;
    let Some(folder) = rfd::AsyncFileDialog::new().set_title("Choose a widget package folder").pick_folder().await else {
        return Ok(None);
    };
    let dir = folder.path().canonicalize().map_err(|e| e.to_string())?;
    let package = unpacked_info(&dir)?;
    if all().iter().any(|(p, _)| p.origin == "bundled" && p.manifest.id == package.manifest.id) {
        return Err("A built-in widget already uses this ID.".into());
    }
    let mut paths = UNPACKED.lock().unwrap().clone();
    paths.retain(|path| path != &dir && unpacked_info(path).map_or(true, |p| p.manifest.id != package.manifest.id));
    paths.push(dir);
    save_unpacked(&paths)?;
    *UNPACKED.lock().unwrap() = paths;
    refresh();
    bump(&package.manifest.id);
    Ok(Some(package))
}

/// Check an unpacked package again, for example after editing widget.json, and reload
/// its open views. Returns the error that keeps it from loading, if any.
#[tauri::command]
pub fn reload_unpacked_package(window: tauri::WebviewWindow, id: String) -> Result<PackageInfo, String> {
    settings_only(&window)?;
    let dir = unpacked_dir(&id).ok_or("This package isn’t loaded from a folder.")?;
    let package = unpacked_info(&dir)?;
    refresh();
    bump(&id);
    Ok(package)
}

/// The folder an unpacked package with this ID was loaded from. A folder whose
/// widget.json no longer validates still matches by the ID it declares.
fn unpacked_dir(id: &str) -> Option<PathBuf> {
    UNPACKED.lock().unwrap().iter().find(|dir| {
        fs::read(dir.join("widget.json")).ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .is_some_and(|raw| raw["id"].as_str() == Some(id))
    }).cloned()
}

#[tauri::command]
pub fn remove_widget_package(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String) -> Result<(), String> {
    settings_only(&window)?;
    // An unpacked package is only unlinked; its folder stays as it is.
    if let Some(dir) = unpacked_dir(&id) {
        let mut paths = UNPACKED.lock().unwrap().clone();
        paths.retain(|path| path != &dir);
        save_unpacked(&paths)?;
        *UNPACKED.lock().unwrap() = paths;
        refresh();
        bump(&id);
        return Ok(());
    }
    let rest = id.strip_prefix("plugin.").unwrap_or("");
    if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-.".contains(&b)) || rest.contains("..") {
        return Err("Unknown package".into());
    }
    let result = match fs::remove_dir_all(installed_root(&app)?.join(&id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    };
    refresh();
    bump(&id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::{write::FileOptions, ZipWriter};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x10\0\0\0\x10";

    fn manifest(extra: Value) -> String {
        let mut m = serde_json::json!({"apiVersion": 2, "id": "plugin.status", "title": "Status",
            "icon": "icon.png", "view": {"entry": "view/index.html"}});
        m.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        m.to_string()
    }
    fn zip_of(entries: &[(&str, &[u8])], symlink: Option<&str>) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            zip.start_file(*name, FileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        if let Some(name) = symlink {
            zip.add_symlink(name, "/etc/passwd", FileOptions::default()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    fn good(prefix: &str) -> Vec<u8> {
        let m = manifest(serde_json::json!({}));
        zip_of(&[
            (&format!("{prefix}widget.json"), m.as_bytes()),
            (&format!("{prefix}icon.png"), PNG),
            (&format!("{prefix}view/index.html"), b"<!doctype html>"),
            (&format!("{prefix}LICENSE"), b"MIT"),
        ], None)
    }

    #[test]
    fn extracts_a_package_from_the_folder_holding_widget_json() {
        for prefix in ["", "status/"] {
            let (raw, files) = extract(&good(prefix)).unwrap();
            let manifest = check(&raw, &files).unwrap();
            assert_eq!(manifest.id, "plugin.status");
            assert_eq!(files.keys().collect::<Vec<_>>(), ["LICENSE", "icon.png", "view/index.html", "widget.json"]);
        }
    }

    #[test]
    fn refuses_traversal_links_strays_and_unexpected_files() {
        let m = manifest(serde_json::json!({}));
        let cases: Vec<(Vec<u8>, &str)> = vec![
            (zip_of(&[("widget.json", m.as_bytes()), ("../evil.js", b"x")], None), "outside"),
            (zip_of(&[("widget.json", m.as_bytes()), ("/etc/evil.js", b"x")], None), "outside"),
            (zip_of(&[("pkg/widget.json", m.as_bytes()), ("pkg/view/../../x.js", b"x")], None), "relative path"),
            (zip_of(&[("pkg/widget.json", m.as_bytes()), ("other/x.js", b"x")], None), "outside the folder"),
            (zip_of(&[("widget.json", m.as_bytes()), ("run.sh", b"x")], None), "file type"),
            (zip_of(&[("widget.json", m.as_bytes()), (".env", b"x")], None), "relative path"),
            (zip_of(&[("widget.json", m.as_bytes())], Some("view/link.js")), "link"),
            (zip_of(&[("a/widget.json", m.as_bytes()), ("b/widget.json", m.as_bytes())], None), "one widget.json"),
        ];
        for (bytes, expected) in cases {
            let error = extract(&bytes).unwrap_err();
            assert!(error.contains(expected), "{error} should mention {expected}");
        }
        assert!(extract(&vec![0; MAX_PACKAGE + 1]).unwrap_err().contains("8 MiB"));
    }

    #[test]
    fn checks_named_files_exist_and_installed_packages_have_no_collector() {
        let m = manifest(serde_json::json!({"connector": {"entry": "connector.js"}}));
        let bytes = zip_of(&[("widget.json", m.as_bytes()), ("icon.png", PNG), ("view/index.html", b"")], None);
        let (raw, files) = extract(&bytes).unwrap();
        assert!(check(&raw, &files).unwrap_err().contains("connector.js"));
        let m = manifest(serde_json::json!({"collector": {"entry": "c.mjs", "outputs": ["snapshot.js"]}}));
        let bytes = zip_of(&[("widget.json", m.as_bytes()), ("icon.png", PNG), ("view/index.html", b""), ("c.mjs", b"")], None);
        let (raw, files) = extract(&bytes).unwrap();
        assert!(check(&raw, &files).unwrap_err().contains("collector"));
    }

    #[test]
    fn install_replaces_the_previous_version_and_lists_it() {
        let root = tempfile::tempdir().unwrap();
        let (raw, mut files) = extract(&good("")).unwrap();
        let manifest = check(&raw, &files).unwrap();
        files.insert("old-only.js".into(), b"stale".to_vec());
        install_files(root.path(), &manifest, &files).unwrap();
        files.remove("old-only.js");
        install_files(root.path(), &manifest, &files).unwrap();
        let dir = root.path().join("plugin.status");
        assert!(dir.join("view/index.html").is_file());
        assert!(!dir.join("old-only.js").exists(), "an update replaces the whole folder");
        let listed = read_root(root.path(), Origin::Installed);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].tier, Tier::View);
        assert!(listed[0].icon_data.as_deref().unwrap().starts_with("data:image/png;base64,"));
        let names: Vec<_> = fs::read_dir(root.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names, ["plugin.status"], "no staging or previous folders are left behind");
    }

    #[test]
    fn the_install_sheet_lists_grants_an_update_adds() {
        let (raw, files) = extract(&good("")).unwrap();
        let old = check(&raw, &files).unwrap();
        let fresh = sheet_info(old.clone(), &files, |_| None).unwrap();
        assert!(fresh.get("added").is_none(), "a first install has nothing to compare");
        let mut newer = old.clone();
        newer.images = vec!["https://api.example.com/*.png".into()];
        let sheet = sheet_info(newer, &files, |id| (id == "plugin.status").then(|| old.clone())).unwrap();
        assert_eq!(sheet["added"], serde_json::json!([{"kind": "image", "value": "https://api.example.com/*.png"}]));
        let same = sheet_info(old.clone(), &files, |_| Some(old.clone())).unwrap();
        assert_eq!(same["added"], serde_json::json!([]));
    }

    #[test]
    fn installing_reloads_running_views_and_connectors() {
        let root = tempfile::tempdir().unwrap();
        let before = revision("plugin.status");
        let installed = install_bytes(root.path(), &good("")).unwrap();
        assert_eq!(installed.manifest.id, "plugin.status");
        assert!(root.path().join("plugin.status/widget.json").is_file());
        assert!(revision("plugin.status") > before, "an install raises the revision views and connectors watch");
        let again = revision("plugin.status");
        install_bytes(root.path(), &good("")).unwrap();
        assert!(revision("plugin.status") > again, "an update reloads them again");
    }

    #[test]
    fn listing_skips_folders_whose_name_or_manifest_is_wrong() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("plugin.renamed");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("widget.json"), manifest(serde_json::json!({}))).unwrap();
        let broken = root.path().join("plugin.broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join("widget.json"), "{").unwrap();
        assert!(read_root(root.path(), Origin::Installed).is_empty());
    }

    #[test]
    fn every_bundled_package_is_valid_and_its_files_exist() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../widgets/packages");
        let listed = read_root(&root, Origin::Bundled);
        let ids: Vec<_> = listed.iter().map(|p| p.manifest.id.as_str()).collect();
        assert_eq!(ids, ["comfy", "ember", "emby", "omlx", "plans", "proxmox", "reminders", "unraid", "weather"]);
        for package in &listed {
            let dir = root.join(&package.manifest.id);
            // Reminders is view-only: it reads EventKit through the bridge, with no collector.
            assert_eq!(package.manifest.collector.is_none(), package.manifest.id == "reminders", "{}", package.manifest.id);
            let collector = package.manifest.collector.as_ref().map(|c| &c.entry);
            for file in [&package.manifest.view.entry, &package.manifest.icon].into_iter().chain(collector) {
                assert!(dir.join(file).is_file(), "{} is missing {file}", package.manifest.id);
            }
            assert!(package.icon_data.is_some(), "{} icon", package.manifest.id);
        }
        assert!(is_bundled("emby") && !is_bundled("plugin.emby") && !is_bundled("markets"));
        assert!(is_bundled("plans"));
        assert!(is_bundled("weather"));
    }

    #[test]
    fn svg_icons_are_accepted_as_data_uris_and_other_files_are_not() {
        assert!(icon_data("icon.svg", b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap().starts_with("data:image/svg+xml;base64,"));
        assert!(icon_data("icon.svg", b"not an image").is_none());
        assert!(icon_data("icon.png", b"GIF89a").is_none());
    }

    #[test]
    fn unpacked_folders_are_checked_like_installs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("view")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        fs::write(root.join("widget.json"), manifest(serde_json::json!({}))).unwrap();
        fs::write(root.join("icon.png"), PNG).unwrap();
        fs::write(root.join("view/index.html"), "<!doctype html>").unwrap();
        fs::write(root.join("view/app.ts"), "export {}").unwrap();
        fs::write(root.join("design.psd"), "skip").unwrap();
        fs::write(root.join(".git/HEAD"), "ref").unwrap();
        fs::write(root.join("node_modules/x/index.js"), "skip").unwrap();
        let (_, files) = read_folder(root).unwrap();
        assert_eq!(files.keys().map(String::as_str).collect::<Vec<_>>(), ["icon.png", "view/app.ts", "view/index.html", "widget.json"]);
        let package = unpacked_info(root).unwrap();
        assert_eq!(package.origin, "unpacked");
        assert_eq!(package.path.as_deref(), Some(root.to_string_lossy().as_ref()));

        std::os::unix::fs::symlink("/etc/passwd", root.join("view/passwd.txt")).unwrap();
        assert!(read_folder(root).unwrap_err().contains("link"));
        fs::remove_file(root.join("view/passwd.txt")).unwrap();

        fs::write(root.join("widget.json"), manifest(serde_json::json!({"collector": {"entry": "c.mjs", "outputs": ["a.json"]}}))).unwrap();
        assert!(unpacked_info(root).unwrap_err().contains("collector"));
        fs::remove_file(root.join("widget.json")).unwrap();
        assert!(unpacked_info(root).unwrap_err().contains("widget.json"));
    }

    #[test]
    fn the_example_folder_loads_unpacked() {
        let example = Path::new(env!("CARGO_MANIFEST_DIR")).join("../widgets/example");
        let package = unpacked_info(&example).unwrap();
        assert_eq!(package.manifest.id, "plugin.weather-example");
        assert!(package.icon_data.is_some());
    }

    #[test]
    fn a_changed_file_changes_the_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("index.html"), "one").unwrap();
        let before = fingerprint(dir.path());
        assert_eq!(before, fingerprint(dir.path()));
        fs::write(dir.path().join("index.html"), "two!").unwrap();
        assert_ne!(before, fingerprint(dir.path()));
        let after = fingerprint(dir.path());
        fs::write(dir.path().join(".DS_Store"), "x").unwrap();
        assert_eq!(after, fingerprint(dir.path()), "hidden files don't reload the package");
        bump("plugin.fingerprint-test");
        assert_eq!(revision("plugin.fingerprint-test"), 1);
        assert_eq!(revision("plugin.other"), 0);
    }
}
