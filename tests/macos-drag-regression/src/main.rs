use objc2::{msg_send, rc::Retained, runtime::AnyObject};
use std::ffi::{c_void, CString};
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    platform::macos::{ActivationPolicy, EventLoopExtMacOS, WindowExtMacOS},
    window::WindowBuilder,
};
use wry::{DragDropEvent, WebViewBuilder, WebViewExtMacOS};

extern "C" {
    fn make_fixture(name: *const i8) -> *mut c_void;
    fn schedule_fixture(target: *mut c_void, info: *mut c_void, is_drop: i32, is_tao: i32);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(args.len(), 4, "expected surface, action and fixture");
    let (surface, action, fixture) = (&args[1], &args[2], &args[3]);
    assert!(matches!(surface.as_str(), "wry" | "tao"));
    assert!(matches!(action.as_str(), "enter" | "drop"));

    let mut event_loop = EventLoop::new();
    event_loop.set_activation_policy(ActivationPolicy::Prohibited);
    event_loop.set_dock_visibility(false);
    event_loop.set_activate_ignoring_other_apps(false);
    let window = WindowBuilder::new()
        .with_visible(false)
        .with_focused(false)
        .with_title("Synthetic drag regression")
        .build(&event_loop)
        .unwrap();
    let webview = WebViewBuilder::new()
        .with_incognito(true)
        .with_focused(false)
        .with_html("<html><body>Synthetic fixture</body></html>")
        .with_drag_drop_handler(|event| {
            match event {
                DragDropEvent::Enter { paths, .. } => {
                    println!("EVENT enter");
                    for path in paths {
                        println!("PATH {}", path.display());
                    }
                }
                DragDropEvent::Drop { paths, .. } => {
                    println!("EVENT drop");
                    for path in paths {
                        println!("PATH {}", path.display());
                    }
                }
                _ => {}
            }
            true
        })
        .build(&window)
        .unwrap();
    unsafe {
        let target = if surface == "wry" {
            Retained::as_ptr(&webview.webview()) as *mut c_void
        } else {
            let win = window.ns_window() as *mut AnyObject;
            let delegate: *mut AnyObject = msg_send![win, delegate];
            delegate as *mut c_void
        };
        let name = CString::new(fixture.as_str()).unwrap();
        let info = make_fixture(name.as_ptr());
        schedule_fixture(
            target,
            info,
            i32::from(action == "drop"),
            i32::from(surface == "tao"),
        );
    }
    event_loop.run(move |event, _, control| {
        let _keepalive = (&window, &webview);
        if let Event::WindowEvent { event, .. } = event {
            match event {
                WindowEvent::HoveredFile(path) => {
                    println!("EVENT enter");
                    println!("PATH {}", path.display());
                }
                WindowEvent::DroppedFile(path) => {
                    println!("EVENT drop");
                    println!("PATH {}", path.display());
                }
                _ => {}
            }
        }
        *control = ControlFlow::Wait;
    });
}
