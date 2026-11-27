//! Dashledge's voice: one set of settings for the whole app (voice, volume, mute, quiet
//! hours) used by spoken reminders and by any widget with the `speech` permission.
//! Natural voices (Kokoro, `kokoro.rs`) are an optional download; without them the
//! Mac's installed voices speak. Speech plays through Dashledge's own audio, so volume
//! and mute never touch the system volume.
//!
//! Spoken reminders are a background loop: it reads open reminders with a due time and
//! says them when they come due (and, optionally, a few minutes before). Quiet hours
//! hold those alerts until they end; mute drops them.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

extern "C" {
    fn speech_say(text: *const c_char, voice: *const c_char, volume: f32);
    fn speech_play_file(path: *const c_char, volume: f32);
    fn speech_stop();
    fn speech_voices() -> *mut c_char;
    fn free(ptr: *mut c_void);
}

/// The longest line a widget may have spoken.
pub const MAX_SPEECH: usize = 500;
/// The natural voice used when none is chosen and natural voices are installed.
const NATURAL_DEFAULT: &str = "kokoro:Bella";

/// Lead times a view may choose, in minutes.
pub const LEADS: [u32; 6] = [0, 5, 10, 15, 30, 60];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Voice {
    /// Speak reminders at all.
    pub enabled: bool,
    /// Silence Dashledge's voice until unmuted; alerts in the meantime are dropped.
    pub muted: bool,
    /// Also speak this many minutes before the due time; 0 for only at the time.
    pub lead: u32,
    pub quiet: bool,
    /// Quiet hours as minutes after midnight, local time. Start after end spans midnight.
    pub quiet_start: u32,
    pub quiet_end: u32,
    /// 0…1, relative to the system volume.
    pub volume: f32,
    /// `kokoro:<Name>` for a natural voice, an installed Mac voice's identifier, or
    /// empty for the best available (a natural voice when installed).
    pub voice: String,
}

impl Default for Voice {
    fn default() -> Self {
        Voice { enabled: false, muted: false, lead: 0, quiet: true, quiet_start: 22 * 60, quiet_end: 7 * 60, volume: 0.8, voice: String::new() }
    }
}

impl Voice {
    /// Whatever a view sent, made valid: known lead times, quarter-hour quiet times,
    /// volume within 0…1 and a plain voice identifier.
    pub fn cleaned(mut self) -> Self {
        if !LEADS.contains(&self.lead) {
            self.lead = 0;
        }
        self.quiet_start = (self.quiet_start % 1440) / 15 * 15;
        self.quiet_end = (self.quiet_end % 1440) / 15 * 15;
        self.volume = if self.volume.is_finite() { self.volume.clamp(0.0, 1.0) } else { 0.8 };
        if self.voice.len() > 200 || !self.voice.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':')) {
            self.voice.clear();
        }
        self
    }

    /// Whether `minute` (after local midnight) falls in quiet hours.
    pub fn quiet_at(&self, minute: u32) -> bool {
        let (start, end) = (self.quiet_start, self.quiet_end);
        if !self.quiet || start == end {
            return false;
        }
        if start < end { minute >= start && minute < end } else { minute >= start || minute < end }
    }
}

/// An open reminder with a due time, in milliseconds since the epoch.
#[derive(Clone, Debug)]
pub struct Due {
    pub id: String,
    pub title: String,
    pub due_at: i64,
}

/// What to say now: `(key, id, text)` for each alert whose moment passed within the
/// last `window` milliseconds. Keys are unique per reminder, due time and kind, so a
/// caller that remembers them says each alert once.
pub fn alerts(items: &[Due], lead: u32, now: i64, window: i64) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for item in items {
        let title = item.title.trim();
        let title = if title.is_empty() { "A reminder" } else { title };
        let mut moments = vec![(item.due_at, "now", format!("{title} is due now."))];
        if lead > 0 {
            let soon = if lead == 60 { "in an hour".to_string() } else { format!("in {lead} minutes") };
            moments.push((item.due_at - i64::from(lead) * 60_000, "soon", format!("{title} is due {soon}.")));
        }
        for (at, kind, text) in moments {
            if at <= now && now - at < window {
                out.push((format!("{}@{}@{kind}", item.id, item.due_at), item.id.clone(), text));
            }
        }
    }
    out
}

/// The sentence for alerts held through quiet hours, naming those still open.
pub fn held_summary(titles: &[String]) -> Option<String> {
    let titles: Vec<&str> = titles.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
    let list = match titles.as_slice() {
        [] => return None,
        [one] => format!("{one} was"),
        [a, b] => format!("{a} and {b} were"),
        [rest @ .., last] => format!("{}, and {last} were", rest.join(", ")),
    };
    Some(format!("During quiet hours, {list} due."))
}

struct Store {
    path: PathBuf,
    voice: Voice,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
static SPEAKER: OnceLock<Mutex<Sender<(String, Voice)>>> = OnceLock::new();
static AUDIO_DIR: OnceLock<PathBuf> = OnceLock::new();
static LAST_WIDGET_LINE: Mutex<Option<Instant>> = Mutex::new(None);

fn current() -> Voice {
    STORE.get().map(|s| s.lock().unwrap().voice.clone()).unwrap_or_default()
}

/// Which engine a voice choice uses: a natural speaker, or a Mac voice id ('' = best).
pub fn engine(voice: &str, natural_ready: bool) -> Result<u32, String> {
    if let Some(speaker) = crate::kokoro::speaker(voice) {
        if natural_ready {
            return Ok(speaker);
        }
        return Err(String::new());
    }
    if voice.is_empty() && natural_ready {
        return Ok(crate::kokoro::speaker(NATURAL_DEFAULT).unwrap_or(1));
    }
    Err(if voice.starts_with("kokoro:") { String::new() } else { voice.to_string() })
}

fn mac_say(text: &str, voice_id: &str, volume: f32) {
    let (Ok(text), Ok(id)) = (CString::new(text), CString::new(voice_id)) else { return };
    unsafe { speech_say(text.as_ptr(), id.as_ptr(), volume) };
}

/// Speaks one line now, replacing whatever is playing. Natural voices synthesize first
/// (about a second); if that fails the Mac voice says it instead.
fn speak_now(text: &str, voice: &Voice) {
    match engine(&voice.voice, crate::kokoro::ready()) {
        Ok(speaker) => {
            let dir = AUDIO_DIR.get().cloned().unwrap_or_else(std::env::temp_dir);
            let _ = std::fs::create_dir_all(&dir);
            let file = dir.join(format!("line-{}.wav", std::process::id()));
            match crate::kokoro::synthesize(text, speaker, &file) {
                Ok(()) => {
                    if let Ok(path) = CString::new(file.to_string_lossy().as_bytes()) {
                        unsafe { speech_play_file(path.as_ptr(), voice.volume) };
                    }
                }
                Err(_) => mac_say(text, "", voice.volume),
            }
        }
        Err(mac_voice) => mac_say(text, &mac_voice, voice.volume),
    }
}

/// Queues a line for the speaker thread, so callers never wait on synthesis.
fn say(text: &str, voice: &Voice) {
    if let Some(tx) = SPEAKER.get() {
        let _ = tx.lock().unwrap().send((text.to_string(), voice.clone()));
    }
}

fn local_minute() -> u32 {
    let local = chrono::Local::now();
    chrono::Timelike::hour(&local) * 60 + chrono::Timelike::minute(&local)
}

/// A line from a widget, which `speech.say` sends: trimmed, one line, at most 500
/// characters. Refused while muted or in quiet hours, and at most one a second.
pub fn widget_line(text: &str) -> Result<String, &'static str> {
    let line: String = text.trim().chars().map(|c| if c.is_control() { ' ' } else { c }).take(MAX_SPEECH).collect();
    let line = line.trim().to_string();
    if line.is_empty() {
        return Err("empty");
    }
    Ok(line)
}

fn voices() -> Value {
    unsafe {
        let ptr = speech_voices();
        if ptr.is_null() {
            return Value::Array(vec![]);
        }
        let value = serde_json::from_slice(CStr::from_ptr(ptr).to_bytes()).unwrap_or(Value::Array(vec![]));
        free(ptr.cast());
        value
    }
}

/// Every voice to choose from: natural ones (when installed) first, then the Mac's.
fn voice_list() -> Value {
    let natural = crate::kokoro::ready();
    let mut out: Vec<Value> = Vec::new();
    if natural {
        for (_, name, accent) in crate::kokoro::VOICES {
            out.push(serde_json::json!({"id": format!("kokoro:{name}"), "name": name, "detail": format!("Natural · {accent}"),
                "natural": true, "best": format!("kokoro:{name}") == NATURAL_DEFAULT}));
        }
    }
    if let Value::Array(mac) = voices() {
        for mut voice in mac {
            if natural {
                voice["best"] = Value::Bool(false);
            }
            let quality = voice.get("quality").and_then(Value::as_u64).unwrap_or(1);
            voice["detail"] = Value::String(match quality { 3 => "Mac · Premium", 2 => "Mac · Enhanced", _ => "Mac" }.into());
            voice["natural"] = Value::Bool(false);
            out.push(voice);
        }
    }
    Value::Array(out)
}

/// Loads the saved settings, starts the speaker and the alert loop.
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = data.join("voice.json");
    let legacy = data.join("reminders-voice.json");
    let saved = std::fs::read(&path).or_else(|_| std::fs::read(&legacy)).ok();
    let voice = saved.and_then(|bytes| serde_json::from_slice::<Voice>(&bytes).ok()).unwrap_or_default().cleaned();
    let _ = STORE.set(Mutex::new(Store { path, voice }));
    let _ = AUDIO_DIR.set(data.join("voices").join("audio"));
    crate::kokoro::init(&data);
    let (tx, rx) = channel::<(String, Voice)>();
    let _ = SPEAKER.set(Mutex::new(tx));
    std::thread::Builder::new()
        .name("voice-speaker".into())
        .spawn(move || {
            for (text, voice) in rx {
                speak_now(&text, &voice);
            }
        })
        .map_err(|e| e.to_string())?;
    std::thread::Builder::new().name("reminder-voice".into()).spawn(run).map_err(|e| e.to_string())?;
    Ok(())
}

fn run() {
    const TICK: Duration = Duration::from_secs(10);
    // An alert counts within this long after its moment; anything older (the Mac was
    // asleep, Dashledge just started) is skipped rather than read out late.
    const WINDOW: i64 = 90_000;
    let mut said: HashSet<String> = HashSet::new();
    let mut held: Vec<(String, String)> = Vec::new(); // (id, title) held through quiet hours
    let mut items: Vec<Due> = Vec::new();
    let mut seen_changes = i64::MIN;
    let mut fetched = 0i64;
    loop {
        std::thread::sleep(TICK);
        let voice = current();
        if !voice.enabled {
            held.clear();
            continue;
        }
        let now = chrono::Utc::now().timestamp_millis();
        let changes = crate::reminders::reminders_changes();
        if changes != seen_changes || now - fetched > 60_000 {
            match crate::reminders::timed() {
                Some(found) => items = found,
                None => continue,
            }
            seen_changes = changes;
            fetched = now;
        }
        if said.len() > 5000 {
            said.clear();
        }
        let fresh: Vec<_> = alerts(&items, voice.lead, now, WINDOW).into_iter().filter(|(key, ..)| said.insert(key.clone())).collect();
        if voice.muted {
            held.clear();
            continue;
        }
        if voice.quiet_at(local_minute()) {
            for (_, id, _) in &fresh {
                if !held.iter().any(|(held_id, _)| held_id == id) {
                    if let Some(item) = items.iter().find(|item| &item.id == id) {
                        held.push((id.clone(), item.title.clone()));
                    }
                }
            }
            continue;
        }
        let mut words = Vec::new();
        if !held.is_empty() {
            let open: Vec<String> = held.drain(..).filter(|(id, _)| items.iter().any(|item| &item.id == id)).map(|(_, title)| title).collect();
            words.extend(held_summary(&open));
        }
        words.extend(fresh.into_iter().map(|(.., text)| text));
        if !words.is_empty() {
            say(&words.join(" "), &voice);
        }
    }
}

/// `patch` applied over `base`: only the fields it names, typed as `Voice` expects.
pub fn patched(base: &Voice, patch: &Value) -> Result<Voice, String> {
    let mut merged = serde_json::to_value(base).map_err(|e| e.to_string())?;
    if let (Value::Object(target), Value::Object(changes)) = (&mut merged, patch) {
        for (key, value) in changes {
            if target.contains_key(key) {
                target.insert(key.clone(), value.clone());
            }
        }
    }
    serde_json::from_value::<Voice>(merged).map(Voice::cleaned).map_err(|_| "Those voice settings aren't valid.".to_string())
}

fn save(next: Voice) -> Result<Voice, String> {
    let store = STORE.get().ok_or("Voice isn't ready")?;
    let mut store = store.lock().unwrap();
    let json = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
    if let Some(dir) = store.path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&store.path, json).map_err(|e| e.to_string())?;
    if next.muted {
        unsafe { speech_stop() };
    }
    store.voice = next.clone();
    Ok(next)
}

/// Everything the Voice settings show: the settings, the voices to choose from and
/// the natural voices' download state.
#[tauri::command]
pub fn voice_settings() -> Value {
    serde_json::json!({
        "settings": current(),
        "voices": voice_list(),
        "natural": {"status": crate::kokoro::status(), "sizeMb": crate::kokoro::download_mb()},
    })
}

/// Changes only the fields `patch` names.
#[tauri::command]
pub fn voice_update(patch: Value) -> Result<Voice, String> {
    save(patched(&current(), &patch)?)
}

/// Says a sample even while muted or in quiet hours, with `patch` over the saved
/// settings when given (an unsaved choice).
#[tauri::command]
pub fn voice_test(patch: Option<Value>) -> Result<(), String> {
    let voice = match patch { Some(patch) => patched(&current(), &patch)?, None => current() };
    say("Hi, this is Dashledge. Laundry is due now.", &voice);
    Ok(())
}

#[tauri::command]
pub async fn voice_install() -> Result<(), String> {
    crate::kokoro::install().await
}

#[tauri::command]
pub fn voice_remove() -> Result<(), String> {
    crate::kokoro::remove()?;
    // A natural voice chosen before goes back to the best available.
    let voice = current();
    if voice.voice.starts_with("kokoro:") {
        save(Voice { voice: String::new(), ..voice })?;
    }
    Ok(())
}

/// `speech.say` from a widget's view. A widget's line (`speech` permission), in the user's voice. Resolves with whether it
/// was spoken: not while muted or in quiet hours, nor more than once a second.
#[tauri::command]
pub fn speech_line(text: String) -> Value {
    let reason = (|| {
        let line = widget_line(&text)?;
        let voice = current();
        if voice.muted {
            return Err("muted");
        }
        if voice.quiet_at(local_minute()) {
            return Err("quiet");
        }
        let mut last = LAST_WIDGET_LINE.lock().unwrap();
        if last.is_some_and(|at| at.elapsed() < Duration::from_secs(1)) {
            return Err("busy");
        }
        *last = Some(Instant::now());
        say(&line, &voice);
        Ok(())
    })();
    match reason {
        Ok(()) => serde_json::json!({"spoken": true}),
        Err(reason) => serde_json::json!({"spoken": false, "reason": reason}),
    }
}

#[tauri::command]
pub fn speech_stop_all() {
    unsafe { speech_stop() };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn due(id: &str, title: &str, due_at: i64) -> Due {
        Due { id: id.into(), title: title.into(), due_at }
    }

    #[test]
    fn alerts_fire_once_in_their_window() {
        let items = [due("a", "Laundry", 1_000_000)];
        assert!(alerts(&items, 0, 999_999, 90_000).is_empty(), "not before it is due");
        let now = alerts(&items, 0, 1_000_000, 90_000);
        assert_eq!(now.len(), 1);
        assert_eq!(now[0].2, "Laundry is due now.");
        assert!(alerts(&items, 0, 1_090_000, 90_000).is_empty(), "too late to say");
        let soon = alerts(&items, 15, 1_000_000 - 15 * 60_000 + 5, 90_000);
        assert_eq!(soon.len(), 1);
        assert_eq!(soon[0].2, "Laundry is due in 15 minutes.");
        assert_ne!(soon[0].0, now[0].0, "the early alert has its own key");
        assert_eq!(alerts(&items, 60, 1_000_000 - 3_600_000, 90_000)[0].2, "Laundry is due in an hour.");
        assert_eq!(alerts(&[due("b", "  ", 5)], 0, 5, 90_000)[0].2, "A reminder is due now.");
    }

    #[test]
    fn quiet_hours_span_midnight() {
        let v = Voice { quiet: true, quiet_start: 22 * 60, quiet_end: 7 * 60, ..Voice::default() };
        assert!(v.quiet_at(23 * 60) && v.quiet_at(0) && v.quiet_at(6 * 60 + 59));
        assert!(!v.quiet_at(7 * 60) && !v.quiet_at(12 * 60) && !v.quiet_at(21 * 60 + 59));
        let day = Voice { quiet_start: 13 * 60, quiet_end: 14 * 60, ..v.clone() };
        assert!(day.quiet_at(13 * 60 + 30) && !day.quiet_at(14 * 60));
        assert!(!Voice { quiet: false, ..v.clone() }.quiet_at(23 * 60));
        assert!(!Voice { quiet_end: 22 * 60, ..v }.quiet_at(23 * 60), "equal start and end means none");
    }

    #[test]
    fn settings_are_cleaned() {
        let v = Voice { lead: 7, quiet_start: 1450, quiet_end: 7 * 60 + 7, volume: 3.0, voice: "x\"y".into(), ..Voice::default() }.cleaned();
        assert_eq!((v.lead, v.quiet_start, v.quiet_end, v.volume, v.voice.as_str()), (0, 0, 7 * 60, 1.0, ""));
        let v = Voice { volume: f32::NAN, voice: "com.apple.voice.premium.en-US.Zoe".into(), ..Voice::default() }.cleaned();
        assert_eq!((v.volume, v.voice.as_str()), (0.8, "com.apple.voice.premium.en-US.Zoe"));
        let parsed: Voice = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(parsed.enabled && parsed.quiet && parsed.volume == 0.8, "missing fields take defaults");
    }

    #[test]
    fn engines_follow_the_choice_and_what_is_installed() {
        assert_eq!(engine("kokoro:George", true), Ok(9));
        assert_eq!(engine("kokoro:George", false), Err(String::new()), "falls back to the best Mac voice");
        assert_eq!(engine("", true), Ok(1), "natural Bella by default once installed");
        assert_eq!(engine("", false), Err(String::new()));
        assert_eq!(engine("com.apple.voice.premium.en-US.Zoe", true), Err("com.apple.voice.premium.en-US.Zoe".into()));
    }

    #[test]
    fn patches_change_only_what_they_name() {
        let base = Voice { enabled: true, lead: 15, volume: 0.5, ..Voice::default() };
        let next = patched(&base, &serde_json::json!({"muted": true, "unknown": 1})).unwrap();
        assert_eq!(next, Voice { muted: true, ..base.clone() });
        let next = patched(&base, &serde_json::json!({"voice": "kokoro:Emma", "volume": 4})).unwrap();
        assert_eq!((next.voice.as_str(), next.volume, next.lead), ("kokoro:Emma", 1.0, 15));
        assert!(patched(&base, &serde_json::json!({"muted": "yes"})).is_err());
    }

    #[test]
    fn widget_lines_are_one_capped_line() {
        assert_eq!(widget_line("  Hello\nthere ").unwrap(), "Hello there");
        assert!(widget_line(" \t ").is_err());
        assert_eq!(widget_line(&"a".repeat(900)).unwrap().len(), MAX_SPEECH);
    }

    #[test]
    fn held_alerts_read_as_one_sentence() {
        assert_eq!(held_summary(&[]), None);
        assert_eq!(held_summary(&["Laundry".into()]).unwrap(), "During quiet hours, Laundry was due.");
        assert_eq!(held_summary(&["A".into(), "B".into()]).unwrap(), "During quiet hours, A and B were due.");
        assert_eq!(held_summary(&["A".into(), "B".into(), "C".into()]).unwrap(), "During quiet hours, A, B, and C were due.");
    }
}
