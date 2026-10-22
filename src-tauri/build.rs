fn main() {
    println!("cargo:rerun-if-env-changed=OTTPLAY_GST_COMPAT_MANIFEST_SHA256");
    println!("cargo:rerun-if-env-changed=RELEASE_CHANNEL");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux")
        && std::env::var_os("RELEASE_CHANNEL").is_some()
    {
        let digest = std::env::var("OTTPLAY_GST_COMPAT_MANIFEST_SHA256")
            .expect("Linux release requires the private playback manifest binding");
        assert!(
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
            "Invalid private playback manifest SHA-256"
        );
    }
    tauri_build::build();
}
