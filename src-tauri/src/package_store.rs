//! Widget packages on disk.
//!
//! Bundled packages ship with the app under `widgets/packages/<id>/`. Installed API
//! version 2 packages are extracted to `<app_data>/packages/<id>/`. Both are described
//! by a `widget.json` that `package_manifest` validates; installed packages may not
//! declare a collector.
use crate::package_manifest::{self, Manifest, Origin, Tier};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};
use tauri::Manager;
use zip::ZipArchive;

pub const MAX_PACKAGE: usize = 8 * 1024 * 1024;
const MAX_FILE: u64 = 4 * 1024 * 1024;
const MAX_FILES: usize = 256;
const EXTENSIONS: &[&str] = &[
    "html", "js", "mjs", "css", "json", "png", "jpg", "jpeg", "gif", "webp", "svg", "ttf", "otf",
    "woff", "woff2", "txt", "md",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    #[serde(flatten)]
    pub manifest: Manifest,
    pub origin: &'static str,
    pub tier: Tier,
    pub icon_data: Option<String>,
}

/// Files of a package, keyed by their path relative to `widget.json`.
pub type Files = BTreeMap<String, Vec<u8>>;

fn allowed_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let file = lower.rsplit('/').next().unwrap_or("");
    file.starts_with("license")
        || file.starts_with("notice")
        || lower.rsplit_once('.').is_some_and(|(_, ext)| EXTENSIONS.contains(&ext))
}

/// Read a package ZIP. Rejects traversal, links, oversized or unexpected files, and
/// anything outside the folder that holds `widget.json`.
pub fn extract(bytes: &[u8]) -> Result<(Value, Files), String> {
    if bytes.len() > MAX_PACKAGE {
        return Err("Packages must be 8 MiB or smaller.".into());
    }
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|_| "Choose a widget package ZIP.")?;
    let names: Vec<String> = zip.file_names().map(str::to_owned).collect();
    let manifests: Vec<_> = names
        .iter()
        .filter(|n| !n.starts_with("__MACOSX/") && (*n == "widget.json" || n.ends_with("/widget.json")))
        .collect();
    let [manifest_name] = manifests.as_slice() else {
        return Err("Include one widget.json in the ZIP.".into());
    };
    let prefix = manifest_name.trim_end_matches("widget.json").to_string();
    if zip.len() > MAX_FILES + 16 {
        return Err(format!("Packages may contain at most {MAX_FILES} files."));
    }
    let mut files = Files::new();
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut file = zip.by_index(index).map_err(|_| "Unreadable ZIP entry")?;
        let name = file.name().to_string();
        if name.starts_with("__MACOSX/") || name.ends_with("/.DS_Store") || name == ".DS_Store" {
            continue;
        }
        if file.enclosed_name().is_none() || name.contains('\\') {
            return Err(format!("“{name}” points outside the package."));
        }
        if file.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            return Err(format!("“{name}” is a link. Packages can’t contain links."));
        }
        if file.is_dir() {
            continue;
        }
        let Some(relative) = name.strip_prefix(&prefix) else {
            return Err(format!("“{name}” is outside the folder that holds widget.json."));
        };
        package_manifest::package_path(relative, "Package file")?;
        if !allowed_name(relative) {
            return Err(format!("“{relative}” isn’t a file type packages can include."));
        }
        if file.size() > MAX_FILE {
            return Err(format!("“{relative}” is larger than 4 MiB."));
        }
        let mut data = Vec::new();
        (&mut file).take(MAX_FILE + 1).read_to_end(&mut data).map_err(|e| e.to_string())?;
        total += data.len() as u64;
        if data.len() as u64 > MAX_FILE || total > MAX_PACKAGE as u64 * 2 {
            return Err("The package expands to more than its limits allow.".into());
        }
        if files.insert(relative.to_string(), data).is_some() {
            return Err(format!("“{relative}” appears twice."));
        }
        if files.len() > MAX_FILES {
            return Err(format!("Packages may contain at most {MAX_FILES} files."));
        }
    }
    let manifest = serde_json::from_slice(files.get("widget.json").ok_or("Missing widget.json")?)
        .map_err(|_| "Invalid widget.json")?;
    Ok((manifest, files))
}

/// Validate an installed package's manifest and check the files it names exist.
pub fn check(raw: &Value, files: &Files) -> Result<Manifest, String> {
    let manifest = package_manifest::validate(raw, Origin::Installed)?;
    let mut needed = vec![manifest.icon.as_str(), manifest.view.entry.as_str()];
    if let Some(connector) = &manifest.connector {
        needed.push(&connector.entry);
    }
    for file in needed {
        if !files.contains_key(file) {
            return Err(format!("widget.json names “{file}”, which isn’t in the package."));
        }
    }
    Ok(manifest)
}

pub fn icon_data(path: &str, bytes: &[u8]) -> Option<String> {
    let png = bytes.starts_with(b"\x89PNG\r\n\x1a\n");
    let svg = path.to_ascii_lowercase().ends_with(".svg")
        && std::str::from_utf8(bytes).is_ok_and(|s| s.contains("<svg"));
    if bytes.len() > 256 * 1024 || !(png || svg) {
        return None;
    }
    let mime = if png { "image/png" } else { "image/svg+xml" };
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn info(manifest: Manifest, origin: Origin, dir: &Path) -> PackageInfo {
    let icon_data = fs::read(dir.join(&manifest.icon)).ok().and_then(|b| icon_data(&manifest.icon, &b));
    PackageInfo {
        tier: manifest.tier(),
        origin: if origin == Origin::Bundled { "bundled" } else { "installed" },
        icon_data,
        manifest,
    }
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

/// A package by ID: bundled first, so an installed package can never replace one.
#[allow(dead_code)] // The manifest-driven widget host looks packages up with this.
pub fn find(app: &tauri::AppHandle, id: &str) -> Option<(PackageInfo, PathBuf)> {
    for (root, origin) in [(bundled_root(app).ok()?, Origin::Bundled), (installed_root(app).ok()?, Origin::Installed)] {
        if let Some(found) = read_root(&root, origin).into_iter().find(|p| p.manifest.id == id) {
            return Some((found, root.join(id)));
        }
    }
    None
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
    let manifest = check(&raw, &files)?;
    let icon = icon_data(&manifest.icon, &files[&manifest.icon]).ok_or("The icon must be a PNG or SVG up to 256 KiB.")?;
    serde_json::to_value(PackageInfo { tier: manifest.tier(), origin: "installed", icon_data: Some(icon), manifest })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn install_widget_package(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<PackageInfo, String> {
    settings_only(&window)?;
    let (raw, files) = extract(raw_body(&request)?)?;
    let manifest = check(&raw, &files)?;
    let root = installed_root(&app)?;
    install_files(&root, &manifest, &files)?;
    Ok(info(manifest, Origin::Installed, &root.join(&raw["id"].as_str().unwrap_or_default())))
}

#[tauri::command]
pub fn list_packages(app: tauri::AppHandle) -> Result<Vec<PackageInfo>, String> {
    let mut all = read_root(&bundled_root(&app)?, Origin::Bundled);
    let bundled: Vec<String> = all.iter().map(|p| p.manifest.id.clone()).collect();
    all.extend(read_root(&installed_root(&app)?, Origin::Installed).into_iter().filter(|p| !bundled.contains(&p.manifest.id)));
    Ok(all)
}

#[tauri::command]
pub fn remove_widget_package(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String) -> Result<(), String> {
    settings_only(&window)?;
    let rest = id.strip_prefix("plugin.").unwrap_or("");
    if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-.".contains(&b)) || rest.contains("..") {
        return Err("Unknown package".into());
    }
    match fs::remove_dir_all(installed_root(&app)?.join(&id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
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
    fn svg_icons_are_accepted_as_data_uris_and_other_files_are_not() {
        assert!(icon_data("icon.svg", b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap().starts_with("data:image/svg+xml;base64,"));
        assert!(icon_data("icon.svg", b"not an image").is_none());
        assert!(icon_data("icon.png", b"GIF89a").is_none());
    }
}
