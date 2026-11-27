//! Natural voices: Kokoro-82M (Apache-2.0) run by sherpa-onnx (Apache-2.0), downloaded
//! on request from the official k2-fsa/sherpa-onnx GitHub releases and never bundled.
//! Every file is checked against a pinned SHA-256 before it is unpacked.
//!
//! Speaking runs the downloaded `sherpa-onnx-offline-tts` as a separate process for
//! each line, writing a WAV that `speech.m` plays at Dashledge's own volume. Nothing
//! stays in memory between lines, and a separate process means macOS never has to
//! load unsigned code into Dashledge itself.

use ring::digest::{Context, SHA256};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

struct Download {
    name: &'static str,
    url: &'static str,
    sha256: &'static str,
    /// Approximate size in bytes, for progress before the server says.
    size: u64,
}

const DOWNLOADS: [Download; 3] = [
    Download {
        name: "model",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2",
        sha256: "c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd",
        size: 103_000_000,
    },
    Download {
        name: "runtime",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.3/sherpa-onnx-v2.0.3-osx-arm64-shared.tar.bz2",
        sha256: "14afb4ed15dc4f376c69be5a795039824e47f5ffcfc2488556f796ecaf420d07",
        size: 21_000_000,
    },
    Download {
        name: "lexicon",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/lexicon-en-us.txt",
        sha256: "8b67ae549a465eee78f92ecb74644ad90c3c58ce65f19c68baf85878a10ef73a",
        size: 6_500_000,
    },
];

/// The download size shown before installing, in megabytes.
pub fn download_mb() -> u64 {
    DOWNLOADS.iter().map(|d| d.size).sum::<u64>() / 1_000_000
}

/// Kokoro v0.19's speakers, by speaker id: (id, name, accent).
pub const VOICES: [(u32, &str, &str); 11] = [
    (0, "Kokoro", "US"),
    (1, "Bella", "US"),
    (2, "Nicole", "US"),
    (3, "Sarah", "US"),
    (4, "Sky", "US"),
    (5, "Adam", "US"),
    (6, "Michael", "US"),
    (7, "Emma", "UK"),
    (8, "Isabella", "UK"),
    (9, "George", "UK"),
    (10, "Lewis", "UK"),
];

/// The speaker for a `kokoro:<name>` voice id, by its lowercase name.
pub fn speaker(voice: &str) -> Option<u32> {
    let name = voice.strip_prefix("kokoro:")?;
    VOICES.iter().find(|(_, n, _)| n.eq_ignore_ascii_case(name)).map(|(id, ..)| *id)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Missing,
    Downloading { progress: f32 },
    Ready,
    Failed { detail: String },
}

static STATUS: OnceLock<Mutex<Status>> = OnceLock::new();
static ROOT: OnceLock<PathBuf> = OnceLock::new();

fn status_cell() -> &'static Mutex<Status> {
    STATUS.get_or_init(|| Mutex::new(Status::Missing))
}

fn set_status(next: Status) {
    *status_cell().lock().unwrap() = next;
}

pub fn init(app_data: &Path) {
    let root = app_data.join("voices").join("kokoro");
    let _ = ROOT.set(root);
    set_status(if ready() { Status::Ready } else { Status::Missing });
}

fn root() -> Option<&'static PathBuf> {
    ROOT.get()
}

struct Paths {
    bin: PathBuf,
    model: PathBuf,
    voices: PathBuf,
    tokens: PathBuf,
    lexicon: PathBuf,
}

fn paths() -> Option<Paths> {
    let root = root()?;
    let model = root.join("model");
    Some(Paths {
        bin: root.join("runtime").join("bin").join("sherpa-onnx-offline-tts"),
        model: model.join("model.int8.onnx"),
        voices: model.join("voices.bin"),
        tokens: model.join("tokens.txt"),
        lexicon: root.join("lexicon-en-us.txt"),
    })
}

/// Whether every file speaking needs is in place.
pub fn ready() -> bool {
    paths().is_some_and(|p| [&p.bin, &p.model, &p.voices, &p.tokens, &p.lexicon].iter().all(|f| f.is_file()))
}

pub fn status() -> Status {
    status_cell().lock().unwrap().clone()
}

/// Downloads, checks and unpacks everything. Runs once at a time.
pub async fn install() -> Result<(), String> {
    {
        let mut status = status_cell().lock().unwrap();
        if matches!(*status, Status::Downloading { .. }) {
            return Err("Natural voices are already downloading.".into());
        }
        *status = Status::Downloading { progress: 0.0 };
    }
    let result = install_inner().await;
    set_status(match &result {
        Ok(()) => Status::Ready,
        Err(detail) => Status::Failed { detail: detail.clone() },
    });
    result
}

async fn install_inner() -> Result<(), String> {
    let root = root().ok_or("Voices aren't ready yet.")?.clone();
    let staging = root.with_file_name("kokoro-staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder().user_agent("Dashledge").build().map_err(|e| e.to_string())?;
    let total: u64 = DOWNLOADS.iter().map(|d| d.size).sum();
    let mut done = 0u64;
    for download in &DOWNLOADS {
        let file = staging.join(download.name);
        fetch(&client, download, &file, done, total).await?;
        done += download.size;
    }
    // Unpack: the model folder, then only the runtime's program and libraries.
    untar(&staging.join("model"), &staging)?;
    let model_dir = staging.join("kokoro-int8-en-v0_19");
    if !model_dir.join("model.int8.onnx").is_file() {
        return Err("The voice download wasn't what Dashledge expected.".into());
    }
    std::fs::rename(&model_dir, staging.join("model-files")).map_err(|e| e.to_string())?;
    untar(&staging.join("runtime"), &staging)?;
    let runtime_dir = std::fs::read_dir(&staging)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && path.file_name().is_some_and(|n| n.to_string_lossy().starts_with("sherpa-onnx-v")))
        .ok_or("The speech runtime download wasn't what Dashledge expected.")?;
    let runtime = staging.join("runtime-files");
    std::fs::create_dir_all(runtime.join("bin")).map_err(|e| e.to_string())?;
    std::fs::rename(runtime_dir.join("lib"), runtime.join("lib")).map_err(|e| e.to_string())?;
    std::fs::rename(runtime_dir.join("bin").join("sherpa-onnx-offline-tts"), runtime.join("bin").join("sherpa-onnx-offline-tts")).map_err(|e| e.to_string())?;

    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    std::fs::rename(staging.join("model-files"), root.join("model")).map_err(|e| e.to_string())?;
    std::fs::rename(&runtime, root.join("runtime")).map_err(|e| e.to_string())?;
    std::fs::rename(staging.join("lexicon"), root.join("lexicon-en-us.txt")).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&staging);
    if !ready() {
        return Err("Natural voices didn't install completely.".into());
    }
    // A short line proves the runtime starts on this Mac.
    synthesize("Ready.", 1, None, &root.join("check.wav"))?;
    let _ = std::fs::remove_file(root.join("check.wav"));
    Ok(())
}

async fn fetch(client: &reqwest::Client, download: &Download, file: &Path, done: u64, total: u64) -> Result<(), String> {
    let failed = |e: String| format!("Couldn't download natural voices: {e}");
    let mut response = client.get(download.url).send().await.map_err(|e| failed(e.to_string()))?;
    if !response.status().is_success() {
        return Err(failed(format!("GitHub answered {}", response.status())));
    }
    let mut out = std::fs::File::create(file).map_err(|e| e.to_string())?;
    let mut digest = Context::new(&SHA256);
    let mut got = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|e| failed(e.to_string()))? {
        digest.update(&chunk);
        out.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        set_status(Status::Downloading { progress: ((done + got.min(download.size)) as f32 / total as f32).min(0.99) });
    }
    let sum: String = digest.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect();
    if sum != download.sha256 {
        let _ = std::fs::remove_file(file);
        return Err("A natural-voice download didn't match its checksum, so Dashledge discarded it.".into());
    }
    Ok(())
}

fn untar(archive: &Path, into: &Path) -> Result<(), String> {
    let status = Command::new("/usr/bin/tar").arg("-xjf").arg(archive).arg("-C").arg(into).status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Couldn't unpack the natural-voice download.".into());
    }
    let _ = std::fs::remove_file(archive);
    Ok(())
}

/// Deletes the downloaded voices.
pub fn remove() -> Result<(), String> {
    if matches!(status(), Status::Downloading { .. }) {
        return Err("Wait for the download to finish.".into());
    }
    if let Some(root) = root() {
        std::fs::remove_dir_all(root).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e.to_string()) })?;
    }
    set_status(Status::Missing);
    Ok(())
}

/// The installed pronunciation dictionary, read for one line (about 170,000 words).
pub fn lexicon() -> crate::pronounce::Lexicon {
    paths().and_then(|p| std::fs::read_to_string(p.lexicon).ok()).map(|text| crate::pronounce::parse_lexicon(&text)).unwrap_or_default()
}

/// Writes `text` spoken by `speaker` to `out` as a WAV, with `extra` (pronunciations
/// for words the dictionary lacks) read before the main dictionary. About a second.
pub fn synthesize(text: &str, speaker: u32, extra: Option<&Path>, out: &Path) -> Result<(), String> {
    let p = paths().ok_or("Natural voices aren't installed.")?;
    let lexicons = match extra {
        Some(extra) => format!("{},{}", extra.display(), p.lexicon.display()),
        None => p.lexicon.display().to_string(),
    };
    // Two sentences are made at once, so each takes half the cores (up to four).
    let threads = std::thread::available_parallelism().map(|n| (n.get() / 2).clamp(1, 4)).unwrap_or(2);
    let output = Command::new(&p.bin)
        .arg(format!("--kokoro-model={}", p.model.display()))
        .arg(format!("--kokoro-voices={}", p.voices.display()))
        .arg(format!("--kokoro-tokens={}", p.tokens.display()))
        .arg(format!("--kokoro-lexicon={lexicons}"))
        .arg(format!("--num-threads={threads}"))
        .arg(format!("--sid={speaker}"))
        .arg(format!("--output-filename={}", out.display()))
        // The runtime reads anything starting with "-" as an option.
        .arg(text.trim_start_matches(|c: char| c == '-' || c.is_whitespace()))
        .output()
        .map_err(|e| format!("Couldn't start the natural voice: {e}"))?;
    if !output.status.success() || !out.is_file() {
        return Err("The natural voice couldn't say that.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voices_resolve_by_name() {
        assert_eq!(speaker("kokoro:bella"), Some(1));
        assert_eq!(speaker("kokoro:George"), Some(9));
        assert_eq!(speaker("kokoro:nobody"), None);
        assert_eq!(speaker("com.apple.voice.compact.en-US.Samantha"), None);
    }

    /// Downloads for real (about 130 MB): `KOKORO_TEST_DIR=/tmp/x cargo test -- --ignored natural_voice_installs`.
    #[test]
    #[ignore]
    fn natural_voice_installs_and_speaks() {
        let dir = PathBuf::from(std::env::var("KOKORO_TEST_DIR").expect("set KOKORO_TEST_DIR"));
        init(&dir);
        tauri::async_runtime::block_on(install()).expect("install");
        assert_eq!(status(), Status::Ready);
        let out = dir.join("george.wav");
        let started = std::time::Instant::now();
        synthesize("-- Laundry is due now.", 9, None, &out).expect("speak");
        eprintln!("synthesized in {:?}, {} bytes", started.elapsed(), std::fs::metadata(&out).unwrap().len());
        remove().unwrap();
        assert!(!ready());
    }

    #[test]
    fn downloads_are_pinned() {
        for download in &DOWNLOADS {
            assert!(download.url.starts_with("https://github.com/k2-fsa/sherpa-onnx/releases/download/"));
            assert_eq!(download.sha256.len(), 64);
            assert!(download.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
        }
        assert!((120..140).contains(&download_mb()));
    }
}
