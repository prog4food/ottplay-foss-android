//! Snapshot this player's main webview, never the desktop or another window.
//!
//! The frontend authorizes the configured remote-control connection and checks its owner.
//! macOS uses WKWebView.takeSnapshot; GPU/protected video may not appear in it.

#[derive(serde::Serialize)]
pub struct ScreenshotCapabilities {
    supported: bool,
    source: Option<&'static str>,
}

#[derive(Debug, serde::Serialize)]
pub struct Screenshot {
    image: String,
    width: u32,
    height: u32,
    source: &'static str,
    video: &'static str,
}

fn require_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("Screenshot capture is restricted to the main player view".into())
    }
}

#[tauri::command]
pub fn screenshot_capabilities(
    window: tauri::WebviewWindow,
) -> Result<ScreenshotCapabilities, String> {
    require_main(window.label())?;
    let supported = cfg!(target_os = "macos");
    Ok(ScreenshotCapabilities {
        supported,
        source: supported.then_some("player-view"),
    })
}

#[tauri::command]
pub async fn capture_screenshot(window: tauri::WebviewWindow) -> Result<Screenshot, String> {
    require_main(window.label())?;
    #[cfg(target_os = "macos")]
    return macos::capture(window).await;
    #[cfg(not(target_os = "macos"))]
    Err("Native player screenshot capture is unavailable on this platform".into())
}

#[cfg(any(target_os = "macos", test))]
fn bounded_size(width: f64, height: f64) -> Result<(u32, u32), String> {
    if !width.is_finite() || !height.is_finite() || width < 1.0 || height < 1.0 {
        return Err("The player view has no drawable area".into());
    }
    let scale = (1280.0 / width).min(720.0 / height).min(1.0);
    Ok((
        (width * scale).floor().max(1.0) as u32,
        (height * scale).floor().max(1.0) as u32,
    ))
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{bounded_size, Screenshot};
    use base64::Engine;
    use block2::RcBlock;
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSCompositingOperation, NSDeviceRGBColorSpace,
        NSGraphicsContext, NSImage,
    };
    use objc2_foundation::{NSDictionary, NSError, NSNumber, NSPoint, NSRect, NSSize};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use std::{cell::RefCell, sync::Arc, sync::LazyLock, time::Duration};
    use tokio::sync::{oneshot, Semaphore};

    const MAX_PNG_BYTES: usize = 1024 * 1024;
    // The native callback holds the permit even after an async timeout. A stuck
    // WebKit operation cannot accumulate a queue of more screenshot requests.
    static CAPTURE_SLOT: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(1)));

    pub async fn capture(window: tauri::WebviewWindow) -> Result<Screenshot, String> {
        let permit = CAPTURE_SLOT
            .clone()
            .try_acquire_owned()
            .map_err(|_| "A player screenshot is already in progress".to_string())?;
        let (sender, receiver) = oneshot::channel();
        window
            .with_webview(move |platform| {
                // Tauri dispatches this closure to the UI thread. Do not block that
                // thread waiting for WebKit's asynchronous completion handler.
                let Some(mtm) = MainThreadMarker::new() else {
                    let _ = sender.send(Err("Screenshot capture requires the UI thread".into()));
                    return;
                };
                if sender.is_closed() {
                    return;
                }
                // SAFETY: PlatformWebview::inner is this live WKWebView, valid for
                // the duration of with_webview. It never comes from IPC parameters.
                let Some(view) = (unsafe { platform.inner().cast::<WKWebView>().as_ref() }) else {
                    let _ = sender.send(Err("The player view is no longer available".into()));
                    return;
                };
                let bounds = view.bounds();
                let (width, _) = match bounded_size(bounds.size.width, bounds.size.height) {
                    Ok(size) => size,
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        return;
                    }
                };
                let sender = RefCell::new(Some(sender));
                let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let _keep_slot_until_completion = &permit;
                    let Some(sender) = sender.borrow_mut().take() else {
                        return;
                    };
                    // The caller timed out or its window went away. Do not spend
                    // time encoding or retain an image after cancellation.
                    if sender.is_closed() {
                        return;
                    }
                    let result = if !error.is_null() {
                        Err("WebKit could not capture the player view".into())
                    } else {
                        // SAFETY: WebKit owns these callback objects for this call.
                        unsafe { image.as_ref() }
                            .ok_or_else(|| "WebKit returned no player image".into())
                            .and_then(encode)
                    };
                    let _ = sender.send(result);
                });
                // SAFETY: UI-thread-only WebKit objects and a retained escaping
                // completion block; configuration width is bounded in view points.
                unsafe {
                    let configuration = WKSnapshotConfiguration::new(mtm);
                    configuration.setSnapshotWidth(Some(&NSNumber::new_f64(width as f64)));
                    configuration.setAfterScreenUpdates(true);
                    view.takeSnapshotWithConfiguration_completionHandler(
                        Some(&configuration),
                        &completion,
                    );
                }
            })
            .map_err(|_| "The player view is no longer available".to_string())?;
        tokio::time::timeout(Duration::from_secs(8), receiver)
            .await
            .map_err(|_| "Player screenshot capture timed out".to_string())?
            .map_err(|_| "The player view closed during screenshot capture".to_string())?
    }

    fn encode(image: &NSImage) -> Result<Screenshot, String> {
        // The window may resize while WebKit takes its asynchronous snapshot.
        // Preserve the returned image's actual aspect, not the earlier bounds.
        let size = image.size();
        let (mut width, mut height) = bounded_size(size.width, size.height)?;
        loop {
            let data = render_png(image, width, height)?;
            if data.len() <= MAX_PNG_BYTES {
                return Ok(Screenshot {
                    image: base64::engine::general_purpose::STANDARD.encode(data),
                    width,
                    height,
                    source: "player-view",
                    video: "unknown",
                });
            }
            // A noisy 1280x720 PNG can exceed the transport budget. Downsample
            // the same snapshot rather than recapturing a different UI state.
            if width == 1 && height == 1 {
                return Err("The player screenshot exceeds the image size limit".into());
            }
            width = (width / 2).max(1);
            height = (height / 2).max(1);
        }
    }

    fn render_png(image: &NSImage, width: u32, height: u32) -> Result<Vec<u8>, String> {
        // SAFETY: AppKit allocates the bitmap when planes is null. Dimensions
        // are positive and bounded; all AppKit calls run in WebKit's UI callback.
        unsafe {
            let bitmap = NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(), std::ptr::null_mut(), width as isize,
                height as isize, 8, 4, true, false, NSDeviceRGBColorSpace, 0, 0,
            ).ok_or_else(|| "Could not allocate the player screenshot".to_string())?;
            let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)
                .ok_or_else(|| "Could not render the player screenshot".to_string())?;
            NSGraphicsContext::saveGraphicsState_class();
            NSGraphicsContext::setCurrentContext(Some(&context));
            image.drawInRect_fromRect_operation_fraction_respectFlipped_hints(
                NSRect::new(
                    NSPoint::new(0.0, 0.0),
                    NSSize::new(width as f64, height as f64),
                ),
                NSRect::new(NSPoint::new(0.0, 0.0), image.size()),
                NSCompositingOperation::Copy,
                1.0,
                true,
                None,
            );
            NSGraphicsContext::restoreGraphicsState_class();
            let data = bitmap
                .representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &NSDictionary::new(),
                )
                .ok_or_else(|| "Could not encode the player screenshot as PNG".to_string())?;
            Ok(data.to_vec())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use objc2::rc::{autoreleasepool, Retained};
        use objc2_foundation::NSData;

        fn noise_image(width: u32, height: u32) -> Retained<NSImage> {
            // An incompressible, fully opaque image exercises the real AppKit
            // encoder and its transport-size fallback without taking a screen.
            unsafe {
                let bitmap = NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                    NSBitmapImageRep::alloc(), std::ptr::null_mut(), width as isize,
                    height as isize, 8, 4, true, false, NSDeviceRGBColorSpace, 0, 0,
                ).unwrap();
                let stride = bitmap.bytesPerRow() as usize;
                let pixels =
                    std::slice::from_raw_parts_mut(bitmap.bitmapData(), stride * height as usize);
                let mut state = 0x12ab56cdu32;
                for row in pixels.chunks_exact_mut(stride) {
                    for pixel in row[..width as usize * 4].chunks_exact_mut(4) {
                        for component in pixel.iter_mut().take(3) {
                            state ^= state << 13;
                            state ^= state >> 17;
                            state ^= state << 5;
                            *component = state as u8;
                        }
                        pixel[3] = 255;
                    }
                }
                let image = NSImage::initWithSize(
                    NSImage::alloc(),
                    NSSize::new(width as f64, height as f64),
                );
                image.addRepresentation(&bitmap);
                image
            }
        }

        #[test]
        fn native_png_preserves_pixels_and_bounds_large_images() {
            autoreleasepool(|_| {
                let image = noise_image(1280, 720);
                assert!(render_png(&image, 1280, 720).unwrap().len() > MAX_PNG_BYTES);
                let screenshot = encode(&image).unwrap();
                assert_eq!((screenshot.width, screenshot.height), (640, 360));
                assert_eq!(screenshot.source, "player-view");
                assert_eq!(screenshot.video, "unknown");
                let png = base64::engine::general_purpose::STANDARD
                    .decode(screenshot.image)
                    .unwrap();
                assert!(png.len() <= MAX_PNG_BYTES);
                assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
                let decoded =
                    NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(&png)).unwrap();
                assert_eq!(decoded.pixelsWide(), 640);
                assert_eq!(decoded.pixelsHigh(), 360);
                // Verify this is image content, not an empty or transparent PNG.
                let stride = decoded.samplesPerPixel() as usize;
                assert!(stride >= 3);
                let pixels =
                    unsafe { std::slice::from_raw_parts(decoded.bitmapData(), stride * 2) };
                assert!(pixels[..3].iter().any(|component| *component != 0));
                assert_ne!(&pixels[..3], &pixels[stride..stride + 3]);
            });
        }

        #[test]
        fn native_png_keeps_small_image_dimensions() {
            autoreleasepool(|_| {
                let image = noise_image(32, 18);
                let screenshot = encode(&image).unwrap();
                assert_eq!((screenshot.width, screenshot.height), (32, 18));
                let png = base64::engine::general_purpose::STANDARD
                    .decode(screenshot.image)
                    .unwrap();
                let decoded =
                    NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(&png)).unwrap();
                assert_eq!((decoded.pixelsWide(), decoded.pixelsHigh()), (32, 18));
            });
        }

        #[test]
        fn encoding_uses_returned_snapshot_aspect_after_a_view_resize() {
            autoreleasepool(|_| {
                let image = noise_image(100, 100);
                // WebKit's returned NSImage owns its geometry. Its view may now
                // have a different size from the bounds used to request it.
                image.setSize(NSSize::new(1000.0, 2000.0));
                let screenshot = encode(&image).unwrap();
                assert_eq!((screenshot.width, screenshot.height), (360, 720));
                let png = base64::engine::general_purpose::STANDARD
                    .decode(screenshot.image)
                    .unwrap();
                let decoded =
                    NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(&png)).unwrap();
                assert_eq!((decoded.pixelsWide(), decoded.pixelsHigh()), (360, 720));
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_is_main_view_only() {
        assert!(require_main("main").is_ok());
        for label in ["pip", "", "MAIN", "main/child"] {
            assert!(require_main(label).is_err());
        }
    }

    #[test]
    fn bounds_preserve_aspect_without_upscaling() {
        assert_eq!(bounded_size(3840.0, 2160.0).unwrap(), (1280, 720));
        assert_eq!(bounded_size(1080.0, 1920.0).unwrap(), (405, 720));
        assert_eq!(bounded_size(640.0, 480.0).unwrap(), (640, 480));
        assert_eq!(bounded_size(10000.0, 1.0).unwrap(), (1280, 1));
        for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(bounded_size(invalid, 720.0).is_err());
            assert!(bounded_size(1280.0, invalid).is_err());
        }
    }
}
