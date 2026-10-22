//! Read only the OS search-domain configuration, never its DNS server list.

#[cfg(target_os = "macos")]
pub(super) fn read() -> Vec<String> {
    use system_configuration::{
        core_foundation::{
            array::CFArray,
            base::{CFType, TCFType},
            dictionary::CFDictionary,
            string::CFString,
        },
        dynamic_store::SCDynamicStoreBuilder,
    };
    let Some(store) = SCDynamicStoreBuilder::new("ottplay-control-discovery").build() else {
        return Vec::new();
    };
    let mut keys = vec!["State:/Network/Global/DNS".to_string()];
    if let Some(services) = store.get_keys("State:/Network/Service/[^/]+/DNS") {
        keys.extend(services.iter().take(64).map(|key| key.to_string()));
    }
    let mut domains = Vec::new();
    for key in keys {
        let Some(dict) = store
            .get(key.as_str())
            .and_then(|v| v.downcast_into::<CFDictionary>())
        else {
            continue;
        };
        for field in ["SearchDomains", "DomainName"] {
            let Some(value) = dict.find(CFString::new(field).as_CFTypeRef()) else {
                continue;
            };
            // SAFETY: values in System Configuration property-list dictionaries
            // are CF objects; wrap retains the object before dict is released.
            let value = unsafe { CFType::wrap_under_get_rule(*value) };
            if let Some(string) = value.downcast::<CFString>() {
                domains.push(string.to_string());
            }
            if let Some(array) = value.downcast::<CFArray>() {
                for item in array.iter().take(64) {
                    // SAFETY: property-list arrays also contain CF objects.
                    let item = unsafe { CFType::wrap_under_get_rule(*item) };
                    if let Some(string) = item.downcast::<CFString>() {
                        domains.push(string.to_string());
                    }
                }
            }
        }
    }
    domains
}

#[cfg(windows)]
pub(super) fn read() -> Vec<String> {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
    let machine = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut domains = Vec::new();
    let mut keys = vec![
        r"SOFTWARE\Policies\Microsoft\Windows NT\DNSClient".to_string(),
        r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters".to_string(),
    ];
    let interfaces = r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces";
    if let Ok(key) = machine.open_subkey(interfaces) {
        keys.extend(
            key.enum_keys()
                .filter_map(Result::ok)
                .take(64)
                .map(|name| format!(r"{interfaces}\{name}")),
        );
    }
    for path in keys {
        let Ok(key) = machine.open_subkey(path) else {
            continue;
        };
        for field in ["SearchList", "Domain", "DhcpDomain", "DhcpDomainSearchList"] {
            if let Ok(value) = key.get_value::<String, _>(field) {
                domains.extend(
                    value
                        .split(|c: char| c == ',' || c.is_ascii_whitespace())
                        .filter(|s| !s.is_empty())
                        .take(64)
                        .map(str::to_owned),
                );
            }
        }
    }
    domains
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(super) fn read() -> Vec<String> {
    use std::io::Read;
    let Ok(file) = std::fs::File::open("/etc/resolv.conf") else {
        return Vec::new();
    };
    let mut config = String::new();
    if file.take(64 * 1024).read_to_string(&mut config).is_err() {
        return Vec::new();
    }
    parse_resolv_conf(&config)
}

#[cfg(not(any(unix, windows)))]
pub(super) fn read() -> Vec<String> {
    Vec::new()
}

#[cfg(any(test, all(unix, not(target_os = "macos"))))]
fn parse_resolv_conf(config: &str) -> Vec<String> {
    let mut domains = Vec::new();
    for line in config.lines() {
        let mut words = line
            .split(['#', ';'])
            .next()
            .unwrap_or("")
            .split_whitespace();
        match words.next() {
            Some("search") => domains = words.take(16).map(str::to_owned).collect(),
            Some("domain") => domains = words.take(1).map(str::to_owned).collect(),
            _ => {}
        }
    }
    domains
}

#[cfg(test)]
mod tests {
    #[test]
    fn last_search_directive_wins_and_resolvers_are_not_read() {
        assert_eq!(
            super::parse_resolv_conf(
                "nameserver 1.1.1.1\ndomain old.invalid\nsearch lab.test corp.test # ignored\n"
            ),
            vec!["lab.test", "corp.test"]
        );
        assert_eq!(
            super::parse_resolv_conf("search old.test\ndomain new.test; comment"),
            vec!["new.test"]
        );
    }
}
