use serde_json::{json, Value};
use std::{
    sync::{Mutex, OnceLock},
    time::Instant,
};
use sysinfo::{CpuExt, DiskExt, NetworkExt, System, SystemExt};
extern "C" {
    fn ew_ember() -> *mut std::ffi::c_char;
    fn ew_gpu() -> f64;
    fn ew_spotify(action: i32) -> *mut std::ffi::c_char;
    fn free(ptr: *mut std::ffi::c_void);
}
struct Sampler {
    sys: System,
    last: Instant,
    value: Value,
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
            })
        })
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let elapsed = state.last.elapsed().as_secs_f64();
    if elapsed < 0.85 && !state.value.is_null() {
        return state.value.clone();
    }
    state.last = Instant::now();
    let sys = &mut state.sys;
    sys.refresh_cpu();
    sys.refresh_memory();
    sys.refresh_networks();
    sys.refresh_disks();
    let (mut rx, mut tx) = (0u64, 0u64);
    for (name, net) in sys.networks() {
        if name.starts_with("en") {
            rx += net.received();
            tx += net.transmitted();
        }
    }
    let disks:Vec<_>=sys.disks().iter().map(|d|json!({"name":d.name().to_string_lossy(),"mount":d.mount_point(),"free":d.available_space(),"total":d.total_space()})).collect();
    let load = unsafe { ew_gpu() };
    state.value = json!({"gpu":if load>=0.{Some(load)}else{None},"cpu":sys.global_cpu_info().cpu_usage(),"cores":sys.cpus().len(),"freeGiB":((sys.available_memory() as f64/1073741824.)*10.).round()/10.,"memory":sys.used_memory(),"capacity":sys.total_memory(),"swap":sys.used_swap(),"rx":rx as f64/elapsed,"tx":tx as f64/elapsed,"disks":disks,"uptime":sys.uptime(),"model":sys.cpus().first().map(|c|c.brand()),"host":sys.host_name()});
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
