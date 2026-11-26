use serde_json::{json, Value};
use std::{
    sync::{Mutex, OnceLock},
    time::Instant,
};
use sysinfo::{CpuExt, DiskExt, NetworkExt, System, SystemExt};
extern "C" {
    fn ew_apple_music(action: *const i8, value: *const i8, known: *const i8) -> *mut i8;
    fn ew_extra_metrics() -> *mut std::ffi::c_char;
    fn ew_gpu() -> f64;
    fn ew_music_spectrum(apple: bool, levels: *mut u8, wave: *mut u8) -> i32;
    fn ew_spotify(action: i32) -> *mut std::ffi::c_char;
    fn free(ptr: *mut std::ffi::c_void);
}
const SAMPLE_SECONDS: f64 = 0.85;
struct Sampler {
    sys: System,
    last: Instant,
    value: Value,
    history: std::collections::VecDeque<Value>,
}
#[tauri::command]
pub fn read_metrics() -> Value {
    static SAMPLE: OnceLock<Mutex<Sampler>> = OnceLock::new();
    let mut state = SAMPLE
        .get_or_init(|| {
            let mut sys = System::new();
            sys.refresh_cpu();
            sys.refresh_networks_list();
            sys.refresh_disks_list();
            Mutex::new(Sampler {
                sys,
                last: Instant::now(),
                value: Value::Null,
                history: Default::default(),
            })
        })
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let elapsed = state.last.elapsed().as_secs_f64();
    if elapsed < SAMPLE_SECONDS && !state.value.is_null() {
        return state.value.clone();
    }
    // The first refresh establishes network counters. There is no elapsed sampling
    // interval yet, so dividing that traffic by startup time would invent a spike.
    let rate_ready=!state.value.is_null();
    let rate=|count:u64|rate_ready.then(||count as f64/elapsed);
    state.last = Instant::now();
    let sys = &mut state.sys;
    sys.refresh_cpu();
    sys.refresh_memory();
    sys.refresh_networks();
    sys.refresh_disks();
    let (mut rx, mut tx) = (0u64, 0u64);
    let mut interfaces = Vec::new();
    for (name, net) in sys.networks() {
        if name.starts_with("en") {
            interfaces.push(json!({"name":name,"rx":rate(net.received()),"tx":rate(net.transmitted())}));
            rx += net.received();
            tx += net.transmitted();
        }
    }
    let disks:Vec<_>=sys.disks().iter().map(|d|json!({"name":d.name().to_string_lossy(),"mount":d.mount_point(),"free":d.available_space(),"total":d.total_space()})).collect();
    let load = unsafe { ew_gpu() };
    let ptr = unsafe { ew_extra_metrics() };
    let extra = if ptr.is_null() {
        Value::Null
    } else {
        let v = unsafe {
            serde_json::from_slice(std::ffi::CStr::from_ptr(ptr).to_bytes()).unwrap_or(Value::Null)
        };
        unsafe { free(ptr.cast()) };
        v
    };
    let now=chrono::Utc::now().timestamp_millis();
    let cpu=sys.global_cpu_info().cpu_usage();
    let gpu=(load>=0.).then_some(load);
    let rx=rate(rx);
    let tx=rate(tx);
    let mut snapshot=json!({
        "extra":extra,"interfaces":interfaces,"gpu":gpu,"cpu":cpu,"cores":sys.cpus().len(),
        "perCore":sys.cpus().iter().map(|c|c.cpu_usage()).collect::<Vec<_>>(),
        "freeGiB":((sys.available_memory() as f64/1073741824.)*10.).round()/10.,
        "memory":sys.used_memory(),"capacity":sys.total_memory(),"swap":sys.used_swap(),
        "rx":rx,"tx":tx,"disks":disks,"uptime":sys.uptime(),"os":sys.os_version(),
        "model":sys.cpus().first().map(|c|c.brand()),"host":sys.host_name()
    });
    let memory=(sys.total_memory()>0).then(||100.0*sys.used_memory() as f64/sys.total_memory() as f64);
    let volumes:serde_json::Map<String,Value>=sys.disks().iter().filter(|d|d.total_space()>0).map(|d|{
        let used=d.total_space().saturating_sub(d.available_space());
        (d.mount_point().to_string_lossy().into_owned(),json!(100.0*used as f64/d.total_space() as f64))
    }).collect();
    state.history.push_back(json!({"at":now,"memory":memory,"volumes":volumes,"cpu":cpu,"gpu":gpu,"rx":rx,"tx":tx}));
    while state.history.front().is_some_and(|v|v["at"].as_i64().unwrap_or(0)<now-93_000) {
        state.history.pop_front();
    }
    snapshot["history"]=json!(state.history);
    state.value=snapshot;
    state.value.clone()
}

#[tauri::command]
pub async fn spotify_spectrum(waveform: Option<bool>, apple: Option<bool>) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move ||{
        let mut levels = vec![0; 32];
        let mut samples = [128; 256];
        let capture_wave = waveform.unwrap_or(false);
        let wave = if capture_wave { samples.as_mut_ptr() } else { std::ptr::null_mut() };
        match unsafe {ew_music_spectrum(apple.unwrap_or(false),levels.as_mut_ptr(),wave)} {
            0=>{
                if capture_wave { levels.extend_from_slice(&samples); }
                Ok(levels)
            },
            1=>Err(format!("Play {} audio on this Mac.", if apple.unwrap_or(false) {"Apple Music"} else {"Spotify"})),
            3=>Err("Spectrum requires macOS 14.2 or newer.".into()),
            _=>Err("Check System Audio Recording access for Dashledge in Privacy & Security.".into()),
        }
    }).await.map_err(|_|"Spectrum interrupted.")?
}

#[tauri::command]
pub async fn apple_music(action: String, value: Option<String>, known: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::ffi::{CString, CStr};
        let arg = |s| CString::new(s).map_err(|_| "Invalid Music argument");
        let ptr = unsafe { ew_apple_music(arg(action)?.as_ptr(), arg(value.unwrap_or_default())?.as_ptr(), arg(known.unwrap_or_default())?.as_ptr()) };
        if ptr.is_null() { return Err("Music unavailable".into()); }
        let result = unsafe { serde_json::from_slice::<Value>(CStr::from_ptr(ptr).to_bytes()) };
        unsafe { free(ptr.cast()) };
        let result = result.map_err(|_| "Invalid Music response")?;
        if let Some(message) = result["error"].as_str() { return Err(message.to_owned()); }
        Ok(result)
    }).await.map_err(|_| "Music request interrupted")?
}

#[tauri::command]
pub fn spotify(action: u8) -> Result<Value, String> {
    if action > 5 {
        return Err("Unknown transport action".into());
    }
    let ptr = unsafe { ew_spotify(action.into()) };
    if ptr.is_null() {
        return Err("Spotify unavailable".into());
    }
    let value = unsafe { serde_json::from_slice(std::ffi::CStr::from_ptr(ptr).to_bytes()) };
    unsafe { free(ptr.cast()) };
    value.map_err(|_| "Invalid player response".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_a_live_mac_sample_without_a_display_or_touch_device() {
        let sample=read_metrics();
        assert!(sample["capacity"].as_u64().unwrap_or(0)>0);
        assert!(sample["cores"].as_u64().unwrap_or(0)>0);
        assert!(sample["disks"].is_array() && sample["interfaces"].is_array());
        assert!(sample["rx"].is_null() && sample["tx"].is_null(),"startup has no traffic interval");
        assert!(sample["history"][0]["tx"].is_null());
        std::thread::sleep(std::time::Duration::from_secs_f64(SAMPLE_SECONDS + 0.05));
        let next=read_metrics();
        assert!(next["rx"].as_f64().is_some_and(|v|v>=0.0));
        assert!(next["tx"].as_f64().is_some_and(|v|v>=0.0));
        assert!(sample["cpu"].as_f64().is_some_and(|v|v.is_finite()));
    }
}
