#!/usr/bin/env python3
"""Offline HTTP proxy regressions: dummy loopback fixtures, no live providers."""

import contextlib
import email.message
import importlib.util
import io
import ipaddress
import os
import runpy
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import warnings
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "archive"))
import proxy_security as proxy

with mock.patch.object(sys, "argv", ["server.py", "0", "--no-epg"]):
    spec = importlib.util.spec_from_file_location("ottplay_archived_server", ROOT / "archive/server.py")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)


def answer(address, port=80):
    ip = ipaddress.ip_address(address)
    family = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
    sockaddr = (str(ip), port, 0, 0) if ip.version == 6 else (str(ip), port)
    return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)


@contextlib.contextmanager
def fixture(response):
    listener = socket.socket()
    try:
        listener.bind(("127.0.0.1", 0))
    except OSError:
        listener.close()
        raise
    listener.listen(1)
    listener.settimeout(3)
    port = listener.getsockname()[1]
    received = []
    errors = []

    def serve():
        try:
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(3)
                request = b""
                while b"\r\n\r\n" not in request:
                    request += connection.recv(4096)
                received.append(request)
                connection.sendall(response)
        except OSError as error:
            errors.append(error)
        finally:
            listener.close()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield port, received
    finally:
        thread.join(4)
        listener.close()
        if thread.is_alive():
            raise AssertionError("Fixture did not finish")
        if errors:
            raise errors[0]


class ProxySecurityTests(unittest.TestCase):
    def setUp(self):
        self.environment = mock.patch.dict(os.environ, {"OTTPLAY_PROXY_LAN_ORIGINS": ""})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_channel_normalization_preserves_parenthetical_and_quality_rules(self):
        cases = {
            "  HD РОССИЯ (Алания) +4ч  ": "россия",
            "Channel (outer (inner) tail) FHD": "channel tail)",
            "Channel (open (tail UHD": "channel (open (tail",
            "Channel ) unmatched": "channel ) unmatched",
            "A()B(one)C": "abc",
            "HD\tChannel\u2003FHD": "channel",
            "Channel (line\nbreak) +2h": "channel",
            "HD": "hd",
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                self.assertEqual(server.normalize_name(name), expected)

    def test_unclosed_parenthetical_tail_has_bounded_processing_time(self):
        # The old regex retries the entire unmatched tail at each opening
        # parenthesis. A separate process bounds that failure without a hung CI.
        script = (
            "import sys; sys.argv=['server.py','0','--no-epg']; "
            "from archive.server import normalize_name; "
            "name='(' * 300000; assert normalize_name(name)==name"
        )
        result = subprocess.run(
            [sys.executable, "-c", script], cwd=ROOT,
            capture_output=True, text=True, timeout=5, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_proxy_sets_tls_floor_and_preserves_peer_verification(self):
        for initial_floor in (ssl.TLSVersion.TLSv1, ssl.TLSVersion.TLSv1_3):
            with self.subTest(initial_floor=initial_floor):
                context = ssl.create_default_context()
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", DeprecationWarning)
                    context.minimum_version = initial_floor
                transport = mock.Mock()
                wrapped = mock.Mock()
                parsed = proxy._http_url("https://tls-fixture.invalid/list")
                connection = proxy._PinnedConnection(parsed, [answer("127.0.0.1", 443)], time.monotonic() + 3)
                with (
                    mock.patch.object(proxy.socket, "socket", return_value=transport),
                    mock.patch.object(proxy.ssl, "create_default_context", return_value=context),
                    mock.patch.object(context, "wrap_socket", return_value=wrapped) as wrap,
                ):
                    connection.connect()
                self.assertEqual(context.minimum_version, max(initial_floor, ssl.TLSVersion.TLSv1_2))
                self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
                self.assertTrue(context.check_hostname)
                wrap.assert_called_once_with(transport, server_hostname="tls-fixture.invalid")
                self.assertIs(connection.sock, wrapped)
                connection.close()

    def test_archived_https_entrypoint_sets_tls_floor_before_listening(self):
        for initial_floor in (ssl.TLSVersion.TLSv1, ssl.TLSVersion.TLSv1_3):
            with self.subTest(initial_floor=initial_floor):
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", DeprecationWarning)
                    context.minimum_version = initial_floor
                listener = mock.Mock()
                listener.serve_forever.side_effect = KeyboardInterrupt
                arguments = ["server.py", "0", "--no-epg", "--cert", "fixture.crt", "--key", "fixture.key"]
                observed = []
                ssl_module = mock.Mock(wraps=ssl)
                ssl_module.SSLContext = mock.Mock(return_value=context)
                ssl_module.TLSVersion = ssl.TLSVersion

                def wrap(sock, *, server_side, context=context, observed=observed):
                    observed.append((context.minimum_version, server_side))
                    return sock

                with (
                    mock.patch.object(sys, "argv", arguments),
                    mock.patch("os.chdir"),
                    mock.patch("socketserver.TCPServer.__new__", return_value=listener),
                    mock.patch.dict(sys.modules, {"ssl": ssl_module}),
                    mock.patch.object(context, "load_cert_chain") as load,
                    mock.patch.object(context, "wrap_socket", side_effect=wrap),
                    mock.patch("threading.Thread"),
                    mock.patch("builtins.print"),
                    self.assertRaises(SystemExit) as exited,
                ):
                    runpy.run_path(str(ROOT / "archive/server.py"), run_name="__main__")
                self.assertEqual(exited.exception.code, 0)
                self.assertEqual(observed, [(max(initial_floor, ssl.TLSVersion.TLSv1_2), True)])
                load.assert_called_once_with("fixture.crt", "fixture.key")

    def test_special_ipv4_ipv6_and_non_http_schemes_are_rejected(self):
        for address in (
            "127.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "::127.0.0.1",
            "fc00::1",
            "fe80::1",
            "64:ff9b::7f00:1",
            "2001::1",
            "2001:db8::1",
            "2002:7f00:1::",
            "3fff::1",
            "ff02::1",
        ):
            with self.subTest(address=address):
                self.assertFalse(proxy._is_public(ipaddress.ip_address(address)))
        for address in ("8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"):
            self.assertTrue(proxy._is_public(ipaddress.ip_address(address)))
        for url in ("file:///tmp/secret", "ftp://example.com/list", "data:text/plain,secret"):
            with self.assertRaises(proxy.ProxyError):
                proxy.fetch_text(url, "audit")

    def test_dns_mixed_answers_and_numeric_aliases_fail_closed(self):
        for host in ("provider.example", "2130706433", "0x7f000001", "127.1"):
            with (
                self.subTest(host=host),
                mock.patch.object(proxy.socket, "getaddrinfo", return_value=[answer("8.8.8.8"), answer("127.0.0.1")]),
                self.assertRaisesRegex(proxy.ProxyError, "not allowed"),
            ):
                proxy._resolve(proxy._http_url("http://" + host + "/list"), set())

    def test_lan_allowlist_is_empty_by_default_and_exact_by_origin(self):
        url = proxy._http_url("http://192.168.1.20:8080/list")
        with self.assertRaises(proxy.ProxyError):
            proxy._resolve(url, set())
        allowed = proxy._lan_origins("http://192.168.1.20:8080, https://[fd00::10]:8443")
        self.assertEqual(proxy._resolve(url, allowed), [answer("192.168.1.20", 8080)])
        for url in ("http://192.168.1.20:8081/list", "https://192.168.1.20:8080/list"):
            with self.assertRaises(proxy.ProxyError):
                proxy._resolve(proxy._http_url(url), allowed)
        with (
            mock.patch.object(proxy.socket, "getaddrinfo", return_value=[answer("192.168.1.20", 8080)]),
            self.assertRaises(proxy.ProxyError),
        ):
            proxy._resolve(proxy._http_url("http://provider.example:8080/list"), allowed)
        for origin in (
            "*",
            "http://127.0.0.1:8080",
            "http://169.254.169.254",
            "http://[::1]",
            "http://provider.example",
            "http://192.168.1.0/24",
            "http://user:secret@192.168.1.20",
            "http://192.168.1.20?allow=all",
        ):
            with self.subTest(origin=origin), self.assertRaises(proxy.ProxyError):
                proxy._lan_origins(origin)

    def test_numeric_socket_pinning_does_not_resolve_again_and_preserves_host(self):
        with fixture(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\n#EXTM3U") as (port, requests):
            parsed = proxy._http_url("http://pinning-fixture.invalid:" + str(port) + "/list?token=dummy")
            connection = proxy._PinnedConnection(parsed, [answer("127.0.0.1", port)], time.monotonic() + 3)
            try:
                with mock.patch.object(
                    proxy.socket, "getaddrinfo", side_effect=AssertionError("second DNS resolution")
                ):
                    connection.request("GET", "/list?token=dummy", headers={"User-Agent": "OTT-audit-UA"})
                    response = connection.getresponse()
                    self.assertEqual(response.read(), b"#EXTM3U")
            finally:
                connection.abort()
                connection.close()
        request = requests[0].lower()
        self.assertIn(("host: pinning-fixture.invalid:" + str(port)).encode(), request)
        self.assertIn(b"user-agent: ott-audit-ua", request)

    def test_redirect_private_and_file_targets_are_rechecked(self):
        original_resolve = proxy._resolve
        for destination in (
            "http://169.254.169.254/latest/meta-data",
            "http://127.0.0.1/",
            "http://[::ffff:127.0.0.1]/",
            "file:///tmp/secret",
        ):
            response = (
                "HTTP/1.1 302 Found\r\nLocation: " + destination + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ).encode()
            with self.subTest(destination=destination), fixture(response) as (port, _):

                def checked(parsed, origins):
                    if parsed.hostname == "redirect-fixture.invalid":
                        return [answer("127.0.0.1", port)]
                    return original_resolve(parsed, origins)

                with mock.patch.object(proxy, "_resolve", side_effect=checked), self.assertRaises(proxy.ProxyError):
                    proxy.fetch_text("http://redirect-fixture.invalid:" + str(port) + "/list", "audit")

    def test_public_redirect_success_and_hop_limit(self):
        # The injected checker approves only our dummy fixture; the production
        # redirect loop still resolves and validates each successive target.
        with fixture(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\n#EXTM3U") as (final_port, _):
            destination = "http://final-fixture.invalid:" + str(final_port) + "/list"
            redirect = (
                "HTTP/1.1 302 Found\r\nLocation: " + destination + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ).encode()
            with fixture(redirect) as (first_port, _):
                checked = []

                def resolve(parsed, origins):
                    checked.append(parsed.hostname)
                    port = first_port if parsed.hostname == "first-fixture.invalid" else final_port
                    return [answer("127.0.0.1", port)]

                with mock.patch.object(proxy, "_resolve", side_effect=resolve):
                    self.assertEqual(
                        proxy.fetch_text("http://first-fixture.invalid:" + str(first_port) + "/list", "audit"),
                        "#EXTM3U",
                    )
                self.assertEqual(checked, ["first-fixture.invalid", "final-fixture.invalid"])
        with (
            fixture(b"HTTP/1.1 302 Found\r\nLocation: /again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n") as (
                port,
                _,
            ),
            mock.patch.object(proxy, "MAX_REDIRECTS", 0),
            mock.patch.object(proxy, "_resolve", return_value=[answer("127.0.0.1", port)]),
            self.assertRaisesRegex(proxy.ProxyError, "Too many"),
        ):
            proxy.fetch_text("http://loop-fixture.invalid:" + str(port) + "/list", "audit")

    def test_archived_handler_bounds_request_before_reading(self):
        for length, expected in (("70000", 413), ("-1", 400), ("9" * 5000, 400)):
            handler = object.__new__(server.OTTPlayHandler)
            handler.headers = email.message.Message()
            handler.headers["Content-Length"] = length
            handler.rfile = mock.Mock()
            result = []
            handler._send_text = lambda body, status=200, result=result: result.append(status)
            handler._handle_cp_proxy()
            self.assertEqual(result, [expected])
            handler.rfile.read.assert_not_called()

    def test_redirect_basic_credentials_stay_on_exact_origin(self):
        for kind in ("relative", "absolute", "other"):
            with self.subTest(kind=kind), socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen(2)
                listener.settimeout(3)
                port = listener.getsockname()[1]
                location = (
                    "/final"
                    if kind == "relative"
                    else (
                        "http://"
                        + ("credentials-fixture.invalid" if kind == "absolute" else "other-fixture.invalid")
                        + ":"
                        + str(port)
                        + "/final"
                    )
                )
                replies = (
                    (
                        "HTTP/1.1 302 Found\r\nLocation: "
                        + location
                        + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    ).encode(),
                    b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\n#EXTM3U",
                )
                requests = []
                errors = []

                def serve_auth(listener=listener, replies=replies, requests=requests, errors=errors):
                    try:
                        for reply in replies:
                            connection, _ = listener.accept()
                            with connection:
                                connection.settimeout(3)
                                request = b""
                                while b"\r\n\r\n" not in request:
                                    request += connection.recv(4096)
                                requests.append(request.lower())
                                connection.sendall(reply)
                    except OSError as error:
                        errors.append(error)

                thread = threading.Thread(target=serve_auth, daemon=True)
                thread.start()
                try:
                    with mock.patch.object(proxy, "_resolve", return_value=[answer("127.0.0.1", port)]):
                        self.assertEqual(
                            proxy.fetch_text(
                                "http://dummy:secret@credentials-fixture.invalid:" + str(port) + "/start", "audit"
                            ),
                            "#EXTM3U",
                        )
                finally:
                    thread.join(4)
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
                self.assertIn(b"authorization: basic zhvtbxk6c2vjcmv0", requests[0])
                self.assertEqual(b"authorization: basic zhvtbxk6c2vjcmv0" in requests[1], kind != "other")
        current = proxy._http_url("https://user%40name:secret%2Fkey@provider.example/start")
        same = proxy._redirect_url(current, "https://provider.example/final")
        self.assertEqual(same.username, current.username)
        self.assertEqual(same.password, current.password)
        for target in (
            "http://provider.example/final",
            "https://provider.example:8443/final",
            "https://other.example/final",
        ):
            next_url = proxy._redirect_url(current, target)
            self.assertIsNone(next_url.username)
            self.assertIsNone(next_url.password)

    def test_success_and_declared_or_chunked_size_limits(self):
        cases = (
            (b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\n#EXTM3U", "#EXTM3U"),
            (b"HTTP/1.1 200 OK\r\nContent-Length: 17\r\nConnection: close\r\n\r\n01234567890123456", None),
            (
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n8\r\n01234567\r\n9\r\n890123456\r\n0\r\n\r\n",
                None,
            ),
        )
        for response, expected in cases:
            with (
                self.subTest(expected=expected),
                fixture(response) as (port, _),
                mock.patch.object(proxy, "_resolve", return_value=[answer("127.0.0.1", port)]),
                mock.patch.object(proxy, "MAX_BYTES", 16),
            ):
                if expected is None:
                    with self.assertRaisesRegex(proxy.ProxyError, "byte limit"):
                        proxy.fetch_text("http://size-fixture.invalid:" + str(port) + "/list", "audit")
                else:
                    self.assertEqual(
                        proxy.fetch_text("http://size-fixture.invalid:" + str(port) + "/list", "audit"), expected
                    )

    def test_overload_and_error_release_concurrency_slot(self):
        semaphore = threading.BoundedSemaphore(1)
        with mock.patch.object(proxy, "_REQUESTS", semaphore):
            semaphore.acquire()
            with self.assertRaisesRegex(proxy.ProxyError, "busy"):
                proxy.fetch_text("file:///tmp/secret", "audit")
            semaphore.release()
            with self.assertRaises(proxy.ProxyError):
                proxy.fetch_text("file:///tmp/secret", "audit")
            self.assertTrue(semaphore.acquire(blocking=False))
            semaphore.release()

    def test_archived_handler_never_reads_dummy_local_file(self):
        with tempfile.TemporaryDirectory(prefix="ott-proxy-security-") as directory:
            secret = Path(directory) / "dummy.txt"
            secret.write_text("AUDIT_DUMMY_SECRET")
            payload = urllib.parse.urlencode({"url": "@" + secret.as_uri()}).encode()
            handler = object.__new__(server.OTTPlayHandler)
            handler.headers = email.message.Message()
            handler.headers["Content-Length"] = str(len(payload))
            handler.rfile = io.BytesIO(payload)
            result = []
            handler._send_text = lambda body, status=200: result.append((status, body))
            handler._handle_cp_proxy()
            self.assertEqual(result[0][0], 502)
            self.assertNotIn("AUDIT_DUMMY_SECRET", result[0][1])
            self.assertNotIn(str(secret), result[0][1])


if __name__ == "__main__":
    unittest.main()
