#[tauri::command]
pub async fn discover_control_servers() -> ottplay_core::control_discovery::Discovery {
    ottplay_core::control_discovery::discover_control_servers().await
}
