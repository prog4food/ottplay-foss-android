//! Minimum key strength for certificates supplied to this server, not PKI trust validation.
use anyhow::{bail, ensure, Context};
use pkcs1::{RsaPssParams, RsaPublicKey};
use rustls::pki_types::CertificateDer;
use x509_cert::{
    der::{asn1::ObjectIdentifier, Decode},
    spki::SubjectPublicKeyInfoOwned,
    Certificate,
};

const RSA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.1");
const RSA_PSS: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.10");
const EC: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.2.1");
const ED25519: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.101.112");

pub(crate) fn validate_chain(certificates: &[CertificateDer<'_>]) -> anyhow::Result<()> {
    for (index, certificate) in certificates.iter().enumerate() {
        validate_certificate(certificate.as_ref())
            .with_context(|| format!("TLS certificate {} key policy", index + 1))?;
    }
    Ok(())
}

fn validate_certificate(der: &[u8]) -> anyhow::Result<()> {
    // Decode::from_der consumes the entire typed structure, including nested sequences.
    let certificate = Certificate::from_der(der).context("invalid X.509 certificate DER")?;
    validate_public_key(&certificate.tbs_certificate.subject_public_key_info)
}

fn validate_public_key(key: &SubjectPublicKeyInfoOwned) -> anyhow::Result<()> {
    let bytes = key
        .subject_public_key
        .as_bytes()
        .context("unaligned public key bit string")?;
    match key.algorithm.oid {
        RSA | RSA_PSS => validate_rsa(key, bytes),
        EC => validate_ec(key, bytes),
        ED25519 => {
            ensure!(
                key.algorithm.parameters.is_none(),
                "Ed25519 parameters must be absent"
            );
            ensure!(
                bytes.len() == 32,
                "Ed25519 public key must contain 32 bytes"
            );
            Ok(())
        }
        algorithm => bail!("unsupported public key algorithm {algorithm}"),
    }
}

fn validate_rsa(key: &SubjectPublicKeyInfoOwned, bytes: &[u8]) -> anyhow::Result<()> {
    if let Some(parameters) = &key.algorithm.parameters {
        if key.algorithm.oid == RSA {
            parameters
                .decode_as::<()>()
                .context("invalid RSA parameters")?;
        } else {
            parameters
                .decode_as::<RsaPssParams<'_>>()
                .context("invalid RSA-PSS parameters")?;
        }
    }
    // The typed PKCS#1 decoder rejects negative/non-canonical integers and trailing data.
    let rsa = RsaPublicKey::from_der(bytes).context("invalid RSA public key")?;
    let exponent = rsa.public_exponent.as_bytes();
    ensure!(
        exponent.last().is_some_and(|byte| byte & 1 == 1)
            && (exponent.len() > 1 || exponent[0] >= 3),
        "invalid RSA public exponent"
    );
    let bits = unsigned_bit_length(rsa.modulus.as_bytes());
    ensure!(
        bits >= 2048,
        "RSA public key is {bits} bits; at least 2048 required"
    );
    Ok(())
}

fn unsigned_bit_length(bytes: &[u8]) -> usize {
    match bytes.iter().position(|byte| *byte != 0) {
        Some(index) => (bytes.len() - index) * 8 - bytes[index].leading_zeros() as usize,
        None => 0,
    }
}

fn validate_ec(key: &SubjectPublicKeyInfoOwned, bytes: &[u8]) -> anyhow::Result<()> {
    let curve = key
        .algorithm
        .parameters
        .as_ref()
        .context("EC named curve is required")?
        .decode_as::<ObjectIdentifier>()
        .context("invalid EC named curve parameters")?;
    let bits: usize = match curve.to_string().as_str() {
        "1.3.132.0.33" => 224,
        "1.2.840.10045.3.1.7" | "1.3.132.0.10" => 256,
        "1.3.132.0.34" => 384,
        "1.3.132.0.35" => 521,
        _ => bail!("unsupported or undersized EC named curve {curve}"),
    };
    let coordinate_bytes = bits.div_ceil(8);
    let expected = match bytes.first() {
        Some(2 | 3) => 1 + coordinate_bytes,
        Some(4) => 1 + 2 * coordinate_bytes,
        _ => bail!("invalid EC public point encoding"),
    };
    ensure!(
        bytes.len() == expected,
        "invalid EC public point length for {curve}"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use x509_cert::{
        der::{
            asn1::{Any, BitString, UintRef},
            Encode,
        },
        spki::AlgorithmIdentifierOwned,
    };

    fn public_key(
        oid: ObjectIdentifier,
        parameters: Option<Any>,
        bytes: &[u8],
    ) -> SubjectPublicKeyInfoOwned {
        SubjectPublicKeyInfoOwned {
            algorithm: AlgorithmIdentifierOwned { oid, parameters },
            subject_public_key: BitString::from_bytes(bytes).unwrap(),
        }
    }

    fn rsa_bytes(bits: usize) -> Vec<u8> {
        let mut modulus = vec![0xff; bits.div_ceil(8)];
        modulus[0] = 0xff >> (modulus.len() * 8 - bits);
        RsaPublicKey {
            modulus: UintRef::new(&modulus).unwrap(),
            public_exponent: UintRef::new(&[1, 0, 1]).unwrap(),
        }
        .to_der()
        .unwrap()
    }

    #[test]
    fn rsa_uses_exact_bits_and_strict_unsigned_der() {
        for bits in [2041, 2047, 2048, 2049, 3072] {
            let bytes = rsa_bytes(bits);
            assert_eq!(
                validate_public_key(&public_key(RSA, None, &bytes)).is_ok(),
                bits >= 2048,
                "{bits}"
            );
        }
        assert_eq!(unsigned_bit_length(&[0, 0, 0x7f, 0xff]), 15);
        assert_eq!(unsigned_bit_length(&[0]), 0);
        let mut trailing = rsa_bytes(2048);
        trailing.extend([5, 0]);
        assert!(validate_public_key(&public_key(RSA, None, &trailing)).is_err());
        // DER INTEGER -1 is forbidden by the library's UintRef decoder.
        let negative = [0x30, 6, 0x02, 1, 0xff, 0x02, 1, 3];
        assert!(validate_public_key(&public_key(RSA, None, &negative)).is_err());
    }

    #[test]
    fn algorithm_parameters_are_typed_and_unknown_keys_fail_closed() {
        let rsa = rsa_bytes(2048);
        let null = Any::from_der(&[5, 0]).unwrap();
        assert!(validate_public_key(&public_key(RSA, Some(null.clone()), &rsa)).is_ok());
        assert!(validate_public_key(&public_key(RSA_PSS, None, &rsa)).is_ok());
        let pss = Any::from_der(&[0x30, 0]).unwrap();
        assert!(validate_public_key(&public_key(RSA_PSS, Some(pss), &rsa)).is_ok());
        assert!(validate_public_key(&public_key(RSA_PSS, Some(null.clone()), &rsa)).is_err());
        assert!(validate_public_key(&public_key(ED25519, Some(null.clone()), &[0; 32])).is_err());
        assert!(validate_public_key(&public_key(ED25519, None, &[0; 32])).is_ok());
        assert!(validate_public_key(&public_key(ED25519, None, &[0; 31])).is_err());
        let unknown = ObjectIdentifier::new_unwrap("1.2.3.4");
        assert!(validate_public_key(&public_key(unknown, None, &rsa)).is_err());
        assert!(validate_public_key(&public_key(EC, Some(null), &[4; 65])).is_err());
    }

    #[test]
    fn ec_strength_comes_from_named_curve_not_point_length() {
        for (oid, bytes) in [
            ("1.3.132.0.33", 57),
            ("1.2.840.10045.3.1.7", 65),
            ("1.3.132.0.34", 97),
            ("1.3.132.0.35", 133),
        ] {
            let parameters = Any::encode_from(&ObjectIdentifier::new(oid).unwrap()).unwrap();
            let mut point = vec![1; bytes];
            point[0] = 4;
            assert!(validate_public_key(&public_key(EC, Some(parameters.clone()), &point)).is_ok());
            point.pop();
            assert!(validate_public_key(&public_key(EC, Some(parameters), &point)).is_err());
        }
        let p192 = Any::encode_from(&ObjectIdentifier::new_unwrap("1.2.840.10045.3.1.1")).unwrap();
        assert!(validate_public_key(&public_key(EC, Some(p192), &[4; 133])).is_err());
        assert!(validate_public_key(&public_key(EC, None, &[4; 133])).is_err());
    }
}
