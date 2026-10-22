"""Bounded playlist HTTP proxy with checked, pinned destination addresses.

No environment proxy, file handler, implicit redirect or second DNS resolution
is used. Configuration is shared with the Rust Mode A proxy; see proxy-security.md.
"""

import base64
import http.client
import ipaddress
import os
import socket
import ssl
import threading
import time
import urllib.parse

MAX_BYTES = 16 * 1024 * 1024
MAX_REDIRECTS = 5
TIMEOUT = 15
_REQUESTS = threading.BoundedSemaphore(8)
_V4_DENY = tuple(
    ipaddress.ip_network(value)
    for value in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
    )
)
_LAN = tuple(
    ipaddress.ip_network(value)
    for value in (
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "fc00::/7",
    )
)
_V6_GLOBAL = ipaddress.ip_network("2000::/3")
_V6_DENY = tuple(
    ipaddress.ip_network(value)
    for value in (
        "2001::/23",
        "2001:db8::/32",
        "2002::/16",
        "3fff::/20",
    )
)


class ProxyError(Exception):
    """Public-safe failure: never include a provider URL or its credentials."""


def _http_url(raw):
    try:
        if any(ord(char) <= 32 or ord(char) == 127 for char in raw):
            raise ValueError("control character")
        parsed = urllib.parse.urlsplit(raw)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or "%" in parsed.hostname:
            raise ValueError("scheme or host")
        # Accessing port also rejects malformed/out-of-range authorities.
        if parsed.port == 0:
            raise ValueError("port")
        parsed.hostname.encode("idna")
        return parsed
    except (ValueError, UnicodeError):
        raise ProxyError("Only valid HTTP(S) proxy URLs are supported") from None


def _redirect_url(current, location):
    next_url = _http_url(urllib.parse.urljoin(current.geturl(), location))
    if _origin(next_url) == _origin(current) and next_url.username is None and current.username is not None:
        # An absolute same-origin Location omits URL userinfo. Keep its exact
        # encoded form, but never inherit it at another origin or on downgrade.
        userinfo = current.netloc.rsplit("@", 1)[0]
        next_url = next_url._replace(netloc=userinfo + "@" + next_url.netloc)
    return next_url


def _literal(host):
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def _is_lan(ip):
    return any(ip.version == network.version and ip in network for network in _LAN)


def _is_public(ip):
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return _is_public(ip.ipv4_mapped)
        return ip in _V6_GLOBAL and not any(ip in network for network in _V6_DENY)
    return not any(ip in network for network in _V4_DENY)


def _origin(parsed):
    host = parsed.hostname.lower()
    ip = _literal(host)
    return (parsed.scheme, str(ip) if ip else host, parsed.port or (443 if parsed.scheme == "https" else 80))


def _lan_origins(raw):
    origins = set()
    for entry in filter(None, (entry.strip() for entry in raw.split(","))):
        try:
            parsed = _http_url(entry)
            ip = _literal(parsed.hostname)
            if (
                ip is None
                or not _is_lan(ip)
                or parsed.username is not None
                or parsed.password is not None
                or parsed.path not in ("", "/")
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError("not an exact LAN origin")
            origins.add(_origin(parsed))
        except (ValueError, ProxyError):
            raise ProxyError(
                "OTTPLAY_PROXY_LAN_ORIGINS requires exact HTTP(S) origins with literal RFC1918/ULA addresses"
            ) from None
    return origins


def _resolve(parsed, lan_origins):
    host = parsed.hostname.encode("idna").decode("ascii")
    port = _origin(parsed)[2]
    ip = _literal(host)
    if ip is not None:
        family = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
        sockaddr = (str(ip), port, 0, 0) if ip.version == 6 else (str(ip), port)
        answers = [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)]
    else:
        try:
            answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
        except OSError:
            raise ProxyError("Proxy DNS lookup failed") from None
    allowed_lan = _origin(parsed) in lan_origins
    if not answers or len(answers) > 32:
        raise ProxyError("Proxy destination is not allowed")
    for family, _, _, _, address in answers:
        ip = _literal(address[0])
        if (
            family not in (socket.AF_INET, socket.AF_INET6)
            or ip is None
            or not (_is_public(ip) or (allowed_lan and _is_lan(ip)))
        ):
            raise ProxyError("Proxy destination is not allowed")
    return answers


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProxyError("Proxy request timed out")
    return remaining


class _PinnedConnection(http.client.HTTPConnection):
    def __init__(self, parsed, addresses, deadline):
        self.parsed = parsed
        self.addresses = addresses
        self.deadline = deadline
        self.transport = None
        super().__init__(
            parsed.hostname.encode("idna").decode("ascii"), _origin(parsed)[2], timeout=_remaining(deadline)
        )

    def connect(self):
        for family, kind, protocol, _, sockaddr in self.addresses:
            transport = socket.socket(family, kind, protocol)
            self.transport = transport
            try:
                transport.settimeout(_remaining(self.deadline))
                # sockaddr is numeric and previously checked: no DNS call here.
                transport.connect(sockaddr)
                if self.parsed.scheme == "https":
                    transport.settimeout(_remaining(self.deadline))
                    context = ssl.create_default_context()
                    # Keep the TLS floor explicit for security analysis without lowering a stricter policy.
                    if context.minimum_version < ssl.TLSVersion.TLSv1_2:  # noqa: PLR1730
                        context.minimum_version = ssl.TLSVersion.TLSv1_2
                    transport = context.wrap_socket(transport, server_hostname=self.host)
                    self.transport = transport
                self.sock = transport
                return
            except OSError:
                transport.close()
        raise ProxyError("Proxy upstream connection failed")

    def abort(self):
        transport = self.transport
        if transport is not None:
            try:
                transport.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            transport.close()


def fetch_text(raw, user_agent):
    if not _REQUESTS.acquire(blocking=False):
        raise ProxyError("Proxy is busy; retry later")
    try:
        parsed = _http_url(raw)
        origins = _lan_origins(os.environ.get("OTTPLAY_PROXY_LAN_ORIGINS", ""))
        deadline = time.monotonic() + TIMEOUT
        for hop in range(MAX_REDIRECTS + 1):
            addresses = _resolve(parsed, origins)
            connection = _PinnedConnection(parsed, addresses, deadline)
            watchdog = threading.Timer(_remaining(deadline), connection.abort)
            watchdog.daemon = True
            watchdog.start()
            try:
                path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
                headers = {"User-Agent": user_agent}
                if parsed.username is not None:
                    credential = (
                        urllib.parse.unquote(parsed.username) + ":" + urllib.parse.unquote(parsed.password or "")
                    )
                    headers["Authorization"] = "Basic " + base64.b64encode(credential.encode()).decode("ascii")
                connection.request("GET", path, headers=headers)
                response = connection.getresponse()
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader("Location")
                    if hop == MAX_REDIRECTS:
                        raise ProxyError("Too many proxy redirects")
                    if not location:
                        raise ProxyError("Invalid proxy redirect")
                    parsed = _redirect_url(parsed, location)
                    continue
                if not 200 <= response.status < 300:
                    raise ProxyError("Upstream HTTP " + str(response.status))
                declared = response.getheader("Content-Length")
                if declared is not None and (
                    not declared.isascii() or not declared.isdigit() or int(declared) > MAX_BYTES
                ):
                    raise ProxyError("Proxy response exceeds byte limit")
                body = bytearray()
                while not response.isclosed():
                    connection.transport.settimeout(_remaining(deadline))
                    chunk = response.read1(min(65536, MAX_BYTES + 1 - len(body)))
                    if not chunk:
                        break
                    body.extend(chunk)
                    if len(body) > MAX_BYTES:
                        raise ProxyError("Proxy response exceeds byte limit")
                return body.decode("utf-8")
            finally:
                watchdog.cancel()
                connection.abort()
                connection.close()
        raise ProxyError("Too many proxy redirects")
    except ProxyError:
        raise
    except (OSError, ValueError, UnicodeError, http.client.HTTPException):
        raise ProxyError("Proxy upstream request failed") from None
    finally:
        _REQUESTS.release()
