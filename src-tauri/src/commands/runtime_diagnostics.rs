//! Read-only process diagnostics; separate WebView processes are not included in RSS.
use super::{native_hls::NativeHlsState, tauri_commands::TauriState};
use ottplay_core::runtime_diagnostics::{Metric, Platform, RuntimeDiagnostics};
use std::time::Instant;

pub struct RuntimeDiagnosticsState {
    started: Instant,
}

impl Default for RuntimeDiagnosticsState {
    fn default() -> Self {
        Self {
            started: Instant::now(),
        }
    }
}

fn require_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("Runtime diagnostics is restricted to the main window".into())
    }
}

#[tauri::command]
pub async fn runtime_diagnostics(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, RuntimeDiagnosticsState>,
    epg: tauri::State<'_, TauriState>,
    hls: tauri::State<'_, NativeHlsState>,
) -> Result<RuntimeDiagnostics, String> {
    require_main(window.label())?;
    let started = state.started;
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        RuntimeDiagnostics::collect(Platform::Tauri, env!("CARGO_PKG_VERSION"), started)
    })
    .await
    .map_err(|_| "Runtime diagnostics unavailable")?;
    if let Ok(focused) = window.is_focused() {
        result.foreground(focused);
    }
    if let Ok(version) = tauri::webview_version() {
        result.webview_version(&version);
    }
    // Never wait for a provider refresh or initialize a decoder to answer a read.
    if let Ok(cache) = epg.xmltv_cache.try_read() {
        let (channels, programmes) = cache.as_ref().map_or((0, 0), |cache| cache.counts());
        result.metric(Metric::EpgChannels, channels as u64);
        result.metric(Metric::EpgProgrammes, programmes as u64);
    }
    if let Ok(mapping) = epg.epg_to_xmltv.try_read() {
        result.metric(Metric::EpgMappings, mapping.len() as u64);
    }
    if let Ok(shifts) = epg.time_shift_by_epg.try_read() {
        result.metric(Metric::EpgShifts, shifts.len() as u64);
    }
    if let Some(count) = hls.diagnostic_session_count() {
        result.metric(Metric::NativeHlsSessions, count as u64);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_diagnostics_is_only_available_to_main_window() {
        assert!(require_main("main").is_ok());
        for label in ["pip", "", "MAIN", "main/child"] {
            assert!(require_main(label).is_err());
        }
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/runtime-diagnostics.json"))
                .unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["allow-runtime-diagnostics"])
        );
        assert!(capability["remote"]["urls"]
            .as_array()
            .unwrap()
            .iter()
            .all(|url| {
                let url = url.as_str().unwrap();
                url.starts_with("http://127.0.0.1:")
                    || url.starts_with("http://localhost:")
                    || [
                        "http://tauri.localhost/*",
                        "https://tauri.localhost/*",
                        "http://asset.localhost/*",
                        "https://asset.localhost/*",
                        "tauri://localhost/*",
                        "asset://localhost/*",
                    ]
                    .contains(&url)
            }));
    }
}
