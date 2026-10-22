#!/usr/bin/env python3
"""Sign a verified APK using the private release certificate supplied by CI."""
import base64
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
# Existing Full installations must retain this certificate for in-place updates.
CERTIFICATE_SHA256 = "811c6a2e06e574d3906279229196eabb61e4424662087e98e0d1683693dd0d55"


def main():
    source, output = map(Path, sys.argv[1:])
    sdk = Path(os.environ["ANDROID_HOME"]) / "build-tools/36.0.0"
    with tempfile.TemporaryDirectory(prefix="ottplay-sign-") as temporary:
        key = Path(temporary) / "release.p12"
        key.write_bytes(base64.b64decode(os.environ["CAPACITOR_KEYSTORE_BASE64"], validate=True))
        key.chmod(0o600)
        aligned = Path(temporary) / "aligned.apk"
        subprocess.run([str(sdk / "zipalign"), "-p", "-f", "4", str(source), str(aligned)], check=True)
        subprocess.run([str(sdk / "apksigner"), "sign", "--ks", str(key),
                        "--ks-key-alias", os.environ["CAPACITOR_KEY_ALIAS"],
                        "--ks-pass", "env:CAPACITOR_KEY_PASSWORD", "--key-pass", "env:CAPACITOR_KEY_PASSWORD",
                        "--out", str(output), str(aligned)], check=True)
        verification = subprocess.check_output([str(sdk / "apksigner"), "verify", "--print-certs", str(output)], text=True)
        if "Signer #1 certificate SHA-256 digest: " + CERTIFICATE_SHA256 not in verification:
            output.unlink(missing_ok=True)
            raise SystemExit("APK signing certificate differs from the established Full certificate")
    print("Signed APK verified with the established Full update certificate")


if __name__ == "__main__":
    main()
