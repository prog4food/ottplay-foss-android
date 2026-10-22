#!/usr/bin/env python3
"""OTT-play FOSS local server: static files + EPG/logo/mock endpoints"""

import http.server
import socketserver
import os
import sys
import json
import urllib.parse
import urllib.request

if __package__:
    from .proxy_security import fetch_text as fetch_proxy_text, ProxyError
else:
    from proxy_security import fetch_text as fetch_proxy_text, ProxyError
import time
import random
import hashlib
import re
import gzip
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
HOST = ""  # '' = all interfaces (docker); pass --host 127.0.0.1 for loopback-only
EPG_URLS = []
VERBOSE = False
NO_EPG = False
# --https-port may be repeated; each value adds an HTTPS listener on one process.
HTTPS_PORTS = []  # extra HTTPS listeners, enabled when --cert/--key given
CERT_FILE = None
KEY_FILE = None
for i, arg in enumerate(sys.argv):
    if arg == "--epg-url" and i + 1 < len(sys.argv):
        EPG_URLS.append(sys.argv[i + 1])
    if arg == "--no-epg":
        NO_EPG = True
    if arg == "--verbose" or arg == "-v":
        VERBOSE = True
    if arg == "--https-port" and i + 1 < len(sys.argv):
        HTTPS_PORTS.append(int(sys.argv[i + 1]))
    if arg == "--host" and i + 1 < len(sys.argv):
        HOST = sys.argv[i + 1]
    if arg == "--cert" and i + 1 < len(sys.argv):
        CERT_FILE = sys.argv[i + 1]
    if arg == "--key" and i + 1 < len(sys.argv):
        KEY_FILE = sys.argv[i + 1]
# Backward-compat: HTTPS_PORT holds the first value (or None).
HTTPS_PORT = HTTPS_PORTS[0] if HTTPS_PORTS else None

if not EPG_URLS and not NO_EPG:
    EPG_URLS.append("http://epg.it999.ru/epg2.xml.gz")

# --- Logo generation ---
LOGO_COLORS = [
    "#e74c3c",
    "#3498db",
    "#2ecc71",
    "#f39c12",
    "#9b59b6",
    "#1abc9c",
    "#e67e22",
    "#34495e",
    "#16a085",
    "#c0392b",
    "#2980b9",
    "#27ae60",
    "#d35400",
    "#8e44ad",
    "#f1c40f",
]


def generate_logo_svg(channel_id, channel_name=""):
    if not channel_id:
        channel_id = "0"
    rng = random.Random(str(channel_id))
    color = LOGO_COLORS[rng.randint(0, len(LOGO_COLORS) - 1)]
    if channel_name and channel_name.strip():
        letter = channel_name.strip()[0].upper()
    else:
        letter = chr(ord("A") + rng.randint(0, 25))
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90">'
        f'<rect width="120" height="90" rx="8" fill="{color}"/>'
        f'<text x="60" y="58" text-anchor="middle" font-family="Arial,sans-serif" '
        f'font-size="36" font-weight="bold" fill="white">{letter}</text>'
        f"</svg>"
    )
    return svg


# --- Real EPG: XMLTV parser ---
# Usage: python3 server.py 8080 --epg-url http://example.com/epg.xml


def parse_xmltv_time(ts):
    """Parse XMLTV timestamp (YYYYMMDDHHMMSS ±HHMM) to Unix timestamp."""
    if not ts:
        return 0
    ts = ts.strip()
    # Format: YYYYMMDDHHMMSS ±HHMM
    if len(ts) >= 14:
        try:
            base = ts[:14]
            dt = datetime.strptime(base, "%Y%m%d%H%M%S")
            if len(ts) > 14:
                tz_str = ts[15:].strip() if ts[14] == " " else ts[14:].strip()
                if tz_str and len(tz_str) >= 5 and tz_str[0] in "+-":
                    sign = 1 if tz_str[0] == "+" else -1
                    th = int(tz_str[1:3])
                    tm = int(tz_str[3:5])
                    offset = sign * (th * 3600 + tm * 60)
                    dt = dt - timedelta(seconds=offset)
            return int(dt.replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            pass
    return 0


def fetch_xmltv(sources):
    """Fetch XMLTV from one or more URLs or file paths. Handles .gz. Merges all data.

    Caches each source separately to disk so restarts are instant.
    Returns (combined_channels_dict, combined_programs_dict).
    """
    all_channels = {}
    all_programs = {}

    for source in sources if isinstance(sources, list) else [sources]:
        channels, programs = _fetch_single_xmltv(source)
        # Merge channels — first source wins for channel info, but merge programs
        for ch_id, ch_info in channels.items():
            if ch_id not in all_channels:
                all_channels[ch_id] = ch_info
        for ch_id, progs in programs.items():
            if ch_id not in all_programs:
                all_programs[ch_id] = []
            # Deduplicate by (start, title) to avoid duplicates across sources
            existing = {(p["start"], p["title"]) for p in all_programs[ch_id]}
            for p in progs:
                key = (p["start"], p["title"])
                if key not in existing:
                    existing.add(key)
                    all_programs[ch_id].append(p)

    total_pr = sum(len(v) for v in all_programs.values())
    sys.stderr.write(
        f"[XMLTV] Total: {len(all_channels)} channels, {total_pr} programmes from {len(sources if isinstance(sources, list) else [sources])} source(s)\n"
    )
    return all_channels, all_programs


def _fetch_single_xmltv(source):
    """Fetch a single XMLTV source. Returns (channels_dict, programs_dict)."""
    channels = {}
    programs = {}
    content = None
    is_gz = source.endswith(".gz")

    cache_dir = ".cache"
    cache_key = hashlib.md5(source.encode()).hexdigest()[:16]
    cache_meta = os.path.join(cache_dir, f"epg_{cache_key}.meta")
    cache_data = os.path.join(cache_dir, f"epg_{cache_key}.json")
    if os.path.isfile(cache_meta) and os.path.isfile(cache_data):
        try:
            with open(cache_meta, "r") as f:
                meta = json.load(f)
            if meta.get("source") == source and time.time() - meta.get("ts", 0) < 7200:
                with open(cache_data, "r", encoding="utf-8") as f:
                    cached = json.load(f)
                ch = cached.get("channels", {})
                pr = cached.get("programs", {})
                total_pr = sum(len(v) for v in pr.values())
                sys.stderr.write(
                    f"[XMLTV] Loaded {len(ch)} channels, {total_pr} programmes from cache ({source[:60]})\n"
                )
                return ch, pr
        except Exception:
            pass

    if source.startswith(("http://", "https://")):
        sys.stderr.write(f"[XMLTV] Fetching {source[:80]}...\n")
        try:
            req = urllib.request.Request(
                source,
                headers={
                    "User-Agent": "OTT-play-FOSS/1.0",
                    "Accept-Encoding": "gzip",
                },
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                content = resp.read()
            sys.stderr.write(f"[XMLTV] Downloaded {len(content)} bytes\n")
        except Exception as e:
            sys.stderr.write(f"[XMLTV] Failed to fetch {source[:80]}: {e}\n")
            return channels, programs
    else:
        try:
            with open(source, "rb") as f:
                content = f.read()
        except Exception as e:
            sys.stderr.write(f"[XMLTV] Failed to read {source}: {e}\n")
            return channels, programs

    if is_gz or (content and content[:2] == b"\x1f\x8b"):
        try:
            content = gzip.decompress(content)
            sys.stderr.write(f"[XMLTV] Decompressed to {len(content)} bytes\n")
        except Exception as e:
            sys.stderr.write(f"[XMLTV] Gunzip error: {e}\n")
            return channels, programs

    try:
        root = ET.fromstring(content)
    except Exception as e:
        sys.stderr.write(f"[XMLTV] Parse error: {e}\n")
        return channels, programs

    for ch in root.findall("channel"):
        ch_id = ch.get("id", "")
        dn_el = ch.find("display-name")
        dn = dn_el.text if dn_el is not None and dn_el.text else ch_id
        icon_el = ch.find("icon")
        icon = icon_el.get("src", "") if icon_el is not None else ""
        channels[ch_id] = {"name": dn, "icon": icon}
        programs[ch_id] = []

    for prog in root.findall("programme"):
        ch_id = prog.get("channel", "")
        if ch_id not in programs:
            programs[ch_id] = []
        start = parse_xmltv_time(prog.get("start", ""))
        stop = parse_xmltv_time(prog.get("stop", ""))
        title_el = prog.find("title")
        desc_el = prog.find("desc")
        icon_el = prog.find("icon")
        programs[ch_id].append(
            {
                "start": start,
                "stop": stop,
                "title": title_el.text if title_el is not None and title_el.text else "",
                "desc": desc_el.text if desc_el is not None and desc_el.text else "",
                "icon": icon_el.get("src", "") if icon_el is not None else "",
            }
        )

    total_pr = sum(len(v) for v in programs.values())
    sys.stderr.write(f"[XMLTV] Loaded {len(channels)} channels, {total_pr} programmes\n")

    try:
        os.makedirs(cache_dir, exist_ok=True)
        with open(cache_data, "w", encoding="utf-8") as f:
            json.dump({"channels": channels, "programs": programs}, f, ensure_ascii=False)
        with open(cache_meta, "w") as f:
            json.dump({"source": source, "ts": time.time()}, f)
        sys.stderr.write(f"[XMLTV] Cached to {cache_data}\n")
    except Exception as e:
        sys.stderr.write(f"[XMLTV] Cache write error: {e}\n")

    return channels, programs


def _remove_parentheticals(name):
    """Remove complete parentheticals without rescanning an unmatched tail."""
    parts = []
    start = 0
    while True:
        opening = name.find("(", start)
        if opening == -1:
            break
        closing = name.find(")", opening + 1)
        if closing == -1:
            break
        parts.append(name[start:opening])
        start = closing + 1
    parts.append(name[start:])
    return "".join(parts)


def normalize_name(name):
    """Normalize channel name for fuzzy matching."""
    name = name.lower().strip()
    # Remove time shift patterns: +N, -N, +Nч, +Nh, +N hours
    name = re.sub(r"[+-]\s*\d+\s*(ч|h|hours?)?", "", name)
    # Remove parentheticals like (Алания)
    name = _remove_parentheticals(name)
    # Remove extra whitespace
    name = re.sub(r"\s+", " ", name).strip()
    # Remove common prefixes/suffixes
    name = re.sub(r"^(hd|fhd|uhd|4k)\s+", "", name)
    name = re.sub(r"\s+(hd|fhd|uhd|4k)$", "", name)
    return name


def extract_time_shift(name):
    """Extract time shift in hours from channel name like '+4', '-2ч', '+3h'."""
    match = re.search(r"([+-])\s*(\d+)\s*(ч|h|hours?)?", name)
    if match:
        sign = 1 if match.group(1) == "+" else -1
        hours = int(match.group(2))
        if hours > 24:
            hours = hours % 24
        return sign * hours
    return 0


def compute_epg_hash(identifier):
    """Deterministic hash for EPG URL from XMLTV channel ID."""
    return hashlib.md5(identifier.encode()).hexdigest()[:16]


def match_channel_to_xmltv(playlist_name, xmltv_channels):
    """Fuzzy match a playlist channel name to XMLTV channels.
    Returns (xmltv_channel_id, channel_name, score) or (None, None, 0)."""
    normalized = normalize_name(playlist_name)
    if not normalized:
        return None, None, 0

    # Use pre-normalized index when available
    index = globals().get("xmltv_index", [])
    if not index:
        index = build_xmltv_index(xmltv_channels)

    best_id = None
    best_name = None
    best_score = 0.0

    for ch_id, ch_name, xmltv_norm in index:
        # Exact match
        if normalized == xmltv_norm:
            return ch_id, ch_name, 1.0

        # One is substring of the other
        if normalized in xmltv_norm:
            score = len(normalized) / len(xmltv_norm)
        elif xmltv_norm in normalized:
            score = len(xmltv_norm) / len(normalized)
        else:
            # Word overlap
            n_words = set(normalized.split())
            x_words = set(xmltv_norm.split())
            common = n_words & x_words
            if common:
                min_words = min(len(n_words), len(x_words))
                if len(common) >= max(2, min_words * 0.5):
                    score = len(common) / max(len(n_words), len(x_words))
                else:
                    continue
            else:
                continue

        if score > best_score:
            best_score = score
            best_id = ch_id
            best_name = ch_name

    if best_score >= 0.4:
        return best_id, best_name, best_score
    return None, None, 0


# Pre-normalize XMLTV channels for faster matching
def build_xmltv_index(xmltv_channels):
    """Build a pre-normalized index of XMLTV channels for faster fuzzy matching."""
    index = []
    for ch_id, ch_info in xmltv_channels.items():
        norm = normalize_name(ch_info["name"])
        if norm:
            index.append((ch_id, ch_info["name"], norm))
    return index


# Global XMLTV data
xmltv_channels = {}
xmltv_programs = {}
xmltv_index = []  # pre-normalized channel index for fast matching
epg_to_xmltv = {}  # epg_hash -> xmltv_channel_id
time_shift_by_epg = {}  # epg_hash -> hours

if EPG_URLS:
    xmltv_channels, xmltv_programs = fetch_xmltv(EPG_URLS)
    xmltv_index = build_xmltv_index(xmltv_channels)


# --- In-memory store: EPG URL -> channel info ---
ch_names_by_epgurl = {}


class OTTPlayHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "86400")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path in (
            "/api/webhook/commands",
            "/api/webhook/health",
            "/webhook/poll",
            "/webhook/notify",
            "/webhook/health",
        ):
            self.send_error(403, "HTTP remote disabled. Configure the authenticated local_proxy.py separately.")
        elif path == "/m3u/match-channels":
            self._handle_match_channels()
        elif path == "/m3u/match-logos":
            self._handle_match_logos()
        elif path == "/m3u/cp.php":
            self._handle_cp_proxy()
        elif path == "/report_feedb":
            self._serve_feedback_post()
        elif path.startswith("/feedback/") or path.startswith("/api/"):
            self._serve_feedback_post()
        else:
            self.send_error(404, "Not Found")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        if path in (
            "/api/webhook/commands",
            "/api/webhook/health",
            "/webhook/poll",
            "/webhook/notify",
            "/webhook/health",
        ):
            self.send_error(403, "HTTP remote disabled. Configure the authenticated local_proxy.py separately.")
            return
        if path.startswith("/epg/"):
            params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            ch_name = (params.get("ch") or [None])[0]
            hours_raw = (params.get("hours") or [None])[0]
            try:
                archive_hours = int(hours_raw) if hours_raw is not None else 0
            except (TypeError, ValueError):
                archive_hours = 0
            self._serve_epg(path, ch_name, archive_hours)
            return
        if path.startswith("/logo/"):
            self._serve_logo(path, parsed.query)
            return
        if path.startswith("/version/"):
            self._serve_version(path)
            return
        if path.startswith("/tmdb/"):
            self._serve_tmdb_proxy(path, parsed.query)
            return
        if path.startswith("/feedback/") or path.startswith("/api/"):
            self._serve_feedback_get()
            return
        if path.startswith("/f/"):
            self._serve_index()
            return
        if path != "/" and os.path.isdir(self.translate_path(path)) and parsed.path.endswith("/"):
            self.send_error(404, "Not Found")
            return
        return super().do_GET()

    def _read_body(self):
        clen = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(clen).decode("utf-8") if clen else ""

    def _send_text(self, text, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(text.encode("utf-8"))

    def _send_json(self, obj, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _handle_match_channels(self):
        body = self._read_body()
        parts = body.split("\n\t\n")
        id_section = parts[2] if len(parts) > 2 else ""
        id_lines = [l.strip() for l in id_section.split("\n") if l.strip()]

        ch_mappings = []
        src_map = {"local": "/"}
        ch_list = []  # (ch_name, status) for console output

        for line in id_lines:
            # Extract channel name from last ~ segment
            if "~" in line:
                last_tilde = line.rindex("~")
                ch_name = urllib.parse.unquote(line[last_tilde + 1 :])
                hash_part = line[:last_tilde]
            else:
                hash_part = line
                ch_name = ""

            fields = hash_part.split("-")
            if len(fields) < 4:
                continue
            ch_id = fields[0]

            # Try matching to XMLTV if data is available
            if xmltv_channels and ch_name:
                time_shift = extract_time_shift(ch_name)
                base_name = re.sub(r"[+-]\s*\d+\s*(ч|h|hours?)?", "", ch_name).strip()
                matched_id, matched_name, score = match_channel_to_xmltv(base_name, xmltv_channels)
                if matched_id:
                    epg_hash = compute_epg_hash(f"{matched_id}|{time_shift}")
                    epg_to_xmltv[epg_hash] = matched_id
                    if time_shift != 0:
                        time_shift_by_epg[epg_hash] = time_shift
                    ch_mappings.append(f"{ch_id}~local~{epg_hash}")
                    ch_list.append((ch_name, f"XMLTV: {matched_name}", score))
                    continue

            # Fallback: no EPG match
            name_hash = fields[3]
            epg_url = name_hash if name_hash and name_hash != "0" else ch_id
            ch_names_by_epgurl[epg_url] = ch_id
            ch_mappings.append(f"{ch_id}~local~{epg_url}")
            ch_list.append((ch_name, "NO EPG", 0))

        epg_src_lines = [f"{k}~{v}" for k, v in src_map.items()]
        response = "{}\n\t\n" + "\n".join(ch_mappings) + "\n\t\n" + "\n".join(epg_src_lines)
        self._send_text(response)
        xmltv_hits = sum(1 for m in ch_mappings if "~local~" in m and m.split("~local~")[1] in epg_to_xmltv)
        sys.stderr.write(f"[EPG] match-channels: {len(ch_mappings)} channels ({xmltv_hits} from XMLTV)\n")
        if VERBOSE and ch_list:
            sys.stderr.write(f"[EPG] Channel list:\n")
            for name, status, score in sorted(ch_list, key=lambda x: (0 if x[1] != "NO EPG" else 1, x[0].lower())):
                sys.stderr.write(f"  {status:25s} {name}\n")

    def _handle_match_logos(self):
        body = self._read_body()
        parts = body.split("\n\t\n")
        id_section = parts[2] if len(parts) > 2 else ""
        id_lines = [l.strip() for l in id_section.split("\n") if l.strip()]

        log_mappings = []
        for line in id_lines:
            if "~" in line:
                last_tilde = line.rindex("~")
                extra = line[last_tilde + 1 :]
                hash_part = line[:last_tilde]
            else:
                hash_part = line
                extra = ""
            fields = hash_part.split("-")
            if len(fields) < 4:
                continue
            ch_id = fields[0]
            ch_name = urllib.parse.unquote(extra)

            # Try to find a real logo from XMLTV
            logo_url = None
            if xmltv_channels and ch_name:
                base_name = re.sub(r"[+-]\s*\d+\s*(ч|h|hours?)?", "", ch_name).strip()
                matched_id, matched_name, score = match_channel_to_xmltv(base_name, xmltv_channels)
                if matched_id and matched_name:
                    ch_info = xmltv_channels.get(matched_id, {})
                    if ch_info.get("icon"):
                        logo_url = ch_info["icon"]

            if logo_url:
                log_mappings.append(f"{ch_id}~{logo_url}")
            else:
                log_mappings.append(f"{ch_id}~/logo/{ch_id}.svg?ch={urllib.parse.quote(ch_name)}")

        response = "{}\n\t\n" + "\n".join(log_mappings)
        self._send_text(response)
        real_logos = sum(1 for m in log_mappings if "~http" in m or "~//" in m)
        sys.stderr.write(f"[EPG] match-logos: {len(log_mappings)} channels ({real_logos} real logos)\n")

    def _serve_index(self):
        with open("index.html", "r") as f:
            html = f.read()
        self._send_html(html)
        sys.stderr.write(f"[INDEX] serve index.html\n")

    def _send_html(self, html, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html.encode("utf-8"))

    def _serve_epg(self, path, ch_name=None, archive_hours=0):
        epg_hash = os.path.splitext(os.path.basename(path))[0]

        # Serve from XMLTV if available
        if xmltv_programs and epg_hash in epg_to_xmltv:
            xmltv_id = epg_to_xmltv[epg_hash]
            progs = xmltv_programs.get(xmltv_id, [])
            time_shift = time_shift_by_epg.get(epg_hash, 0)
            now = int(time.time())
            # archive_hours = configured catchup/history (M3U rechours); timezone is time_shift.
            lookback_h = archive_hours if archive_hours and archive_hours > 0 else 48
            cutoff_start = now - lookback_h * 3600
            cutoff_end = now + 48 * 3600

            epg_data = []
            for p in progs:
                start = p["start"] + time_shift * 3600
                stop = p["stop"] + time_shift * 3600
                # Include programs that overlap with our time window
                if stop > cutoff_start and start < cutoff_end:
                    epg_data.append(
                        {
                            "time": start,
                            "time_to": stop,
                            "name": p["title"],
                            "descr": p.get("desc", ""),
                            "icon": p.get("icon", ""),
                        }
                    )

            epg_data.sort(key=lambda p: p["time"])
            sys.stderr.write(
                f"[EPG] serve XMLTV /epg/{epg_hash}.json ch={xmltv_id} ({len(epg_data)} progs, shift={time_shift}h)\n"
            )
            self._send_json({"epg_data": epg_data})
            return

        # Fallback: no EPG available
        self._send_json({"epg_data": []})
        sys.stderr.write(f"[EPG] serve no-epg /epg/{epg_hash}.json ch={ch_name}\n")

    def _serve_logo(self, path, query_string=""):
        logo_id = os.path.splitext(os.path.basename(path))[0]
        ch_name = ""
        if query_string:
            params = urllib.parse.parse_qs(query_string, keep_blank_values=True)
            ch_name = (params.get("ch") or [""])[0]
        svg = generate_logo_svg(logo_id, ch_name)
        self.send_response(200)
        self.send_header("Content-Type", "image/svg+xml")
        self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        self.wfile.write(svg.encode("utf-8"))

    def _serve_version(self, path):
        rel = path.replace("/version/", "/", 1)
        filename = os.path.basename(rel)
        filepath = self.translate_path(rel)
        if os.path.isfile(filepath):
            stat = os.stat(filepath)
            with open(filepath, "rb") as f:
                h = hashlib.md5(f.read()).hexdigest()[:16]
            self._send_json(
                {
                    "file": filename,
                    "hash": h,
                    "modified": int(stat.st_mtime),
                    "size": stat.st_size,
                }
            )
        else:
            self._send_json({"error": "not found"}, 404)

    def _serve_tmdb_proxy(self, path, query_string):
        if path.startswith("/tmdb/s/"):
            target = "https://api.themoviedb.org/3/" + path[len("/tmdb/s/") :]
        elif path.startswith("/tmdb/i/"):
            target = "https://image.tmdb.org/t/p/w500/" + path[len("/tmdb/i/") :]
        else:
            self._send_json({"error": "invalid tmdb path"}, 400)
            return
        if query_string:
            target += "?" + query_string
        try:
            req = urllib.request.Request(
                target,
                headers={
                    "User-Agent": "OTT-play-FOSS/1.0",
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
            ct = resp.headers.get("Content-Type", "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            sys.stderr.write(f"[TMDB] OK {target[:100]}\n")
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(e.read())
            sys.stderr.write(f"[TMDB] HTTP {e.code} {target[:100]}\n")
        except Exception as e:
            self._send_json({"error": str(e)}, 502)
            sys.stderr.write(f"[TMDB] FAIL {target[:100]}: {e}\n")

    UA_PRESETS = {
        "webos": "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36 LG Browser/9.00.00",
        "tizen": "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) SamsungTV/3.0 Chrome/76.0.3809.146 Safari/537.36",
        "viera": "Mozilla/5.0 (Unknown; Linux; Viera/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36",
        "mag": "Mozilla/5.0 (STB; Infomir MAG524) Maple 6.0 QtWebKit/3.0",
        "dune": "Mozilla/5.0 (Dune HD; DuneOS) AppleWebKit/537.36 (KHTML, like Gecko) DuneHD/1.0 Chrome/68.0.3440.106 Safari/537.36",
    }

    def _handle_cp_proxy(self):
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(lengths) != 1:
            self._send_text("Content-Length required", 400)
            return
        if len(lengths[0]) > 6 or not lengths[0].isascii() or not lengths[0].isdigit():
            self._send_text("Invalid Content-Length", 400)
            return
        clen = int(lengths[0])
        if not 1 <= clen <= 65536:
            self._send_text("Invalid proxy request size", 413)
            return
        try:
            raw = self.rfile.read(clen)
            if len(raw) != clen:
                self._send_text("Incomplete proxy request", 400)
                return
            body = raw.decode("utf-8")
        except (OSError, UnicodeError):
            self._send_text("Invalid proxy request", 400)
            return
        params = urllib.parse.parse_qs(body)
        url_param = params.get("url", [""])[0].strip()
        if url_param.startswith("@"):
            url_param = url_param[1:]
        if not url_param:
            self._send_text("No URL provided", 400)
            return
        ua_id = params.get("ua", [""])[0].strip().lower()
        ua = self.UA_PRESETS.get(ua_id, "OTT-play-FOSS/1.0")
        try:
            content = fetch_proxy_text(url_param, ua)
            self._send_text(content)
        except ProxyError as error:
            # Provider URLs often contain credentials; diagnostics are URL-free.
            sys.stderr.write(f"[PROXY] FAIL: {error}\n")
            self._send_text(str(error), 502)

    def _serve_feedback_get(self):
        self._send_json({"status": "ok", "message": "feedback endpoint"})

    def _serve_feedback_post(self):
        body = self._read_body()
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        sys.stderr.write(f"[FEEDBACK] {ts} {self.path}: {body[:500]}\n")
        with open("feedback.log", "a", encoding="utf-8") as f:
            f.write(f"{ts} {self.path}\n{body}\n---\n")
        self._send_json({"status": "ok"})

    def translate_path(self, path):
        return super().translate_path(path)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return {
            ".m3u8": "application/vnd.apple.mpegurl",
            ".m3u": "audio/x-mpegurl",
            ".ts": "video/mp2t",
            ".woff2": "font/woff2",
            ".woff": "font/woff",
            ".js": "application/javascript",
            ".css": "text/css",
        }.get(ext) or super().guess_type(path)

    def log_message(self, format, *args):
        sys.stderr.write("[%s] %s - %s\n" % (self.log_date_time_string(), self.client_address[0], format % args))

    # Webhook endpoints intentionally disabled — unauthenticated broadcast
    # polling is a security risk. Use local_proxy.py for local command queuing.


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    class ReusableTCPServer(socketserver.TCPServer):
        allow_reuse_address = True

    try:
        httpd = ReusableTCPServer((HOST, PORT), OTTPlayHandler)
        if CERT_FILE and KEY_FILE:
            # TLS sidecar: one SSLContext, N listeners (one per https port).
            # Each port terminates TLS and dispatches to the same OTTPlayHandler
            # over the SSL socket — no proxy hop, URLs stay plain.
            import ssl
            import threading

            if not HTTPS_PORTS:
                HTTPS_PORTS = [8443]
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            # Keep the TLS floor explicit for security analysis without lowering a stricter policy.
            if ctx.minimum_version < ssl.TLSVersion.TLSv1_2:  # noqa: PLR1730
                ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            ctx.load_cert_chain(CERT_FILE, KEY_FILE)
            for hp in HTTPS_PORTS:
                httpsd = ReusableTCPServer((HOST, hp), OTTPlayHandler)
                httpsd.socket = ctx.wrap_socket(httpsd.socket, server_side=True)
                threading.Thread(target=httpsd.serve_forever, daemon=True, name=f"https-{hp}").start()
            print(
                f"OTT-play FOSS: https on ports {','.join(map(str, HTTPS_PORTS))} (trusted cert) + http://localhost:{PORT}"
            )
        else:
            print(f"OTT-play FOSS: http://localhost:{PORT}")
        print(f"Directory: {os.getcwd()}")
        if EPG_URLS:
            print(f"EPG sources ({len(EPG_URLS)}):")
            for u in EPG_URLS:
                print(f"  - {u}")
            print(f"  XMLTV channels: {len(xmltv_channels)}")
            print(f"  Programmes: {sum(len(v) for v in xmltv_programs.values())}")
        else:
            print("EPG: none (use --epg-url <url> [...] for multiple sources)")
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        httpd.shutdown()
        sys.exit(0)
