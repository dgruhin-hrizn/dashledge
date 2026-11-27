//! Widget package rules shared by the Dashledge app and the `dashledge-package` CLI.
//!
//! Nothing here touches Tauri, the network or the app's data folder, so the registry's
//! CI checks a package with exactly the code the app runs.
pub mod archive;
pub mod catalog;
pub mod grants;
pub mod manifest;
