use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::io::{Cursor, Read, Write};
use zip::{write::FileOptions, ZipArchive, ZipWriter};

const LIMIT: usize = 64 * 1024;

fn entry(archive: &mut ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Result<Vec<u8>, String> {
    let file = archive
        .by_name(name)
        .map_err(|_| format!("Missing {name}"))?;
    let mut bytes = Vec::new();
    file.take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > LIMIT {
        return Err(format!("{name} exceeds 64 KiB"));
    }
    Ok(bytes)
}

pub(crate) fn unpack(bytes: Vec<u8>) -> Result<Value, String> {
    if bytes.len() > 512 * 1024 {
        return Err("Packages must be 512 KiB or smaller.".into());
    }
    let mut zip = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "Choose a widget ZIP or a legacy JSON package.")?;
    let manifests: Vec<_> = zip
        .file_names()
        .filter(|n| {
            !n.starts_with("__MACOSX/") && (n == &"widget.json" || n.ends_with("/widget.json"))
        })
        .map(str::to_owned)
        .collect();
    let [name] = manifests.as_slice() else {
        return Err("Include one widget.json in the ZIP.".into());
    };
    let mut manifest: Value =
        serde_json::from_slice(&entry(&mut zip, name)?).map_err(|_| "Invalid widget.json")?;
    let icon = manifest["icon"]
        .as_str()
        .ok_or("Specify the PNG icon filename in widget.json.")?;
    if icon.contains(['/', '\\']) || !icon.to_ascii_lowercase().ends_with(".png") {
        return Err("Place the PNG icon alongside widget.json.".into());
    }
    let image = entry(
        &mut zip,
        &format!("{}{icon}", name.trim_end_matches("widget.json")),
    )?;
    if !image.starts_with(b"\x89PNG\r\n\x1a\n")
        || image.get(12..16) != Some(b"IHDR")
        || image.len() < 24
    {
        return Err("The icon must be a PNG file.".into());
    }
    let width = u32::from_be_bytes(image[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(image[20..24].try_into().unwrap());
    if width != height || !(1..=512).contains(&width) {
        return Err("Use a square PNG up to 512 × 512 pixels.".into());
    }
    manifest["iconData"] =
        Value::String(format!("data:image/png;base64,{}", STANDARD.encode(image)));
    Ok(manifest)
}

/// The example package Widget Studio offers: installable as downloaded.
fn example() -> Result<Vec<u8>, String> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("widget.json", include_bytes!("../../widgets/example/widget.json").as_slice()),
        ("icon.svg", include_bytes!("../../widgets/example/icon.svg").as_slice()),
        ("index.html", include_bytes!("../../widgets/example/index.html").as_slice()),
        ("view.js", include_bytes!("../../widgets/example/view.js").as_slice()),
        ("style.css", include_bytes!("../../widgets/example/style.css").as_slice()),
        ("connector.js", include_bytes!("../../widgets/example/connector.js").as_slice()),
        ("README.md", include_bytes!("../../widgets/example/README.md").as_slice()),
        ("dashledge.d.ts", include_bytes!("../../widgets/example/dashledge.d.ts").as_slice()),
        ("samples/declarative.widget.json", include_bytes!("../../widgets/example/samples/declarative.widget.json").as_slice()),
    ] {
        zip.start_file(name, FileOptions::default())
            .map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())?;
    }
    zip.finish()
        .map(|c| c.into_inner())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_widget_example(window: tauri::WebviewWindow) -> Result<bool, String> {
    if window.label() != "settings" {
        return Err("Open Widget Studio in Settings.".into());
    }
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name("Weather-example.dashledge.zip")
        .add_filter("Widget package", &["zip"])
        .save_file()
        .await
    else {
        return Ok(false);
    };
    file.write(&example()?).await.map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exported_example_is_an_installable_connector_package() {
        let (raw, files) = crate::package_store::extract(&example().unwrap()).unwrap();
        let manifest = crate::package_store::check(&raw, &files).unwrap();
        assert_eq!(manifest.id, "plugin.weather-example");
        assert_eq!(manifest.tier(), crate::package_manifest::Tier::Connector);
        assert_eq!(manifest.connector.unwrap().hosts, ["https://api.open-meteo.com"]);
        assert!(crate::package_store::icon_data(&manifest.icon, &files[&manifest.icon]).is_some());
        // The tier 1 sample in the ZIP is a valid manifest too.
        let sample: serde_json::Value = serde_json::from_slice(&files["samples/declarative.widget.json"]).unwrap();
        let sample = crate::package_manifest::validate(&sample, crate::package_manifest::Origin::Installed).unwrap();
        assert_eq!(sample.tier(), crate::package_manifest::Tier::Declarative);
        assert!(unpack(vec![0; 512 * 1024 + 1]).is_err());
    }
}
