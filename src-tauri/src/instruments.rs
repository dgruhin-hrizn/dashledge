use serde_json::{json, Value};
use std::{
    sync::{Mutex, OnceLock},
    time::Instant,
};
use sysinfo::{CpuExt, DiskExt, NetworkExt, System, SystemExt};
extern "C" {
    fn ew_ember() -> *mut std::ffi::c_char;
    fn ew_extra_metrics() -> *mut std::ffi::c_char;
    fn ew_gpu() -> f64;
    fn ew_spotify(action: i32) -> *mut std::ffi::c_char;
    fn free(ptr: *mut std::ffi::c_void);
}
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
    if elapsed < 0.85 && !state.value.is_null() {
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
    state.history.push_back(json!({"at":now,"cpu":cpu,"gpu":gpu,"rx":rx,"tx":tx}));
    while state.history.front().is_some_and(|v|v["at"].as_i64().unwrap_or(0)<now-90_000) {
        state.history.pop_front();
    }
    snapshot["history"]=json!(state.history);
    state.value=snapshot;
    state.value.clone()
}

#[tauri::command]
pub fn spotify(action: u8) -> Result<Value, String> {
    if action > 3 {
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

#[tauri::command]
pub fn ember_chats() -> Result<Value, String> {
    let ptr = unsafe { ew_ember() };
    if ptr.is_null() {
        return Err("Open Ember with a supported chat database".into());
    }
    let value = unsafe { serde_json::from_slice(std::ffi::CStr::from_ptr(ptr).to_bytes()) };
    unsafe { free(ptr.cast()) };
    value.map_err(|_| "Invalid chat data".into())
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
        std::thread::sleep(std::time::Duration::from_millis(900));
        let next=read_metrics();
        assert!(next["rx"].as_f64().is_some_and(|v|v>=0.0));
        assert!(next["tx"].as_f64().is_some_and(|v|v>=0.0));
        assert!(sample["cpu"].as_f64().is_some_and(|v|v.is_finite()));
    }
}
