//! Package ZIPs: reading one safely and checking the files its manifest names.
use crate::manifest::{self as package_manifest, Manifest, Origin};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{Cursor, Read},
    path::Path,
};
use zip::ZipArchive;

pub const MAX_PACKAGE: usize = 8 * 1024 * 1024;
pub const MAX_FILE: u64 = 4 * 1024 * 1024;
pub const MAX_FILES: usize = 256;
pub const EXTENSIONS: &[&str] = &[
    "html", "js", "mjs", "css", "json", "png", "jpg", "jpeg", "gif", "webp", "svg", "ttf", "otf",
    "woff", "woff2", "txt", "md", "ts",
];

/// Files of a package, keyed by their path relative to `widget.json`.
pub type Files = BTreeMap<String, Vec<u8>>;

pub fn allowed_name(name: &str) -> bool {
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

/// Write a package's files as a ZIP, the same bytes every time for the same files: names
/// in order, a fixed timestamp and no folder entries. `extract` reads it back.
pub fn pack(files: &Files) -> Result<Vec<u8>, String> {
    use std::io::Write;
    use zip::{write::FileOptions, CompressionMethod, ZipWriter};
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = FileOptions::default().compression_method(CompressionMethod::Deflated).unix_permissions(0o644);
    for (name, bytes) in files {
        zip.start_file(name.as_str(), options).map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())?;
    }
    let bytes = zip.finish().map_err(|e| e.to_string())?.into_inner();
    if bytes.len() > MAX_PACKAGE {
        return Err("The package is larger than 8 MiB once zipped.".into());
    }
    Ok(bytes)
}

/// A package icon as a data URI: a PNG, or an SVG, up to 256 KiB.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_packed_folder_reads_back_and_packs_to_the_same_bytes() {
        let mut files = Files::new();
        files.insert("widget.json".into(), br#"{"apiVersion": 2, "id": "plugin.alice.queue", "title": "Queue", "icon": "icon.svg", "view": {"entry": "view/index.html"}}"#.to_vec());
        files.insert("icon.svg".into(), b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec());
        files.insert("view/index.html".into(), b"<!doctype html>".to_vec());
        let packed = pack(&files).unwrap();
        assert_eq!(pack(&files).unwrap(), packed, "packing is deterministic");
        let (raw, read) = extract(&packed).unwrap();
        assert_eq!(read, files);
        assert_eq!(check(&raw, &read).unwrap().id, "plugin.alice.queue");
    }
}
