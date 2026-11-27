//! Spoken reminders. A background loop reads open reminders with a due time and has
//! Dashledge say them when they come due (and, optionally, a few minutes before).
//! Settings are Dashledge-wide, kept in `reminders-voice.json`: one voice for the whole
//! app, whichever page is showing. Quiet hours hold alerts until they end; mute drops
//! them. Speech plays through Dashledge's own audio, never the system volume.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Manager;

extern "C" {
    fn speech_say(text: *const c_char, voice: *const c_char, volume: f32);
    fn speech_stop();
    fn speech_voices() -> *mut c_char;
    fn free(ptr: *mut c_void);
}

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
    /// An installed voice's identifier, or empty for the system voice.
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

fn current() -> Voice {
    STORE.get().map(|s| s.lock().unwrap().voice.clone()).unwrap_or_default()
}

fn say(text: &str, voice: &Voice) {
    let (Ok(text), Ok(id)) = (CString::new(text), CString::new(voice.voice.as_str())) else { return };
    unsafe { speech_say(text.as_ptr(), id.as_ptr(), voice.volume) };
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

/// Loads the saved settings and starts the alert loop.
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("reminders-voice.json");
    let voice = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<Voice>(&bytes).ok()).unwrap_or_default().cleaned();
    let _ = STORE.set(Mutex::new(Store { path, voice }));
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
        let local = chrono::Local::now();
        let minute = chrono::Timelike::hour(&local) * 60 + chrono::Timelike::minute(&local);
        if voice.quiet_at(minute) {
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

/// The voice settings and the voices installed for the system language.
#[tauri::command]
pub fn reminders_voice() -> Value {
    serde_json::json!({"settings": current(), "voices": voices()})
}

#[tauri::command]
pub fn reminders_voice_set(settings: Voice) -> Result<Voice, String> {
    let next = settings.cleaned();
    let store = STORE.get().ok_or("Voice isn't ready")?;
    let mut store = store.lock().unwrap();
    let json = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
    if let Some(dir) = store.path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&store.path, json).map_err(|e| e.to_string())?;
    if next.muted || !next.enabled {
        unsafe { speech_stop() };
    }
    store.voice = next.clone();
    Ok(next)
}

/// Says a sample even while muted, with `settings` when given (an unsaved draft) or
/// the saved voice and volume.
#[tauri::command]
pub fn reminders_voice_test(settings: Option<Voice>) {
    let voice = settings.map(Voice::cleaned).unwrap_or_else(current);
    unsafe { speech_stop() };
    say("This is how Dashledge will remind you. Laundry is due now.", &voice);
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
    fn held_alerts_read_as_one_sentence() {
        assert_eq!(held_summary(&[]), None);
        assert_eq!(held_summary(&["Laundry".into()]).unwrap(), "During quiet hours, Laundry was due.");
        assert_eq!(held_summary(&["A".into(), "B".into()]).unwrap(), "During quiet hours, A and B were due.");
        assert_eq!(held_summary(&["A".into(), "B".into(), "C".into()]).unwrap(), "During quiet hours, A, B, and C were due.");
    }
}
