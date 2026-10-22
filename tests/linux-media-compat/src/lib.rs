// Compile the production selector itself, without a GTK/WebKit dependency.
#[cfg(unix)]
#[path = "../../../src-tauri/src/linux_media_compat.rs"]
pub mod linux_media_compat;
