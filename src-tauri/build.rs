fn main() {
    cc::Build::new()
        .file("native.m")
        .flag("-fobjc-arc")
        .compile("edge_native");
    println!("cargo:rerun-if-changed=native.m");
    for name in ["Foundation", "AppKit", "IOKit", "Metal"] {
        println!("cargo:rustc-link-lib=framework={name}");
    }
    println!("cargo:rustc-link-lib=sqlite3");
    tauri_build::build()
}
