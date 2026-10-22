//! Supply the full native preference list before the shared HTML bootstrap.
//! WebKit deliberately exposes only its first language through navigator.languages.

// Tauri runs initialization scripts on subsequent navigations too, and Windows
// also runs them in subframes. Keep native preferences in the trusted main page.
const SCRIPT_TEMPLATE: &str = r#"(function () {
    if (window !== window.top) return;
    var origin = window.location.protocol + "//" + window.location.host;
    if (__OTT_LANGUAGE_ORIGINS__.indexOf(origin) === -1) return;
    window.__ottPreferredLanguages = __OTT_LANGUAGE_VALUES__;
}());"#;

pub fn initialization_script(
    configured_url: Option<&url::Url>,
    dev_url: Option<&url::Url>,
) -> String {
    script_for(
        &preferred_languages(),
        &trusted_origins(configured_url, dev_url),
    )
}

fn trusted_origins(configured_url: Option<&url::Url>, dev_url: Option<&url::Url>) -> Vec<String> {
    let mut origins: Vec<String> = [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ]
    .map(String::from)
    .into();
    for url in [configured_url, dev_url].into_iter().flatten() {
        // Only server origins have a usable tuple here. Do not trust all opaque
        // file/data/about URLs via origin="null" or expose URL credentials.
        if matches!(url.scheme(), "http" | "https") {
            let origin = url.origin().ascii_serialization();
            if !origins.contains(&origin) {
                origins.push(origin);
            }
        }
    }
    origins
}

fn script_for(languages: &[String], origins: &[String]) -> String {
    let json = serde_json::to_string(languages).unwrap_or_else(|_| "[]".into());
    let origins = serde_json::to_string(origins).unwrap_or_else(|_| "[]".into());
    SCRIPT_TEMPLATE
        .replace("__OTT_LANGUAGE_ORIGINS__", &origins)
        .replace("__OTT_LANGUAGE_VALUES__", &json)
}

#[cfg(not(all(unix, not(target_vendor = "apple"))))]
fn preferred_languages() -> Vec<String> {
    sys_locale::get_locales().collect()
}

#[cfg(all(unix, not(target_vendor = "apple")))]
fn preferred_languages() -> Vec<String> {
    // sys-locale drops POSIX script modifiers. Preserve them so sr@latin cannot
    // select our Cyrillic catalog, and use the same environment preference order.
    posix_languages(
        ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"]
            .map(|key| std::env::var(key).unwrap_or_default()),
    )
}

#[cfg(any(test, all(unix, not(target_vendor = "apple"))))]
fn posix_languages(values: [String; 4]) -> Vec<String> {
    // GNU gettext ignores LANGUAGE when the effective message locale is C/POSIX,
    // including C.UTF-8. Keep English authoritative instead of falling through
    // to the WebView's language list. Empty overrides do not mask lower levels.
    let message_locale = values[1..]
        .iter()
        .map(|value| value.trim())
        .find(|value| !value.is_empty());
    if message_locale
        .is_some_and(|value| matches!(value.split(['.', '@']).next(), Some("C" | "POSIX")))
    {
        return vec!["en".into()];
    }
    let mut languages = Vec::new();
    // LANGUAGE is a preference list; LC_ALL/LC_MESSAGES/LANG are overrides,
    // not additional fallbacks after an unsupported effective message locale.
    let preferences = if values[0].trim().is_empty() {
        message_locale.unwrap_or("")
    } else {
        values[0].as_str()
    };
    for entry in preferences.split(':') {
        if let Some(language) = posix_language(entry) {
            if !languages
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(&language))
            {
                languages.push(language);
            }
        }
    }
    languages
}

#[cfg(any(test, all(unix, not(target_vendor = "apple"))))]
fn posix_language(value: &str) -> Option<String> {
    let (base, modifier) = value.trim().split_once('@').unwrap_or((value.trim(), ""));
    let tag = base.split('.').next()?.replace('_', "-");
    if tag.is_empty() || tag == "C" || tag == "POSIX" {
        return None;
    }
    let script = match modifier.to_ascii_lowercase().as_str() {
        "" | "euro" => return Some(tag),
        "latin" => "Latn",
        "cyrillic" => "Cyrl",
        "arabic" => "Arab",
        "devanagari" => "Deva",
        "gurmukhi" => "Guru",
        // An unknown modifier may select an unsupported writing system.
        _ => return None,
    };
    let mut parts: Vec<&str> = tag.split('-').collect();
    if parts.get(1).is_some_and(|part| part.len() == 4) {
        if !parts[1].eq_ignore_ascii_case(script) {
            return None;
        }
    } else {
        parts.insert(1, script);
    }
    Some(parts.join("-"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_preserves_order_and_escapes_values() {
        let values = vec!["zz-ZZ".into(), "ru-RU".into(), "x-\"\\\n".into()];
        let script = script_for(&values, &[]);
        let json = script
            .split_once("window.__ottPreferredLanguages = ")
            .unwrap()
            .1
            .split_once(';')
            .unwrap()
            .0;
        assert_eq!(serde_json::from_str::<Vec<String>>(json).unwrap(), values);
        assert!(script_for(&[], &[]).contains("window.__ottPreferredLanguages = [];"));
    }

    #[test]
    fn scope_contains_only_bundled_and_selected_server_origins() {
        let configured = url::Url::parse(
            "https://owner:password@Custom.Example:8443/player?token=private#fragment",
        )
        .unwrap();
        let dev = url::Url::parse("http://[::1]:5173/player").unwrap();
        let origins = trusted_origins(Some(&configured), Some(&dev));
        assert_eq!(
            origins,
            [
                "tauri://localhost",
                "http://tauri.localhost",
                "https://tauri.localhost",
                "https://custom.example:8443",
                "http://[::1]:5173"
            ]
        );
        let script = script_for(&["ru-RU".into()], &origins);
        for private in [
            "owner", "password", "token", "private", "fragment", "/player",
        ] {
            assert!(!script.contains(private), "URL details leaked: {private}");
        }
        for value in [
            "file:///player/index.html",
            "data:text/html,player",
            "about:blank",
        ] {
            let url = url::Url::parse(value).unwrap();
            assert_eq!(
                trusted_origins(Some(&url), None),
                trusted_origins(None, None)
            );
        }
        let default_port = url::Url::parse("https://custom.example:443/player").unwrap();
        assert_eq!(
            trusted_origins(Some(&default_port), None).last().unwrap(),
            "https://custom.example"
        );
    }

    #[test]
    fn linux_preferences_preserve_scripts_and_order() {
        assert_eq!(
            posix_languages([
                "sr_RS.UTF-8@latin:ru_RU:ru-RU:pa_PK@arabic".into(),
                "zh_TW.UTF-8".into(),
                "ru_RU.UTF-8".into(),
                "en_US.UTF-8".into(),
            ]),
            ["sr-Latn-RS", "ru-RU", "pa-Arab-PK"]
        );
        assert_eq!(
            posix_language("sr_Cyrl_RS@cyrillic"),
            Some("sr-Cyrl-RS".into())
        );
        assert_eq!(posix_language("sr_Cyrl_RS@latin"), None);
        assert_eq!(posix_language("sr_RS@unknown"), None);
        assert_eq!(posix_language("C.UTF-8"), None);
        assert_eq!(posix_language("POSIX"), None);
    }

    #[test]
    fn effective_c_locale_overrides_language_preferences() {
        for locale in ["C", "POSIX", "C.UTF-8", "C.utf8", "POSIX.UTF-8"] {
            for index in 1..4 {
                let mut values = ["fr:de".into(), "".into(), "".into(), "".into()];
                values[index] = locale.into();
                for lower in &mut values[index + 1..] {
                    *lower = "ru_RU.UTF-8".into();
                }
                let languages = posix_languages(values);
                assert_eq!(languages, ["en"], "locale {locale} at level {index}");
                assert!(script_for(&languages, &[])
                    .contains("window.__ottPreferredLanguages = [\"en\"];"));
            }
        }
    }

    #[test]
    fn shadowed_c_locale_does_not_disable_language_preferences() {
        for values in [
            ["fr:de", "sr_RS@latin", "C", "POSIX.UTF-8"],
            ["fr:de", "", "sr_RS@latin", "C.UTF-8"],
        ] {
            assert_eq!(posix_languages(values.map(String::from)), ["fr", "de"]);
        }
        assert_eq!(
            posix_languages(["fr:de", "", "", ""].map(String::from)),
            ["fr", "de"]
        );
        assert!(posix_languages(["", "", "", ""].map(String::from)).is_empty());
    }
    #[test]
    fn lower_priority_locales_are_not_language_fallbacks() {
        assert_eq!(
            posix_languages(["", "sr_RS@latin", "ru_RU.UTF-8", "en_US.UTF-8"].map(String::from)),
            ["sr-Latn-RS"]
        );
        assert_eq!(
            posix_languages(["", "", "zh_TW.UTF-8", "ru_RU.UTF-8"].map(String::from)),
            ["zh-TW"]
        );
        assert_eq!(
            posix_languages(["", "", "", "ru_RU.UTF-8"].map(String::from)),
            ["ru-RU"]
        );
    }
}
