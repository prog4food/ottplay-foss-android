use anyhow::Context;
use rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::io::Read;

pub(crate) fn read_certificates(reader: impl Read) -> anyhow::Result<Vec<CertificateDer<'static>>> {
    CertificateDer::pem_reader_iter(reader)
        .collect::<Result<Vec<_>, _>>()
        .context("invalid certificate")
}

pub(crate) fn read_private_key(reader: impl Read) -> anyhow::Result<PrivateKeyDer<'static>> {
    // Preserve PKCS#8-only loading and validate the entire file, including PEM
    // sections after the first key, before selecting that key for the server.
    let keys = PrivatePkcs8KeyDer::pem_reader_iter(reader)
        .collect::<Result<Vec<_>, _>>()
        .context("invalid private key")?;
    keys.into_iter()
        .next()
        .map(PrivateKeyDer::from)
        .context("no PKCS#8 private key found")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    // Synthetic byte payloads exercise PEM framing without storing usable keys.
    fn pem(label: &str, payload: &str) -> String {
        format!("-----BEGIN {label}-----\n{payload}\n-----END {label}-----\n")
    }

    #[test]
    fn certificate_chain_preserves_order_and_skips_other_sections() {
        let input =
            pem("CERTIFICATE", "AQID") + &pem("PUBLIC KEY", "BAUG") + &pem("CERTIFICATE", "BwgJ");
        let certificates = read_certificates(input.as_bytes()).unwrap();
        assert_eq!(certificates.len(), 2);
        assert_eq!(certificates[0].as_ref(), [1, 2, 3]);
        assert_eq!(certificates[1].as_ref(), [7, 8, 9]);
    }

    #[test]
    fn first_pkcs8_key_is_selected_without_accepting_other_key_formats() {
        let input = pem("RSA PRIVATE KEY", "AQID")
            + &pem("EC PRIVATE KEY", "BAUG")
            + &pem("PRIVATE KEY", "BwgJ")
            + &pem("PRIVATE KEY", "CgsM");
        let key = read_private_key(input.as_bytes()).unwrap();
        assert!(matches!(key, PrivateKeyDer::Pkcs8(_)));
        assert_eq!(key.secret_der(), [7, 8, 9]);
        for input in [
            String::new(),
            pem("RSA PRIVATE KEY", "AQID"),
            pem("EC PRIVATE KEY", "BAUG"),
        ] {
            let error = read_private_key(input.as_bytes()).unwrap_err();
            assert_eq!(error.to_string(), "no PKCS#8 private key found");
        }
    }

    #[test]
    fn malformed_trailing_sections_reject_the_entire_file() {
        for suffix in [
            pem("PRIVATE KEY", "!invalid!"),
            "-----BEGIN CERTIFICATE-----\nAQID\n".to_string(),
            "-----BEGIN PRIVATE KEY-----\nAQID\n-----END CERTIFICATE-----\n".to_string(),
        ] {
            let cert_input = pem("CERTIFICATE", "AQID") + &suffix;
            let key_input = pem("PRIVATE KEY", "AQID") + &suffix;
            assert_eq!(
                read_certificates(cert_input.as_bytes())
                    .unwrap_err()
                    .to_string(),
                "invalid certificate"
            );
            assert_eq!(
                read_private_key(key_input.as_bytes())
                    .unwrap_err()
                    .to_string(),
                "invalid private key"
            );
        }
    }

    struct BrokenReader;

    impl Read for BrokenReader {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("test read failure"))
        }
    }

    #[test]
    fn io_failures_keep_certificate_and_key_context() {
        let certificate = read_certificates(BrokenReader).unwrap_err();
        let key = read_private_key(BrokenReader).unwrap_err();
        assert_eq!(certificate.to_string(), "invalid certificate");
        assert_eq!(key.to_string(), "invalid private key");
        assert!(format!("{certificate:#}").contains("test read failure"));
        assert!(format!("{key:#}").contains("test read failure"));
    }
}
