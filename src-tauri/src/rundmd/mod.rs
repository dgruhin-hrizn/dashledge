mod card;
mod imgc;

use card::Card;
use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{ipc::Response, AppHandle, Manager};
use tempfile::NamedTempFile;

struct Loaded {
    card: Card,
    revision: u64,
}
static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);

fn location(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("rundmd.img"))
}
fn seed(app: &AppHandle) -> Option<PathBuf> {
    let path = app.path().resource_dir().ok()?.join("rundmd-default.imgc");
    if path.is_file() { return Some(path); }
    let saved = app.path().app_data_dir().ok()?.join("rundmd-default.imgc");
    saved.is_file().then_some(saved)
}
#[tauri::command]
pub fn rundmd_has_default(app: AppHandle) -> bool {
    seed(&app).is_some()
}

fn import_image(source: &Path, directory: &Path) -> io::Result<(NamedTempFile, Card)> {
    let mut input = File::open(source)?;
    let mut magic = [0; 3];
    input.read_exact(&mut magic)?;
    input.rewind()?;
    let mut temp = NamedTempFile::new_in(directory)?;
    if &magic == b"DGD" {
        let raw = Card::open(input.try_clone()?)?;
        input.rewind()?;
        io::copy(&mut input.take(raw.used_bytes), temp.as_file_mut())?;
    } else {
        imgc::expand(&mut input, temp.as_file_mut())?;
    }
    let card = Card::open(temp.reopen()?)?;
    temp.as_file().set_len(card.used_bytes)?;
    Ok((temp, card))
}

fn catalog(app: &AppHandle) -> Result<serde_json::Value, String> {
    let mut loaded = LOADED.lock().map_err(|e| e.to_string())?;
    if loaded.is_none() {
        let path = location(app)?;
        let card = if path.exists() {
            Card::open(File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?
        } else if let Some(source) = seed(app) {
            let dir = path.parent().unwrap();
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            let (temp, card) = import_image(&source, dir).map_err(|e| e.to_string())?;
            temp.persist(&path).map_err(|e| e.to_string())?;
            card
        } else {
            return Ok(serde_json::Value::Null);
        };
        *loaded = Some(Loaded { card, revision: 1 });
    }
    Ok(summary(loaded.as_ref().unwrap()))
}
fn summary(loaded: &Loaded) -> serde_json::Value {
    serde_json::json!({"version":loaded.card.catalog.version, "clips":loaded.card.catalog.clips,"revision":loaded.revision})
}
#[tauri::command]
pub async fn rundmd_catalog(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || catalog(&app))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn rundmd_import(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let Some(handle) = rfd::AsyncFileDialog::new()
        .set_title("Open a Run-DMD card image (.imgc or .img)")
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let source = handle.path().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let path = location(&app)?;
        let dir = path.parent().unwrap();
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let (temp, card) = import_image(&source, dir).map_err(|e| e.to_string())?;
        let mut guard = LOADED.lock().map_err(|e| e.to_string())?;
        temp.persist(&path).map_err(|e| e.to_string())?;
        let revision = guard.as_ref().map_or(1, |c| c.revision + 1);
        *guard = Some(Loaded { card, revision });
        Ok(Some(summary(guard.as_ref().unwrap())))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn rundmd_clip(revision: u64, index: Option<usize>) -> Result<Response, String> {
    let mut guard = LOADED.lock().map_err(|e| e.to_string())?;
    let card = &mut guard
        .as_mut()
        .filter(|c| c.revision == revision)
        .ok_or("The Run-DMD card changed. Reopen its catalog.")?
        .card;
    let data = if let Some(index) = index {
        card.clip(index)
    } else {
        // Startup artwork precedes the final reserved sector of the header area.
        let mut data = vec![0; 0xc400];
        card.file
            .seek(SeekFrom::Start(512))
            .and_then(|_| card.file.read_exact(&mut data))
            .map(|_| {
                let used = data
                    .iter()
                    .rposition(|v| *v != 0)
                    .map_or(0, |i| (i / 64 + 1) * 64);
                data.truncate(used);
                data
            })
    }
    .map_err(|e| e.to_string())?;
    Ok(Response::new(data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn b134_directory_bitmap_and_timing_indirection() {
        let mut bytes = vec![0; 0xc800 + 1024 + 2048];
        bytes[..5].copy_from_slice(b"DGD\x00\x01");
        bytes[495..499].copy_from_slice(b"B134");
        let h = &mut bytes[0xc800..0xca00];
        h[2] = 1;
        h[3] = 1;
        h[7] = 101;
        h[8] = 3;
        h[20..28].copy_from_slice(b"GAME_001");
        bytes[0xca00..0xca06].copy_from_slice(&[1, 50, 0, 32, 1, 105]);
        bytes[0xcc00] = 0xfa;
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(&bytes).unwrap();
        let mut card = Card::open(f.reopen().unwrap()).unwrap();
        assert_eq!(card.catalog.clips[0].name, "GAME_001");
        assert_eq!(
            &card.clip(0).unwrap()[8..16],
            &[3, 1, 50, 0, 32, 1, 105, 0xfa]
        );
        bytes[0xca00] = 2;
        fs::write(f.path(), &bytes).unwrap();
        assert!(Card::open(f.reopen().unwrap()).is_err());
    }
    #[test]
    fn supplied_image_if_available() {
        let Some(path) = std::env::var_os("RUNDMD_TEST_IMAGE") else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let (_, mut card) = import_image(Path::new(&path), dir.path()).unwrap();
        assert_eq!(card.catalog.version, "B134");
        assert_eq!(card.catalog.clips.len(), 2302);
        let mut frames = 0;
        for index in 0..card.catalog.clips.len() {
            frames += card.clip(index).unwrap()[8] as usize;
        }
        assert_eq!(frames, 65882);
    }
}
