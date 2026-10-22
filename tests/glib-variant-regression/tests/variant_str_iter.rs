use glib::prelude::*;

// RUSTSEC-2024-0429 writes a C out-parameter through an immutable Rust
// reference. Exercise both iterator directions under release optimization.
#[test]
fn borrowed_strings_survive_forward_reverse_and_mixed_iteration() {
    let values = vec!["first", "", "слова", "last"];
    for _ in 0..128 {
        let variant = std::hint::black_box(&values).to_variant();
        let forward: Vec<_> = variant.array_iter_str().unwrap().collect();
        assert_eq!(forward, values);
        let reverse: Vec<_> = variant.array_iter_str().unwrap().rev().collect();
        assert_eq!(reverse, values.iter().copied().rev().collect::<Vec<_>>());
        let mut mixed = variant.array_iter_str().unwrap();
        assert_eq!(mixed.next(), Some("first"));
        assert_eq!(mixed.next_back(), Some("last"));
        assert_eq!(mixed.next_back(), Some("слова"));
        assert_eq!(mixed.next(), Some(""));
        assert_eq!(mixed.next(), None);
        assert_eq!(mixed.next_back(), None);
        assert_eq!(variant.array_iter_str().unwrap().nth(2), Some("слова"));
        assert_eq!(variant.array_iter_str().unwrap().nth_back(2), Some(""));
        assert_eq!(variant.array_iter_str().unwrap().last(), Some("last"));
    }
}
