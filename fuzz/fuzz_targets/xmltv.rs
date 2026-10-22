#![no_main]
libfuzzer_sys::fuzz_target!(|data: &[u8]| ottplay_fuzz::xmltv(data));
