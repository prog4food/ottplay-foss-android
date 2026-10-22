//! Open only Plex's sign-in page in the user's default browser.

fn sign_in_url(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "Invalid Plex sign-in URL")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
        || !matches!(
            (url.host_str(), url.path()),
            (Some("app.plex.tv"), "/auth")
                | (Some("app.plex.tv"), "/auth/")
                | (Some("plex.tv"), "/link")
                | (Some("plex.tv"), "/link/")
        )
    {
        return Err("Invalid Plex sign-in URL".into());
    }
    Ok(url)
}

#[tauri::command]
pub fn open_plex_sign_in(url: String) -> Result<(), String> {
    let url = sign_in_url(&url)?;
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = std::process::Command::new("xdg-open");
    // Direct argument passing: neither a shell nor a user-supplied executable.
    command
        .arg(url.as_str())
        .spawn()
        .map_err(|_| "Could not open the browser".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sign_in_url;

    #[test]
    fn accepts_only_official_https_auth_pages() {
        for url in [
            "https://app.plex.tv/auth#?clientID=fixture&code=abcd",
            "https://plex.tv/link/?pin=ABCD",
        ] {
            assert!(sign_in_url(url).is_ok());
        }
        for url in [
            "http://plex.tv/link",
            "https://plex.tv.evil.invalid/link",
            "https://plex.tv@evil.invalid/link",
            "https://user@plex.tv/link",
            "https://plex.tv:8443/link",
            "https://app.plex.tv/desktop",
            "file:///tmp/auth",
        ] {
            assert!(sign_in_url(url).is_err());
        }
    }
}
