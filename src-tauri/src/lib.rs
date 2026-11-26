//! Edge Starter: a minimal app for the Corsair XENEON Edge on macOS.
//!
//! What it does for you:
//! 1. Finds the Edge (the ~32:9 display) and pins a borderless window over it,
//!    even with a Retina main display at 2x and the Edge at 1x.
//! 2. Takes over the Edge's touchscreen so touches land in this window instead
//!    of clicking your main display (see touch.rs), and hands them to the page
//!    as `window.__edgeTouch("down" | "move" | "up", x, y)`.
//! 3. Puts the window back on the Edge if it's moved off it, and
//!    follows the Edge when it's unplugged and plugged back in.
//! 4. Lives in the menu bar (no Dock icon): waits for the Edge, shows itself on
//!    it, hides when it's unplugged, and can open at login (see tray.rs).
//!
//! Your UI lives in `ui/`. Start there.

mod connections;
mod rundmd;
mod instruments;
mod spotify_queue;
mod oauth_callback;
mod slack;
mod google_desk;
mod mac_shortcuts;
mod markets;
mod photos;
mod general;
mod updater;
mod touch;
mod transcript;
mod tray;
mod widget_host;
mod widget_package;
mod vault;

use std::{path::PathBuf, sync::OnceLock, time::Duration};
use tauri::{
    LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

/// The Edge is 2560x720 (32:9). Any display at least this wide-to-tall counts.
pub const EDGE_MIN_ASPECT: f64 = 3.0;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn log_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join("Library/Logs/edge-workbench.log")
}

/// Append a line to ~/Library/Logs/edge-workbench.log (and stderr). Handy for
/// checking touch permissions on a built app, where stderr isn't visible.
pub(crate) fn log(msg: &str) {
    use std::io::Write;
    eprintln!("edge-workbench: {msg}");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = writeln!(
            f,
            "{} {msg}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        );
    }
}

/// Put the window over the Edge, edge to edge. Without the Edge, hide it: the
/// app waits in the menu bar until the Edge is plugged in.
///
/// This doesn't use macOS native fullscreen (its own Space): a menu bar app
/// can't hold it reliably, which leaves the window half-placed and touches
/// landing in the wrong spot. Instead the borderless window is pinned over
/// the Edge's exact bounds, above that display's menu bar, on every Space.
///
/// Positions use macOS point coordinates (`touch::edge_rect`). Physical
/// pixels go wrong with a 2x main display and the 1x Edge.
fn place(win: &WebviewWindow, edge: Option<touch::Rect>) {
    let _ = win.set_fullscreen(false);
    match edge {
        Some(r) => {
            pin_above_menu_bar(win);
            let _ = win.set_position(LogicalPosition::new(r.x, r.y));
            let _ = win.set_size(LogicalSize::new(r.w, r.h));
            let _ = win.show();
            log(&format!(
                "window: pinned over the Edge at {},{} {}x{}",
                r.x, r.y, r.w, r.h
            ));
        }
        None => {
            let _ = win.hide();
        }
    }
}

/// Is the window visible and covering exactly the Edge's bounds?
fn on_edge(win: &WebviewWindow, r: touch::Rect) -> bool {
    let sf = win.scale_factor().unwrap_or(1.0);
    let (Ok(p), Ok(sz)) = (win.outer_position(), win.outer_size()) else {
        return false;
    };
    let near = |a: f64, b: f64| (a - b).abs() < 2.0;
    win.is_visible().unwrap_or(false)
        && near(p.x as f64 / sf, r.x)
        && near(p.y as f64 / sf, r.y)
        && near(sz.width as f64 / sf, r.w)
        && near(sz.height as f64 / sf, r.h)
}

/// Window level above the menu bar (so it covers the Edge's own menu bar),
/// shown on every Space, left alone by Mission Control.
fn pin_above_menu_bar(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    if let Ok(ptr) = win.ns_window() {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        // NSMainMenuWindowLevel is 24; one above it covers the menu bar.
        const LEVEL: isize = 25;
        // canJoinAllSpaces | stationary | fullScreenAuxiliary
        const BEHAVIOR: usize = (1 << 0) | (1 << 4) | (1 << 8);
        unsafe {
            let ns: &AnyObject = &*(ptr as *const AnyObject);
            let _: () = msg_send![ns, setLevel: LEVEL];
            let _: () = msg_send![ns, setCollectionBehavior: BEHAVIOR];
            let _: () = msg_send![ns, setHasShadow: false];
        }
    }
}

fn output_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("edge-output.enabled"))
}

#[tauri::command]
fn display_info(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let rect = touch::edge_rect();
    Ok(serde_json::json!({
        "enabled": output_file(&app)?.exists(),
        "connected": rect.is_some(),
        "size": rect.map(|r| format!("{} × {}", r.w, r.h)),
        "displays": touch::monitors(),
        "touch": touch::status()
    }))
}

#[tauri::command]
fn set_edge_output(
    window: WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("Open Settings to change displays".into());
    }
    let path = output_file(&app)?;
    if enabled {
        std::fs::create_dir_all(path.parent().ok_or("Settings directory unavailable")?)
            .map_err(|e| e.to_string())?;
        std::fs::write(path, b"enabled").map_err(|e| e.to_string())?;
    } else if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    sync_touch(&app);
    if enabled {
        ensure_main(&app)?;
        show_on_edge(&app);
    } else if let Some(win)=app.get_webview_window("main"){win.close().map_err(|e|e.to_string())?;}
    tray::set_status(if !enabled {"Preview mode"} else if touch::edge_rect().is_some(){"Display connected"}else{"Waiting for display"});
    Ok(())
}

pub fn sync_touch(app:&tauri::AppHandle){
    touch::enable(output_file(app).is_ok_and(|p|p.exists()) && general::general_settings().direct_touch);
}
#[tauri::command]
fn retry_touch(app:tauri::AppHandle){sync_touch(&app);touch::retry();}
#[tauri::command]
fn move_to_display(app:tauri::AppHandle,window:WebviewWindow)->Result<(),String>{
    if touch::edge_rect().is_none(){return Err("The selected display is disconnected.".into());}
    set_edge_output(window,app,true)
}
#[tauri::command]
fn open_project_link(url: String) -> Result<(), String> {
    match url.as_str() {
        "https://github.com/dgruhin-hrizn/dashledge" |
        "https://github.com/joshsorenson/edge-starter" => {
            std::process::Command::new("/usr/bin/open").arg(url).spawn()
                .map(|_| ()).map_err(|error| error.to_string())
        }
        _ => Err("Unknown project link".into()),
    }
}
fn ensure_main(app:&tauri::AppHandle)->Result<(),String>{
    if app.get_webview_window("main").is_none(){
        WebviewWindowBuilder::new(app,"main",WebviewUrl::App("edge.html".into()))
            .on_web_resource_request(widget_host::serve).title("Dashledge").decorations(false)
            .background_color(tauri::window::Color(0,0,0,255)).visible(false).build().map_err(|e|e.to_string())?;
    }
    Ok(())
}

/// "Show on Edge" in the menu bar: put the window back on the Edge.
pub(crate) fn show_on_edge(app: &tauri::AppHandle) {
    if !output_file(app).is_ok_and(|file| file.exists()) {
        let _ = open_settings(app.clone());
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        place(&win, touch::edge_rect());
    }
}

/// Bring this app forward with its window focused, so the keyboard types into
/// the text field the user tapped. Called from ui/touch.js.
#[tauri::command]
fn focus_window() {
    if let Some(win) = APP.get().and_then(|a| a.get_webview_window("main")) {
        let _ = win.set_focus();
    }
}

/// "on", "needsPermission", "failed", … for showing touch status in the UI.
#[tauri::command]
fn touch_status() -> touch::TouchStatus {
    touch::status()
}

#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    let win = match app.get_webview_window("settings") {
        Some(win) => win,
        None => WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
            .on_web_resource_request(widget_host::serve)
            .title("Dashledge Settings")
            .inner_size(1377., 837.)
            .prevent_overflow()
            .build()
            .map_err(|e| e.to_string())?,
    };
    if win.is_minimized().map_err(|e| e.to_string())? {
        win.unminimize().map_err(|e| e.to_string())?;
    }
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            general::preview_control, general::open_preview, general::general_settings, general::save_general, updater::check_and_install, updater::update_status,
            open_project_link, retry_touch, move_to_display,
            rundmd::rundmd_catalog, rundmd::rundmd_import, rundmd::rundmd_clip, rundmd::rundmd_has_default,
            widget_package::read_widget_package, widget_package::save_widget_example,
            vault::unlock_connections,
            vault::recover_credential,
            widget_host::widget_open,
            widget_host::widget_ping,
            widget_host::widget_close,
            widget_host::widget_model_action,
            focus_window,
            touch_status,
            instruments::ember_chats,
            transcript::ember_transcript,
            instruments::read_metrics,
            instruments::spotify,
            instruments::spotify_spectrum,
            instruments::apple_music,
            spotify_queue::spotify_play_playlist,
            spotify_queue::spotify_play_queue_track,
            spotify_queue::spotify_player,
            spotify_queue::spotify_panel,
            spotify_queue::spotify_detail,
            spotify_queue::spotify_catalog_link,
            slack::slack_connect,
            slack::slack_feed,
            slack::slack_control,
            slack::slack_open,
            google_desk::desk_spark_inbox,
            google_desk::desk_mail,
            google_desk::desk_calendar,
            google_desk::desk_open,
            widget_host::markets_watch,
            widget_host::plans_refresh,
            markets::markets_connect,
            photos::photos_read,
            mac_shortcuts::mac_shortcuts_list,
            mac_shortcuts::mac_shortcut_run,
            spotify_queue::spotify_connect,
            spotify_queue::spotify_queue,
            spotify_queue::spotify_playlists,
            connections::set_secret,
            connections::source_read,
            connections::widget_source_read,
            connections::poster,
            connections::comfy_preview,
            open_settings,
            display_info,
            set_edge_output,
        ])
        .setup(|app| {
            let _ = APP.set(app.handle().clone());
            general::init(app.handle())?;
            widget_host::reap_idle(app.handle().clone());

            // Example: start sampling CPU / memory / network for system_snapshot.

            // Menu bar app: no Dock icon, waits for the Edge. Remove these
            // lines if you'd rather have a regular Dock app.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            if tray::OPEN_AT_LOGIN_BY_DEFAULT {
                tray::default_open_at_login(app.handle());
            }
            tray::build(app.handle())?;
            updater::start();

            sync_touch(app.handle());
            // Touches go straight into the page. The mouse never moves.
            let handle = app.handle().clone();
            touch::start(move |ev| {
                let Some(win) = handle.get_webview_window("main") else {
                    return;
                };
                let (kind, x, y) = match ev {
                    touch::TouchEvent::Down(x, y) => ("down", x, y),
                    touch::TouchEvent::Move(x, y) => ("move", x, y),
                    touch::TouchEvent::Up(x, y) => ("up", x, y),
                };
                let _ = win.eval(format!(
                    "window.__edgeTouch&&window.__edgeTouch('{kind}',{x:.1},{y:.1})"
                ));
            });

            let enabled=output_file(app.handle()).is_ok_and(|p|p.exists());
            let edge=touch::edge_rect();
            if enabled {
                ensure_main(app.handle())?;
                show_on_edge(app.handle());
            }
            if !enabled || edge.is_none(){open_settings(app.handle().clone())?;}
            tray::set_status(if !enabled {"Preview mode"} else if edge.is_some() {"Display connected"}else{"Waiting for display"});

            // Follow the Edge when it's plugged in, unplugged or rearranged, and
            // put the window back fullscreen if something knocked it out.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut last = edge;
                loop {
                    std::thread::sleep(Duration::from_secs(3));
                    let Some(win) = handle.get_webview_window("main") else {
                        last=None; continue;
                    };
                    let now = touch::edge_rect();
                    let knocked_out = now.is_some_and(|r| !on_edge(&win, r));
                    if now != last || knocked_out {
                        if now != last {
                            log(if now.is_some() {
                                "window: Edge connected; showing"
                            } else {
                                "window: Edge unplugged; hiding"
                            });
                            tray::set_status(if now.is_some() {
                                "On the Edge"
                            } else {
                                "Waiting for the Edge"
                            });
                        }
                        let _ = handle.run_on_main_thread(move || place(&win, now));
                        last = now;
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Dashledge")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                widget_host::shutdown();
            }
        });
}
