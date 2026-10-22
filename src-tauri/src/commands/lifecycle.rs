//! Narrow app lifecycle commands. These never control the operating system.

#[derive(serde::Serialize)]
pub struct LifecycleCapabilities {
    exit: bool,
    restart: bool,
    reboot: bool,
}

fn require_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("App lifecycle is restricted to the main window".into())
    }
}

/// Read-only feature negotiation for newer web code running in older shells.
#[tauri::command]
pub fn lifecycle_capabilities(
    window: tauri::WebviewWindow,
) -> Result<LifecycleCapabilities, String> {
    require_main(window.label())?;
    Ok(LifecycleCapabilities {
        exit: true,
        restart: true,
        reboot: false,
    })
}

/// Called only after the remote result is acknowledged; restarts this app.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    require_main(window.label())?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_is_main_window_only() {
        assert!(require_main("main").is_ok());
        for label in ["pip", "", "MAIN", "main/child"] {
            assert!(require_main(label).is_err());
        }
    }
}
