#!/usr/bin/env python3
"""Exercise the shipped legacy update TLS factory against real local TLS servers."""
import hashlib
import http.server
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
JAVA = Path(os.environ["JAVA_HOME"]) / "bin" if os.environ.get("JAVA_HOME") else None


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"verified TLS")

    def log_message(self, *_args):
        pass


bundled = ROOT / "android/app/src/main/res/raw/isrg_root_x1.pem"
assert hashlib.sha256(ssl.PEM_cert_to_DER_cert(bundled.read_text())).hexdigest() == (
    "96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6"
)

with tempfile.TemporaryDirectory(prefix="ott-update-tls-") as name:
    work = Path(name)
    javac = str(JAVA / "javac") if JAVA else shutil.which("javac")
    java = str(JAVA / "java") if JAVA else shutil.which("java")
    keytool = str(JAVA / "keytool") if JAVA else shutil.which("keytool")
    assert javac and java and keytool
    for ca in ["platform", "supplemental", "untrusted"]:
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
            "-keyout", ca + ".key", "-out", ca + ".pem", "-days", "2",
            "-subj", "/CN=" + ca, "-addext", "basicConstraints=critical,CA:TRUE", cwd=work)
    (work / "leaf.ext").write_text(
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n"
    )
    for leaf, ca, days in [("platform", "platform", "1"),
                           ("supplemental", "supplemental", "1"),
                           ("untrusted", "untrusted", "1"),
                           ("expired", "supplemental", "-1")]:
        run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", leaf + "-leaf.key",
            "-out", leaf + ".csr", "-subj", "/CN=localhost", cwd=work)
        if leaf == "expired":
            (work / "index").touch()
            (work / "serial").write_text("1000\n")
            (work / "ca.cnf").write_text(
                "[ca]\ndefault_ca=local\n[local]\ndatabase=index\nserial=serial\n"
                "new_certs_dir=.\ncertificate=supplemental.pem\nprivate_key=supplemental.key\n"
                "default_md=sha256\npolicy=subject\n[subject]\ncommonName=supplied\n"
            )
            run("openssl", "ca", "-batch", "-config", "ca.cnf", "-in", leaf + ".csr",
                "-out", leaf + "-leaf.pem", "-startdate", "200101000000Z",
                "-enddate", "200102000000Z", "-extfile", "leaf.ext", cwd=work)
        else:
            run("openssl", "x509", "-req", "-in", leaf + ".csr", "-CA", ca + ".pem",
                "-CAkey", ca + ".key", "-CAcreateserial", "-out", leaf + "-leaf.pem",
                "-days", days, "-sha256", "-extfile", "leaf.ext", cwd=work)
    run(keytool, "-importcert", "-noprompt", "-alias", "platform", "-file", "platform.pem",
        "-keystore", "platform.p12", "-storetype", "PKCS12", "-storepass", "test-password", cwd=work)
    (work / "TlsProbe.java").write_text(r'''
package play.ott.foss;
import java.io.FileInputStream;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLSocketFactory;
public class TlsProbe {
    public static void main(String[] args) throws Exception {
        SSLSocketFactory factory;
        try (FileInputStream root = new FileInputStream(args[0])) {
            factory = LegacyUpdateTls.create(root);
        }
        HttpsURLConnection connection = (HttpsURLConnection) new URL(args[1]).openConnection();
        connection.setSSLSocketFactory(factory);
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        boolean accepted;
        try { accepted = connection.getResponseCode() == 200; }
        catch (SSLException expected) { accepted = false; }
        finally { connection.disconnect(); }
        if (accepted != Boolean.parseBoolean(args[2])) throw new AssertionError("Unexpected TLS result");
    }
}
''')
    run(javac, "--release", "8", "-d", str(work), str(work / "TlsProbe.java"),
        str(ROOT / "android/app/src/main/java/play/ott/foss/LegacyUpdateTls.java"))
    servers = []
    try:
        for leaf in ["platform", "supplemental", "untrusted", "expired"]:
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_cert_chain(work / (leaf + "-leaf.pem"), work / (leaf + "-leaf.key"))
            server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            servers.append((server, thread))
            hosts = ["localhost", "127.0.0.1"] if leaf == "supplemental" else ["localhost"]
            for host in hosts:
                expected = leaf in ["platform", "supplemental"] and host == "localhost"
                run(java, "-Djavax.net.ssl.trustStore=" + str(work / "platform.p12"),
                    "-Djavax.net.ssl.trustStorePassword=test-password", "-cp", str(work),
                    "play.ott.foss.TlsProbe", str(work / "supplemental.pem"),
                    f"https://{host}:{server.server_port}/", str(expected).lower())
                print(f"PASS {leaf} / {host}: {'accepted' if expected else 'rejected'}")
    finally:
        for server, thread in servers:
            server.shutdown()
            server.server_close()
            thread.join()
