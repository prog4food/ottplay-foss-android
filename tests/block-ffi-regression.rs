use block::{Block, ConcreteBlock};
use std::cell::Cell;
use std::ffi::{c_int, c_void};
use std::rc::Rc;

extern "C" {
    fn invoke_int_block(callback: *const c_void, value: c_int) -> c_int;
}

fn invoke_from_c(callback: &Block<(c_int,), c_int>, value: c_int) -> c_int {
    // The pointer references a live block with exactly the C helper's signature.
    unsafe { invoke_int_block(callback as *const _ as *const c_void, value) }
}

#[test]
fn stack_and_copied_capture_use_native_calling_convention() {
    let factor = 7;
    let callback = ConcreteBlock::new(move |value: c_int| value * factor);
    assert_eq!(invoke_from_c(&callback, 6), 42);
    let heap = callback.copy();
    assert_eq!(invoke_from_c(&heap, 8), 56);
    assert_eq!(unsafe { heap.call((9,)) }, 63);
}

#[test]
fn repeated_native_copy_release_keeps_capture_until_last_owner() {
    struct Capture(Rc<Cell<usize>>);
    impl Capture {
        fn use_value(&self, value: c_int) -> c_int {
            assert_eq!(self.0.get(), 0, "capture must still be alive");
            value + 1
        }
    }
    impl Drop for Capture {
        fn drop(&mut self) {
            self.0.set(self.0.get() + 1);
        }
    }
    let drops = Rc::new(Cell::new(0));
    let captured = Capture(Rc::clone(&drops));
    let heap = ConcreteBlock::new(move |value: c_int| captured.use_value(value)).copy();
    let last = heap.clone();
    for value in 0..128 {
        let first = heap.clone();
        let second = first.clone();
        drop(first);
        assert_eq!(invoke_from_c(&second, value), value + 1);
        drop(second);
        assert_eq!(drops.get(), 0);
    }
    drop(heap);
    assert_eq!(drops.get(), 0);
    assert_eq!(invoke_from_c(&last, 41), 42);
    drop(last);
    assert_eq!(
        drops.get(),
        1,
        "captured ownership must be released exactly once"
    );
}

#[test]
fn zero_argument_native_copy_retains_owned_string() {
    let text = String::from("native Blocks runtime");
    let callback = ConcreteBlock::new(move || text.len()).copy();
    let clone = callback.clone();
    drop(callback);
    assert_eq!(unsafe { clone.call(()) }, 21);
}
