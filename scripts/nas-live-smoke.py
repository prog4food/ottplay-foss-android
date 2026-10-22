#!/usr/bin/env python3
"""Verify a running NAS bridge without printing credentials or media titles.

Example: python3 scripts/nas-live-smoke.py --base-url http://127.0.0.1:8443
Reads OTTPLAY_NAS_KEY, --key-file, or the installed player's private plist.
Only bounded catalogue reads and short playback probes are performed.
"""

import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import plistlib
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request


class SmokeFailure(Exception):
    """A deliberately non-sensitive failure message."""


def require(condition, message):
    if not condition:
        raise SmokeFailure(message)


def emit(check, **values):
    print(json.dumps({"check": check, **values}, sort_keys=True), flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


class Smoke:
    def __init__(self, base, key, timeout, ca_file=None):
        self.base = base.rstrip("/")
        self.origin = urllib.parse.urlsplit(self.base)
        self.key = key
        self.timeout = timeout
        self.visited = set()
        self.browse_count = 0
        self.stop_urls = set()
        self.heartbeats_by_stop = {}
        context = ssl.create_default_context(cafile=ca_file)
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            NoRedirect(),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
            urllib.request.HTTPSHandler(context=context),
        )

    def url(self, value):
        resolved = urllib.parse.urljoin(self.base + "/", value)
        parsed = urllib.parse.urlsplit(resolved)
        require(
            (parsed.scheme, parsed.netloc) == (self.origin.scheme, self.origin.netloc)
            and parsed.path.startswith("/nas/")
            and not parsed.username and not parsed.password,
            "Bridge returned a media URL outside its NAS origin",
        )
        require("X-Plex-Token" not in resolved, "Plex credential leaked in a media URL")
        return resolved

    def request(self, path, payload=None, headers=None, limit=2 * 1024 * 1024):
        url = self.url(path)
        request_headers = dict(headers or {})
        body = None
        if payload is not None:
            body = json.dumps(payload).encode()
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=body, headers=request_headers)
        try:
            response = self.opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(limit)
            return response.status, response.headers, data

    def document(self, path, payload=None, headers=None):
        status, response_headers, data = self.request(path, payload, headers)
        require(status == 200, "JSON endpoint returned HTTP " + str(status))
        require(b"X-Plex-Token" not in data, "Plex credential marker leaked in JSON")
        try:
            parsed = json.loads(data)
        except (ValueError, UnicodeDecodeError):
            raise SmokeFailure("Endpoint did not return valid JSON") from None
        require(isinstance(parsed, dict), "JSON endpoint did not return an object")
        return parsed, response_headers

    def api(self, params=None, native=False):
        payload = {"limit": 10, **(params or {}), "app": "ott-play"}
        headers = {"Origin": self.base, "Sec-Fetch-Site": "same-origin"}
        if native:
            payload["key"] = self.key
            headers = {}
        data, _ = self.document("/nas/api", payload, headers)
        require(data.get("type") != "error", "Catalogue returned a protocol error")
        return data

    def discover(self):
        config, headers = self.document(
            "/nas/config", headers={"Origin": self.base, "Sec-Fetch-Site": "same-origin"}
        )
        require(config.get("enabled") is True, "NAS descriptor is disabled")
        require(config.get("api") == "/nas/api", "NAS descriptor has an unexpected API")
        require(bool(config.get("sourceId")), "NAS descriptor lacks a source identity")
        require(not any(k in config for k in ("key", "token", "plexToken", "plex_url")),
                "NAS descriptor contains private connection data")
        require("no-store" in headers.get("Cache-Control", ""), "Descriptor must not be cached")
        emit("descriptor", enabled=True, same_origin=True)

        status, _, _ = self.request("/nas/api", {"app": "ott-play"})
        require(status in (401, 403), "Native API accepts a missing key")
        status, _, _ = self.request(
            "/nas/api", {"app": "ott-play"},
            {"Origin": "https://untrusted.invalid", "Sec-Fetch-Site": "cross-site"},
        )
        require(status in (401, 403), "Catalogue accepts a foreign browser origin")
        native = self.api(native=True)
        root = self.api()
        require(isinstance(root.get("items"), list), "Root catalogue lacks items")
        require(len(native.get("items", [])) == len(root["items"]),
                "Native and same-origin catalogue counts differ")
        emit("authentication", native_key=True, keyless_rejected=True, cross_origin_rejected=True,
             root_items=len(root["items"]))
        return root

    def pagination(self, root):
        for kind, params in (
            ("root", {"limit": 2}),
            ("search", {"cmd": "search", "query": "the", "limit": 2}),
        ):
            first = self.api(params)
            first_items = [item for item in first.get("items", []) if item.get("type") != "next"]
            require(len(first_items) <= 2, "Catalogue exceeded the requested page size")
            next_item = next((item for item in first.get("items", []) if item.get("type") == "next"), None)
            if kind == "root" and len([item for item in root.get("items", []) if item.get("type") != "next"]) > 2:
                require(next_item is not None, "Root page hides known additional categories")
            if next_item is None:
                emit(kind + "_pagination", first_count=len(first_items), next_available=False)
                continue
            require(isinstance(next_item.get("request"), dict), "Next page lacks a request")
            second = self.api(next_item["request"])
            second_items = [item for item in second.get("items", []) if item.get("type") != "next"]
            require(0 < len(second_items) <= 2, "Advertised next page is empty or exceeds its limit")
            if kind == "root":
                require(all(item.get("type") == "category" for item in first_items + second_items),
                        "Root page contains a non-category record")
            first_ids = {item.get("id") for item in first_items}
            second_ids = {item.get("id") for item in second_items}
            require(None not in first_ids | second_ids, "Paged catalogue lacks stable item IDs")
            require(not first_ids & second_ids, "Consecutive catalogue pages contain duplicate IDs")
            emit(kind + "_pagination", first_count=len(first_items), second_count=len(second_items),
                 next_available=True, disjoint=True)

    def find_playback(self, node, max_browse):
        """Follow advertised VPortal requests, never guess media names or IDs."""
        if isinstance(node.get("url"), str) or isinstance(node.get("variants"), dict):
            return node
        for item in node.get("items", []):
            if not isinstance(item, dict) or item.get("type") == "next":
                continue
            if isinstance(item.get("url"), str):
                return item
            request = item.get("request")
            if not isinstance(request, dict):
                continue
            identity = json.dumps(request, sort_keys=True)
            if identity in self.visited:
                continue
            self.visited.add(identity)
            if self.browse_count >= max_browse:
                return None
            self.browse_count += 1
            result = self.find_playback(self.api(request), max_browse)
            if result:
                return result
        return None

    def original(self, url):
        parsed = urllib.parse.urlsplit(self.url(url))
        pieces = parsed.path.split("/")
        token_index = pieces.index("stream") + 1
        payload, signature = pieces[token_index].split(".", 1)
        pieces[token_index] = payload + "." + ("A" if signature[0] != "A" else "B") + signature[1:]
        tampered = urllib.parse.urlunsplit(parsed._replace(path="/".join(pieces)))
        status, _, _ = self.request(tampered, limit=1024)
        require(status in (401, 403), "Media endpoint accepts a tampered signed ticket")
        status, _, _ = self.request(url, headers={"Range": "bytes=0-1,4-5"}, limit=1024)
        require(status == 416, "Media endpoint accepts unsupported multiple ranges")
        status, headers, data = self.request(url, headers={"Range": "bytes=0-1023"}, limit=1024)
        require(status == 206, "Original media did not honor HTTP Range")
        require(bool(re.fullmatch(r"bytes 0-1023/\d+", headers.get("Content-Range", ""))),
                "Original media returned an unexpected Content-Range")
        require(len(data) == 1024, "Original media range length differs from 1024 bytes")
        emit("original_range", status=status, bytes=len(data), tampered_ticket_rejected=True,
             multiple_ranges_rejected=True,
             content_type=headers.get("Content-Type", "").split(";")[0])

    def hls(self, url):
        for depth in range(5):
            status, _, data = self.request(url)
            require(status == 200, "HLS endpoint returned HTTP " + str(status))
            require(data.startswith(b"#EXTM3U"), "HLS endpoint did not return a playlist")
            require(b"X-Plex-Token" not in data and b":32400" not in data,
                    "HLS playlist leaks upstream connection data")
            lines = data.decode("utf-8").splitlines()
            refs = [line.strip() for line in lines if line.strip() and not line.startswith("#")]
            require(bool(refs), "HLS playlist has no playable entries")
            emit("hls_playlist", depth=depth, status=status, references=len(refs))
            absolute = urllib.parse.urljoin(self.url(url), refs[0])
            self.url(absolute)
            if any(line.startswith("#EXTINF:") for line in lines):
                status, headers, chunk = self.request(absolute, limit=4096)
                require(status == 200 and len(chunk) >= 188, "HLS segment is absent or empty")
                emit("hls_segment", status=status, bytes=len(chunk),
                     content_type=headers.get("Content-Type", "").split(";")[0])
                return
            url = absolute
        raise SmokeFailure("HLS playlist recursion exceeded five levels")

    def playlist(self):
        status, _, data = self.request("/nas/playlist.m3u?" + urllib.parse.urlencode({"key": self.key, "limit": 10}))
        require(status == 200 and data.startswith(b"#EXTM3U"), "M3U export is unavailable")
        lines = data.decode("utf-8").splitlines()
        refs = [line.strip() for line in lines if line.strip() and not line.startswith("#")]
        require(bool(refs), "M3U export is empty")
        for reference in refs:
            self.url(reference)
        require(b"X-Plex-Token" not in data, "Plex credential leaked in M3U export")
        emit("m3u_export", status=status, entries=len(refs))
        status, _, data = self.request("/nas/playlist.m3u?" + urllib.parse.urlencode(
            {"key": self.key, "limit": 1, "mode": "original"}
        ))
        require(status == 200 and data.startswith(b"#EXTM3U"), "Original M3U export is unavailable")
        refs = [line.strip() for line in data.decode("utf-8").splitlines()
                if line.strip() and not line.startswith("#")]
        require(len(refs) == 1, "Bounded original M3U export did not contain one entry")
        status, headers, data = self.request(refs[0], headers={"Range": "bytes=0-1023"}, limit=1024)
        require(status == 206 and len(data) == 1024, "M3U original media does not support Range")
        emit("m3u_original", status=status, entries=1, bytes=len(data))

    def heartbeat(self, url, phase, expected):
        status, _, _ = self.request(url, limit=1024)
        require(status == expected, "HLS heartbeat " + phase + " returned HTTP " + str(status))
        emit("hls_heartbeat", phase=phase, status=status)

    def run(self, max_browse):
        root = self.discover()
        self.pagination(root)
        playable = self.find_playback(root, max_browse)
        require(playable is not None, "No playable item found within the bounded catalogue probe")
        for field in ("stop", "stop_url", "stopUrl"):
            if playable.get(field):
                self.stop_urls.add(self.url(playable[field]))
        variants = playable.get("variants", {})
        urls = list(dict.fromkeys(
            ([playable["url"]] if playable.get("url") else []) + list(variants.values())
        ))
        hls = next((url for label, url in variants.items() if "hls" in label.lower()), None)
        direct = next((url for label, url in variants.items()
                       if "original" in label.lower() or "оригинал" in label.lower()), None)
        if hls is None:
            hls = next((url for url in urls if ".m3u8" in urllib.parse.urlsplit(url).path), None)
        require(hls is not None, "Playback response lacks a browser HLS variant")
        require(direct is not None, "Playback response lacks an original media variant")
        sessions = playable.get("sessions", {})
        session = sessions.get(hls) if isinstance(sessions, dict) else None
        require(isinstance(session, dict), "HLS variant lacks its session controls")
        require(isinstance(session.get("stop"), str) and isinstance(session.get("heartbeat"), str),
                "HLS session controls are incomplete")
        stop = self.url(session["stop"])
        heartbeat = self.url(session["heartbeat"])
        self.stop_urls.add(stop)
        self.heartbeats_by_stop[stop] = heartbeat
        if playable.get("url") == hls:
            require(playable.get("stop") == stop and playable.get("heartbeat") == heartbeat,
                    "Default HLS session controls differ from its variant controls")
        emit("catalogue_play", browse_requests=self.browse_count, variants=len(urls))
        self.original(direct)
        self.heartbeat(heartbeat, "before_start", 404)
        self.hls(hls)
        self.heartbeat(heartbeat, "active", 200)
        self.playlist()

    def close(self):
        for url in self.stop_urls:
            status, _, _ = self.request(url)
            require(status in (200, 204), "HLS session stop returned HTTP " + str(status))
            emit("hls_stop", status=status)
            if url in self.heartbeats_by_stop:
                self.heartbeat(self.heartbeats_by_stop[url], "after_stop", 404)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8443")
    parser.add_argument("--key-file", type=Path)
    parser.add_argument("--plist", type=Path, default=Path.home() / "Library/LaunchAgents/com.ottplay-foss-local.plist")
    parser.add_argument("--ca-file", help="Additional trusted CA PEM for a local HTTPS installation")
    parser.add_argument("--timeout", type=float, default=45)
    parser.add_argument("--max-browse", type=int, default=20)
    args = parser.parse_args()
    parsed = urllib.parse.urlsplit(args.base_url)
    require(parsed.scheme in ("http", "https") and bool(parsed.hostname)
            and parsed.path in ("", "/") and not parsed.query and not parsed.fragment
            and not parsed.username and not parsed.password,
            "Base URL must be an HTTP(S) origin without credentials")
    require(1 <= args.max_browse <= 100 and 1 <= args.timeout <= 120,
            "Probe bounds must be within supported limits")
    key = os.environ.get("OTTPLAY_NAS_KEY", "")
    if args.key_file:
        key = args.key_file.read_text().strip()
    elif not key and args.plist.is_file():
        key = plistlib.loads(args.plist.read_bytes()).get("EnvironmentVariables", {}).get("OTTPLAY_NAS_KEY", "")
    require(bool(key), "Supply a private NAS key through environment, file, or installed plist")
    smoke = Smoke(args.base_url, key, args.timeout, args.ca_file)
    try:
        smoke.run(args.max_browse)
    except Exception:
        try:
            smoke.close()
        except Exception as error:
            emit("hls_cleanup", passed=False, error_type=type(error).__name__)
        raise
    else:
        smoke.close()
    emit("result", passed=True)


if __name__ == "__main__":
    try:
        main()
    except SmokeFailure as error:
        emit("result", passed=False, reason=str(error))
        sys.exit(1)
    except Exception as error:
        # Network exception strings may contain a signed URL; never display them.
        emit("result", passed=False, error_type=type(error).__name__)
        sys.exit(1)
