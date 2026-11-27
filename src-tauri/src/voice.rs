//! Dashledge's voice: one set of settings for the whole app (voice, volume, mute, quiet
//! hours) used by spoken reminders and by any widget with the `speech` permission.
//! Dashledge speaks only with its natural voices (Kokoro, `kokoro.rs`), an optional
//! download in Settings › Voice; until they're installed nothing is spoken. Speech
//! plays through Dashledge's own audio, so volume and mute never touch the system's.
//!
//! A line becomes speech in steps: `pronounce.rs` spells numbers and symbols out and
//! gives the runtime a pronunciation for every word its dictionary lacks; the line is
//! split into sentences; the first sentence plays while the next is made. Audio lives
//! in a few fixed files under `voices/audio/`, overwritten each time and cleared at
//! launch, so recordings never pile up.
//!
//! Spoken reminders are a background loop: it reads open reminders with a due time,
//! makes each alert's audio a minute or two early so it plays the moment it's due, and
//! says it (optionally also a few minutes before). Quiet hours hold those alerts until
//! they end; mute drops them.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, CString};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

extern "C" {
    fn speech_play_file(path: *const c_char, volume: f32) -> f64;
    fn speech_stop();
}

/// The longest line a widget may have spoken.
pub const MAX_SPEECH: usize = 500;
/// The voice used when none is chosen.
const DEFAULT_VOICE: &str = "kokoro:Bella";
/// What "Hear it" says.
pub const SAMPLE: &str = "Hi, I'm Dashledge. I can speak your reminders and other widget information!";

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
    /// `kokoro:<Name>`, or empty for the default natural voice.
    pub voice: String,
}

impl Default for Voice {
    fn default() -> Self {
        Voice { enabled: false, muted: false, lead: 0, quiet: true, quiet_start: 22 * 60, quiet_end: 7 * 60, volume: 0.8, voice: String::new() }
    }
}

impl Voice {
    /// Whatever a view sent, made valid: known lead times, quarter-hour quiet times,
    /// volume within 0…1 and a natural voice (or the default).
    pub fn cleaned(mut self) -> Self {
        if !LEADS.contains(&self.lead) {
            self.lead = 0;
        }
        self.quiet_start = (self.quiet_start % 1440) / 15 * 15;
        self.quiet_end = (self.quiet_end % 1440) / 15 * 15;
        self.volume = if self.volume.is_finite() { self.volume.clamp(0.0, 1.0) } else { 0.8 };
        // Only natural voices speak; anything else (an old Mac voice) means the default.
        if crate::kokoro::speaker(&self.voice).is_none() {
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

enum Job {
    /// Say a line now: made sentence by sentence, the first playing while the next is made.
    Say(String, Voice),
    /// Make a reminder alert's audio ahead of time, under `key`.
    Prepare(String, String, Voice),
    /// Play an alert prepared under `key`, or say `text` if it isn't ready.
    Play(String, String, Voice),
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
static SPEAKER: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();
static AUDIO_DIR: OnceLock<PathBuf> = OnceLock::new();
static LAST_WIDGET_LINE: Mutex<Option<Instant>> = Mutex::new(None);

fn current() -> Voice {
    STORE.get().map(|s| s.lock().unwrap().voice.clone()).unwrap_or_default()
}

/// The speaker for a voice choice: the chosen natural voice, or Bella.
pub fn speaker_for(voice: &str) -> u32 {
    crate::kokoro::speaker(voice).or_else(|| crate::kokoro::speaker(DEFAULT_VOICE)).unwrap_or(1)
}

fn audio_dir() -> PathBuf {
    AUDIO_DIR.get().cloned().unwrap_or_else(std::env::temp_dir)
}

/// Words the runtime's dictionary lacks, written beside the audio for this line.
fn prepare_line(text: &str, dir: &Path) -> (String, Option<PathBuf>) {
    let line = crate::pronounce::spell_out(text);
    let missing = crate::pronounce::missing_words(&line, &crate::kokoro::lexicon());
    if missing.is_empty() {
        return (line, None);
    }
    let extra = dir.join("words.txt");
    let body: String = missing.iter().map(|(word, phones)| format!("{word} || {phones}\n")).collect();
    match std::fs::write(&extra, body) {
        Ok(()) => (line, Some(extra)),
        Err(_) => (line, None),
    }
}

fn play(file: &Path, volume: f32) -> f64 {
    match CString::new(file.to_string_lossy().as_bytes()) {
        Ok(path) => unsafe { speech_play_file(path.as_ptr(), volume) },
        Err(_) => 0.0,
    }
}

/// Says one line. Its sentences are made two at a time, each in its own file, and
/// played in order as soon as the one before finishes, so the first word comes after
/// one short sentence and later ones are ready in time. Files are deleted once played.
/// Stops early when muted or the voice is removed.
fn speak_now(text: &str, voice: &Voice) {
    if !crate::kokoro::ready() {
        return;
    }
    let dir = audio_dir();
    let _ = std::fs::create_dir_all(&dir);
    let (line, extra) = prepare_line(text, &dir);
    let speaker = speaker_for(&voice.voice);
    let parts = crate::pronounce::sentences(&line);
    let slots = std::sync::Arc::new((Mutex::new(0usize), std::sync::Condvar::new()));
    let jobs: Vec<_> = parts
        .iter()
        .enumerate()
        .map(|(index, sentence)| {
            let (sentence, extra, slots) = (sentence.clone(), extra.clone(), slots.clone());
            let file = dir.join(format!("sentence-{index}.wav"));
            std::thread::spawn(move || {
                // At most two sentences are made at once.
                let (lock, wake) = &*slots;
                let mut busy = wake.wait_while(lock.lock().unwrap(), |n| *n >= 2).unwrap();
                *busy += 1;
                drop(busy);
                let made = crate::kokoro::synthesize(&sentence, speaker, extra.as_deref(), &file).map(|()| file);
                *lock.lock().unwrap() -= 1;
                wake.notify_all();
                made
            })
        })
        .collect();
    let mut playing_until = Instant::now();
    let mut stopped = false;
    for job in jobs {
        let made = job.join().ok().and_then(Result::ok);
        let Some(file) = made else { stopped = true; continue };
        if !stopped {
            std::thread::sleep(playing_until.saturating_duration_since(Instant::now()));
            stopped = current().muted || !crate::kokoro::ready();
        }
        if !stopped {
            let seconds = play(&file, voice.volume);
            playing_until = Instant::now() + Duration::from_secs_f64(seconds.max(0.0)) + Duration::from_millis(80);
        }
        // AVAudioPlayer has read the file by now; it never piles up.
        let _ = std::fs::remove_file(&file);
    }
    std::thread::sleep(playing_until.saturating_duration_since(Instant::now()));
    if let Some(extra) = extra {
        let _ = std::fs::remove_file(extra);
    }
}

/// File name for an alert prepared ahead: a hash of its key, so names stay plain.
fn ahead_file(key: &str) -> PathBuf {
    let digest = ring::digest::digest(&ring::digest::SHA256, key.as_bytes());
    let name: String = digest.as_ref().iter().take(8).map(|b| format!("{b:02x}")).collect();
    audio_dir().join(format!("ahead-{name}.wav"))
}

fn speaker_loop(rx: std::sync::mpsc::Receiver<Job>) {
    // Prepared alerts: key → (file, voice it was made with). At most a few at a time.
    let mut ready: HashMap<String, (PathBuf, String)> = HashMap::new();
    for job in rx {
        match job {
            Job::Say(text, voice) => speak_now(&text, &voice),
            Job::Prepare(key, text, voice) => {
                if ready.contains_key(&key) || !crate::kokoro::ready() {
                    continue;
                }
                // Keep at most eight; drop the oldest-looking ones.
                if ready.len() >= 8 {
                    for (_, (file, _)) in ready.drain() {
                        let _ = std::fs::remove_file(file);
                    }
                }
                let dir = audio_dir();
                let _ = std::fs::create_dir_all(&dir);
                let (line, extra) = prepare_line(&text, &dir);
                let file = ahead_file(&key);
                if crate::kokoro::synthesize(&line, speaker_for(&voice.voice), extra.as_deref(), &file).is_ok() {
                    ready.insert(key, (file, voice.voice.clone()));
                }
            }
            Job::Play(key, text, voice) => match ready.remove(&key) {
                Some((file, made_with)) if made_with == voice.voice && file.is_file() => {
                    let seconds = play(&file, voice.volume);
                    std::thread::sleep(Duration::from_secs_f64(seconds.max(0.0)) + Duration::from_millis(200));
                    let _ = std::fs::remove_file(file);
                }
                other => {
                    if let Some((file, _)) = other {
                        let _ = std::fs::remove_file(file);
                    }
                    speak_now(&text, &voice);
                }
            },
        }
    }
}

fn send(job: Job) {
    if let Some(tx) = SPEAKER.get() {
        let _ = tx.lock().unwrap().send(job);
    }
}

/// Queues a line for the speaker thread, so callers never wait on synthesis.
fn say(text: &str, voice: &Voice) {
    send(Job::Say(text.to_string(), voice.clone()));
}

fn local_minute() -> u32 {
    let local = chrono::Local::now();
    chrono::Timelike::hour(&local) * 60 + chrono::Timelike::minute(&local)
}

/// A line from a widget, which `speech.say` sends: trimmed, one line, at most 500
/// characters.
pub fn widget_line(text: &str) -> Result<String, &'static str> {
    let line: String = text.trim().chars().map(|c| if c.is_control() { ' ' } else { c }).take(MAX_SPEECH).collect();
    let line = line.trim().to_string();
    if line.is_empty() {
        return Err("empty");
    }
    Ok(line)
}

/// The natural voices to choose from, listed whether or not they're installed.
fn voice_list() -> Value {
    Value::Array(
        crate::kokoro::VOICES
            .iter()
            .map(|(_, name, accent)| {
                let id = format!("kokoro:{name}");
                serde_json::json!({"id": id, "name": name, "accent": accent, "best": id == DEFAULT_VOICE})
            })
            .collect(),
    )
}

/// Loads the saved settings, clears old audio, starts the speaker and the alert loop.
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = data.join("voice.json");
    let legacy = data.join("reminders-voice.json");
    let saved = std::fs::read(&path).or_else(|_| std::fs::read(&legacy)).ok();
    let voice = saved.and_then(|bytes| serde_json::from_slice::<Voice>(&bytes).ok()).unwrap_or_default().cleaned();
    let _ = STORE.set(Mutex::new(Store { path, voice }));
    let audio = data.join("voices").join("audio");
    // Audio is only ever a few working files; start each launch with none.
    let _ = std::fs::remove_dir_all(&audio);
    let _ = AUDIO_DIR.set(audio);
    crate::kokoro::init(&data);
    let (tx, rx) = channel::<Job>();
    let _ = SPEAKER.set(Mutex::new(tx));
    std::thread::Builder::new().name("voice-speaker".into()).spawn(move || speaker_loop(rx)).map_err(|e| e.to_string())?;
    std::thread::Builder::new().name("reminder-voice".into()).spawn(run).map_err(|e| e.to_string())?;
    Ok(())
}

fn run() {
    const TICK: Duration = Duration::from_secs(10);
    // An alert counts within this long after its moment; anything older (the Mac was
    // asleep, Dashledge just started) is skipped rather than read out late.
    const WINDOW: i64 = 90_000;
    // How far ahead an alert's audio is made.
    const AHEAD: i64 = 120_000;
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
        // Make the audio for alerts due in the next two minutes, so they play on time.
        if !voice.muted && crate::kokoro::ready() && !voice.quiet_at(local_minute()) {
            for (key, _, text) in alerts(&items, voice.lead, now + AHEAD, AHEAD) {
                if !said.contains(&key) {
                    send(Job::Prepare(key, text, voice.clone()));
                }
            }
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
        if !held.is_empty() {
            let open: Vec<String> = held.drain(..).filter(|(id, _)| items.iter().any(|item| &item.id == id)).map(|(_, title)| title).collect();
            if let Some(summary) = held_summary(&open) {
                say(&summary, &voice);
            }
        }
        for (key, _, text) in fresh {
            send(Job::Play(key, text, voice.clone()));
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
        "sample": SAMPLE,
    })
}

/// Changes only the fields `patch` names.
#[tauri::command]
pub fn voice_update(patch: Value) -> Result<Voice, String> {
    save(patched(&current(), &patch)?)
}

/// Says the sample even while muted or in quiet hours, with `patch` over the saved
/// settings when given (an unsaved choice).
#[tauri::command]
pub fn voice_test(patch: Option<Value>) -> Result<(), String> {
    if !crate::kokoro::ready() {
        return Err("Download the natural voices first.".into());
    }
    let voice = match patch { Some(patch) => patched(&current(), &patch)?, None => current() };
    say(SAMPLE, &voice);
    Ok(())
}

#[tauri::command]
pub async fn voice_install() -> Result<(), String> {
    crate::kokoro::install().await
}

#[tauri::command]
pub fn voice_remove() -> Result<(), String> {
    unsafe { speech_stop() };
    crate::kokoro::remove()?;
    let _ = std::fs::remove_dir_all(audio_dir());
    Ok(())
}

/// `speech.say` from a widget's view (`speech` permission), in the user's voice.
/// Resolves with whether it was spoken: not before natural voices are installed,
/// while muted or in quiet hours, nor more than once a second.
#[tauri::command]
pub fn speech_line(text: String) -> Value {
    let reason = (|| {
        let line = widget_line(&text)?;
        if !crate::kokoro::ready() {
            return Err("unavailable");
        }
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
        let v = Voice { volume: f32::NAN, voice: "kokoro:Emma".into(), ..Voice::default() }.cleaned();
        assert_eq!((v.volume, v.voice.as_str()), (0.8, "kokoro:Emma"));
        let parsed: Voice = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(parsed.enabled && parsed.quiet && parsed.volume == 0.8, "missing fields take defaults");
    }

    #[test]
    fn only_natural_voices_are_chosen() {
        assert_eq!(speaker_for("kokoro:George"), 9);
        assert_eq!(speaker_for(""), 1, "Bella by default");
        assert_eq!(speaker_for("com.apple.voice.premium.en-US.Zoe"), 1);
        let old = Voice { voice: "com.apple.voice.compact.en-US.Samantha".into(), ..Voice::default() }.cleaned();
        assert_eq!(old.voice, "", "a saved Mac voice becomes the default natural voice");
        assert!(SAMPLE.contains("Dashledge"));
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
