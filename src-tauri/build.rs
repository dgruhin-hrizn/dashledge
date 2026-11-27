fn main() {
    let out = std::env::var("OUT_DIR").unwrap();
    let dictionary = "/System/Applications/Music.app/Contents/Resources/com.apple.Music.sdef";
    let status = std::process::Command::new("xcrun")
        .args(["sdp", "-fh", "--basename", "Music", dictionary])
        .current_dir(&out).status().expect("generate Music scripting interface");
    assert!(status.success(), "could not generate the Music scripting interface");
    println!("cargo:rerun-if-changed={dictionary}");
    cc::Build::new()
        .include(&out)
        .file("photos.m")
        .file("desk_calendar.m")
        .file("reminders.m")
        .file("speech.m")
        .file("apple_music.m")
        .file("native.m")
        .file("spotify_spectrum.m")
        .file("connector.m")
        .flag("-fobjc-arc")
        .compile("edge_native");
    println!("cargo:rerun-if-changed=photos.m");
    println!("cargo:rerun-if-changed=desk_calendar.m");
    println!("cargo:rerun-if-changed=reminders.m");
    println!("cargo:rerun-if-changed=speech.m");
    println!("cargo:rerun-if-changed=native.m");
    println!("cargo:rerun-if-changed=spotify_spectrum.m");
    println!("cargo:rerun-if-changed=apple_music.m");
    println!("cargo:rerun-if-changed=connector.m");
    for name in ["Photos", "Vision", "EventKit", "AVFoundation", "Foundation", "AppKit", "IOKit", "Metal", "CoreAudio", "Accelerate", "ScriptingBridge", "ImageIO", "LinkPresentation", "JavaScriptCore", "Security"] {
        println!("cargo:rustc-link-lib=framework={name}");
    }
    tauri_build::build()
}
