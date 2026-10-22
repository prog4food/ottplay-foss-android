//! Run on a logged-in macOS desktop:
//! cargo run -p ottplay-tauri --example screenshot_smoke --locked -- /tmp/ottplay-screenshot-smoke
//! Append --without-screenshot-permission to reproduce the missing-ACL regression
//! in an isolated context. That negative run must fail without capturing pixels.
//!
//! This opens only its own incognito fixture window. It does not launch the
//! installed player, use player profiles, access the network or capture a desktop.

#[cfg(target_os = "macos")]
#[path = "../src/commands/screenshot.rs"]
mod screenshot;

#[cfg(target_os = "macos")]
mod smoke {
    use super::screenshot;
    use base64::Engine;
    use objc2_app_kit::NSBitmapImageRep;
    use objc2_foundation::NSData;
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
    use std::time::Duration;
    use tauri::{Listener, Manager};

    static LOADED: AtomicUsize = AtomicUsize::new(0);
    static REQUEST: AtomicUsize = AtomicUsize::new(0);
    static EXIT_CODE: AtomicI32 = AtomicI32::new(1);

    async fn invoke(window: &tauri::WebviewWindow, command: &str) -> Result<Value, String> {
        let event = format!(
            "screenshot-smoke-{}",
            REQUEST.fetch_add(1, Ordering::SeqCst)
        );
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let listener = window.once(event.clone(), move |reply| {
            let _ = sender.send(serde_json::from_str::<Value>(reply.payload()));
        });
        let script = format!(
            "window.runScreenshotSmokeInvoke({}, {}, {})",
            json!(event),
            json!(window.label()),
            json!(command)
        );
        if let Err(error) = window.eval(script) {
            window.unlisten(listener);
            return Err(error.to_string());
        }
        let result = tokio::time::timeout(Duration::from_secs(12), receiver).await;
        window.unlisten(listener);
        let reply = result
            .map_err(|_| format!("{} IPC reply timed out on {}", command, window.label()))?
            .map_err(|_| "IPC reply channel closed".to_string())?
            .map_err(|error| error.to_string())?;
        if reply["ok"] == true {
            Ok(reply["value"].clone())
        } else {
            Err(format!(
                "{command} IPC rejected on {}: {}",
                window.label(),
                reply["error"].as_str().unwrap_or("Unknown IPC failure")
            ))
        }
    }

    async fn frame(
        window: &tauri::WebviewWindow,
        name: &str,
        expected: [usize; 3],
        output: &std::path::Path,
    ) -> Result<Value, String> {
        let value = invoke(window, "capture_screenshot").await?;
        let png = base64::engine::general_purpose::STANDARD
            .decode(value["image"].as_str().ok_or("Image missing")?)
            .map_err(|error| error.to_string())?;
        let width = value["width"].as_u64().ok_or("Width missing")?;
        let height = value["height"].as_u64().ok_or("Height missing")?;
        if width == 0 || height == 0 || width > 1280 || height > 720 || png.len() > 1048576 {
            return Err(format!(
                "Invalid image bounds: {width}x{height}, {} bytes",
                png.len()
            ));
        }
        let bitmap = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(&png))
            .ok_or("Native capture is not a decodable PNG")?;
        if bitmap.pixelsWide() != width as isize || bitmap.pixelsHigh() != height as isize {
            return Err("PNG dimensions do not match the native response".into());
        }
        let mut rgb = [0usize; 4];
        if bitmap.samplesPerPixel() < 3 || bitmap.samplesPerPixel() > 4 {
            return Err("Unexpected captured PNG color format".into());
        }
        // SAFETY: the four-component destination is large enough for RGB(A).
        unsafe {
            bitmap.getPixel_atX_y(std::ptr::NonNull::new(rgb.as_mut_ptr()).unwrap(), 20, 20);
        }
        for channel in 0..3 {
            if rgb[channel].abs_diff(expected[channel]) > 4 {
                return Err(format!("{name}: expected {expected:?}, captured {rgb:?}"));
            }
        }
        if value["source"] != "player-view" || value["video"] != "unknown" {
            return Err("Native capture returned incorrect provenance".into());
        }
        std::fs::write(output.join(format!("{name}.png")), &png)
            .map_err(|error| error.to_string())?;
        Ok(json!({"phase": name, "width": width, "height": height,
            "bytes": png.len(), "rgb": &rgb[..3], "source": value["source"], "video": value["video"]}))
    }

    async fn exercise(window: tauri::WebviewWindow, output: PathBuf) -> Result<Value, String> {
        let caps = invoke(&window, "screenshot_capabilities").await?;
        if caps != json!({"supported": true, "source": "player-view"}) {
            return Err("Native screenshot capability probe failed".into());
        }
        let other = window
            .app_handle()
            .get_webview_window("pip")
            .ok_or("Auxiliary fixture missing")?;
        let mut denials = Vec::new();
        for command in ["screenshot_capabilities", "capture_screenshot"] {
            match invoke(&other, command).await {
                Err(error) if error.contains("not allowed") => {
                    denials.push(json!({"command": command, "window": "pip",
                        "error": error.lines().next().unwrap_or(&error)}));
                }
                Err(error) => return Err(format!("Expected an IPC ACL denial, received: {error}")),
                Ok(_) => return Err(format!("Auxiliary view was allowed to invoke {command}")),
            }
        }
        // Wait for the test document's first paint; capture itself still goes
        // through the production with_webview + asynchronous WKWebView callback.
        tokio::time::sleep(Duration::from_millis(350)).await;
        let red = frame(&window, "red", [220, 35, 45], &output).await?;
        window
            .eval("document.body.style.background='rgb(30,80,230)'")
            .map_err(|error| error.to_string())?;
        tokio::time::sleep(Duration::from_millis(150)).await;
        let blue = frame(&window, "blue", [30, 80, 230], &output).await?;
        window
            .set_size(tauri::LogicalSize::new(320.0, 640.0))
            .map_err(|error| error.to_string())?;
        tokio::time::sleep(Duration::from_millis(150)).await;
        let portrait = frame(&window, "portrait", [30, 80, 230], &output).await?;
        if portrait["height"].as_u64().unwrap() <= portrait["width"].as_u64().unwrap() {
            return Err(
                "Resized portrait view was stretched to previous landscape dimensions".into(),
            );
        }
        Ok(
            json!({"status": "pass", "implementation": "production screenshot.rs via JavaScript Tauri IPC",
            "capabilities": caps, "non_main_rejected": true, "ipc_denials": denials,
            "incognito": true, "profile": "isolated fixture", "frames": [red, blue, portrait]}),
        )
    }

    pub fn run() -> Result<i32, Box<dyn std::error::Error>> {
        let output = std::env::args()
            .nth(1)
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::temp_dir()
                    .join(format!("ottplay-screenshot-smoke-{}", std::process::id()))
            });
        std::fs::create_dir_all(&output)?;
        let result_output = output.clone();
        let without_permission =
            std::env::args().any(|arg| arg == "--without-screenshot-permission");
        // The positive path loads all production capabilities. The negative
        // fixture selects the pre-fix set; it never edits or bypasses app ACLs.
        let context = if without_permission {
            tauri::generate_context!("examples/screenshot-smoke/without-permission/tauri.conf.json")
        } else {
            tauri::generate_context!("examples/screenshot-smoke/tauri.conf.json")
        };
        let app = tauri::Builder::default()
            .invoke_handler(tauri::generate_handler![
                screenshot::screenshot_capabilities,
                screenshot::capture_screenshot,
            ])
            .setup(|app| {
                tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("OttPlay own-view screenshot regression")
                .inner_size(640.0, 360.0)
                .decorations(false)
                .incognito(true)
                .build()?;
                tauri::WebviewWindowBuilder::new(
                    app,
                    "pip",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .visible(false)
                .incognito(true)
                .build()?;
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(25)).await;
                    eprintln!("Native screenshot smoke watchdog timed out");
                    handle.exit(1);
                });
                Ok(())
            })
            .on_page_load(move |view, payload| {
                if !matches!(view.label(), "main" | "pip")
                    || payload.event() != tauri::webview::PageLoadEvent::Finished
                    || LOADED.fetch_add(1, Ordering::SeqCst) != 1
                {
                    return;
                }
                let handle = view.app_handle().clone();
                let window = handle
                    .get_webview_window("main")
                    .expect("main fixture window");
                let output = result_output.clone();
                tauri::async_runtime::spawn(async move {
                    let result = exercise(window, output.clone()).await;
                    let mut code = if result.is_ok() { 0 } else { 1 };
                    let report =
                        result.unwrap_or_else(|error| json!({"status": "fail", "error": error}));
                    let report = serde_json::to_string_pretty(&report).unwrap();
                    if let Err(error) = std::fs::write(output.join("result.json"), &report) {
                        eprintln!("Cannot save native screenshot evidence: {error}");
                        code = 1;
                    }
                    println!("{report}");
                    EXIT_CODE.store(code, Ordering::SeqCst);
                    handle.exit(code);
                });
            })
            .build(context)?;
        // The macOS event loop may return zero after AppHandle::exit(1).
        // A timeout, early close or failed assertion must still fail the test.
        app.run_return(|_, _| {});
        Ok(EXIT_CODE.load(Ordering::SeqCst))
    }
}

#[cfg(target_os = "macos")]
fn main() {
    match smoke::run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("Native screenshot smoke failed: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This real WKWebView regression requires a logged-in macOS desktop.");
    std::process::exit(2);
}
