#!/usr/bin/env python3
"""Bounded, offline acceptance test for the release server's complete EPG path.

Generate a diverse XMLTV feed, start an isolated loopback server, and verify cold
readiness plus repeated channel/logo requests. No external service is contacted.
Use --feed for a separately downloaded, decompressed XMLTV feed; reports never contain its data.
"""
from __future__ import annotations

import argparse
import concurrent.futures
from contextlib import contextmanager
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import statistics
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET


def fixture(path: Path, channels: int, programmes: int) -> None:
    epoch = dt.datetime.now(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    with path.open("w", encoding="utf-8") as output:
        output.write("<tv>\n")
        for channel in range(channels):
            name = "РЕН ТВ HD" if channel == 0 else f"Телеканал {channel:04d} HD"
            output.write(f'<channel id="c{channel}"><display-name>{name}</display-name>'
                         f'<icon src="https://example.invalid/{channel}.png"/></channel>\n')
        for index in range(programmes):
            channel = index % channels
            # Channel-specific offsets exercise distinct dates, not one cached timestamp.
            start = epoch + dt.timedelta(minutes=(index // channels) * 30, seconds=channel)
            stop = start + dt.timedelta(minutes=30)
            output.write(f'<programme channel="c{channel}" start="{start:%Y%m%d%H%M%S} +0000" '
                         f'stop="{stop:%Y%m%d%H%M%S} +0000"><title>Новости &amp; события {index}</title>'
                         '<desc>Описание передачи: новости, культура, спорт. '
                         '<![CDATA[Программа <эфира>]]> Подробности и интервью.</desc>'
                         '<category>Новости</category><icon src="https://example.invalid/programme.png"/>'
                         '</programme>\n')
        output.write("</tv>")


def channel_names(path: Path) -> list[str]:
    names: dict[str, str] = {}
    for _, element in ET.iterparse(path, events=("end",)):
        if element.tag == "channel":
            # The Rust browser feed contract keeps the last display-name and
            # replaces repeated channel IDs. Mirror that when choosing exact queries.
            channel_id = element.get("id", "")
            display_names = element.findall("display-name")
            name = "".join(display_names[-1].itertext()).strip() if display_names else ""
            names[channel_id] = name or channel_id
            element.clear()
        elif element.tag == "programme":
            break
    if not names:
        raise ValueError("Feed contains no channel names")
    return list(names.values())


def legacy_body(names: list[str]) -> bytes:
    lines = [f"{index + 1}-0-0-0~{urllib.parse.quote(name, safe='')}" for index, name in enumerate(names)]
    return ("{}\n\t\n\n\t\n" + "\n".join(lines) + "\n").encode()


def matched_rows(body: bytes, queries: list[str], logos: bool = False) -> list[str]:
    sections = body.decode().split("\n\t\n")
    if len(sections) != (2 if logos else 3) or sections[0] != "{}":
        raise AssertionError("Invalid legacy match response envelope")
    if not logos and sections[2] != "local~/":
        raise AssertionError("Invalid legacy EPG source response")
    lines = sections[1].splitlines()
    if len(lines) != len(queries):
        raise AssertionError("Match response returned the wrong number of rows")
    for index, line in enumerate(lines):
        fields = line.split("~", 1 if logos else 2)
        if fields[0] != str(index + 1):
            raise AssertionError("Match response lost its playlist channel ID")
        if logos:
            if len(fields) != 2 or not fields[1]:
                raise AssertionError("Logo response has no URL")
        elif len(fields) != 3 or fields[1] != "local" or not re.fullmatch(r"[a-f0-9]{16}", fields[2]):
            # Numeric fallback IDs also have ~local~, but are not successful matches.
            raise AssertionError("Exact feed name did not receive a registered EPG hash")
    return lines


def request(base: str, path: str, body: bytes | None, timeout: float) -> tuple[float, bytes]:
    started = time.monotonic()
    req = urllib.request.Request(base + path, data=body, headers={"Content-Type": "text/plain"})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=timeout) as response:
        result = response.read()
        if response.status != 200:
            raise AssertionError(f"Unexpected HTTP status {response.status}")
    return (time.monotonic() - started) * 1000, result


@contextmanager
def running_server(args: argparse.Namespace, root: Path, feed: Path, output):
    """Run only the requested binary/image and always tear it down, even on setup failure."""
    container = None
    process = None
    try:
        if args.image:
            # --pull=never guarantees the gate tests the image built by this job.
            # No host environment or production credentials enter the container.
            container = "ottplay-epg-perf-" + uuid.uuid4().hex
            subprocess.run([
                "docker", "create", "--name", container, "--pull=never", "--cpus=2", "--memory=2g", "--memory-swap=2g",
                "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                "--publish", "127.0.0.1::8080", "--volume", f"{feed}:/fixture.xml:ro",
                "--env", "EPG_URLS=/fixture.xml", "--env", "DATABASE_URL=",
                "--entrypoint", "/app/ottplay-server", args.image,
                "--host", "0.0.0.0", "--port", "8080",
            ], check=True, stdout=subprocess.DEVNULL, timeout=30)
            subprocess.run(["docker", "start", container], check=True, stdout=subprocess.DEVNULL, timeout=30)
            ports = subprocess.check_output(["docker", "port", container, "8080/tcp"], text=True, timeout=10).strip()
            match = re.fullmatch(r"127\.0\.0\.1:(\d+)", ports)
            if not match:
                raise RuntimeError("Container did not publish one loopback HTTP port")
            port = int(match.group(1))
            process = subprocess.Popen(["docker", "logs", "--follow", container],
                                       stdout=output, stderr=subprocess.STDOUT)
        else:
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            env = dict(os.environ, EPG_URLS=str(feed))
            # This diagnostic server must not inherit production persistence/secrets.
            for key in ("DATABASE_URL", "OTTPLAY_SWOP_INSTALLATION_TOKEN", "SWOP_INSTALLATION_TOKEN"):
                env.pop(key, None)
            process = subprocess.Popen([str(args.server), "--host", "127.0.0.1", "--port", str(port)],
                                       cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT)
        yield process, f"http://127.0.0.1:{port}"
    finally:
        try:
            if container:
                # The unique name is reserved before create, covering setup timeouts too.
                subprocess.run(["docker", "rm", "--force", container],
                               check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        finally:
            if process is not None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--server", type=Path, help="Local release server executable")
    target.add_argument("--image", help="Locally built Docker image (2 CPUs, 2 GiB memory)")
    parser.add_argument("--feed", type=Path)
    parser.add_argument("--probe-name", default="РЕН ТВ HD", help="Playlist name whose EPG must resolve")
    parser.add_argument("--channels", type=int, default=3247)
    parser.add_argument("--programmes", type=int, default=600000)
    parser.add_argument("--warmup-seconds", type=float, default=30)
    parser.add_argument("--request-ms", type=float, default=2000)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.server:
        args.server = args.server.resolve(strict=True)
    if args.channels < 1 or args.programmes < args.channels:
        parser.error("Need at least one channel and one programme per channel")
    if args.warmup_seconds <= 0 or args.request_ms <= 0 or not args.probe_name:
        parser.error("Performance budgets and probe name must be nonempty and positive")
    report: dict = {"samples": {}, "budgets": {"warmup_seconds": args.warmup_seconds,
                                              "request_ms": args.request_ms}}
    report["image" if args.image else "server"] = args.image or str(args.server)
    if args.image:
        report["container_limits"] = {"cpus": 2, "memory_bytes": 2 * 1024 ** 3}
    with tempfile.TemporaryDirectory(prefix="ottplay-epg-perf-") as directory:
        root = Path(directory)
        feed = args.feed.resolve(strict=True) if args.feed else root / "fixture.xml"
        if not args.feed:
            fixture(feed, args.channels, args.programmes)
        report["feed_bytes"] = feed.stat().st_size
        with feed.open("rb") as source:
            report["feed_sha256"] = hashlib.file_digest(source, "sha256").hexdigest()
        names = channel_names(feed)
        ren = args.probe_name
        selected = names[:500]
        log = root / "server.log"
        started = time.monotonic()
        with log.open("wb") as output:
            try:
                with running_server(args, root, feed, output) as (process, base):
                    while True:
                        if process.poll() is not None:
                            raise RuntimeError(f"Server exited during warmup ({process.returncode})")
                        loaded = re.search(r"\[EPG\] Loaded (\d+) channels, (\d+) programmes", log.read_text())
                        if loaded:
                            report["loaded_channels"], report["loaded_programmes"] = map(int, loaded.groups())
                            break
                        if time.monotonic() - started > args.warmup_seconds:
                            raise AssertionError("EPG cold warmup exceeded its performance budget")
                        time.sleep(0.05)
                    report["warmup_seconds"] = time.monotonic() - started
                    if report["loaded_channels"] != len(names) or not report["loaded_programmes"]:
                        raise AssertionError("Cold warmup published incomplete programme data")
                    if not args.feed and report["loaded_programmes"] != args.programmes:
                        raise AssertionError("Synthetic feed lost programmes")
                    timeout = max(5.0, args.request_ms / 1000 * 2)
                    for label, endpoint, queries in (
                        ("ren_match", "/m3u/match-channels", [ren]),
                        ("playlist_match", "/m3u/match-channels", selected),
                        ("playlist_logos", "/m3u/match-logos", selected),
                    ):
                        timings = []
                        for _ in range(3):
                            elapsed, body = request(base, endpoint, legacy_body(queries), timeout)
                            timings.append(elapsed)
                            matched_rows(body, queries, logos=endpoint.endswith("match-logos"))
                        report["samples"][label] = {"queries": len(queries), "ms": timings,
                            "median_ms": statistics.median(timings), "max_ms": max(timings)}
                    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                        results = list(pool.map(lambda _: request(base, "/m3u/match-channels", legacy_body([ren]), timeout), range(4)))
                    report["samples"]["concurrent_ren"] = {"queries": 4, "ms": [r[0] for r in results],
                        "max_ms": max(r[0] for r in results)}
                    for _, body in results:
                        matched_rows(body, [ren])
                    hash_value = re.search(rb"~local~([a-f0-9]+)", results[0][1]).group(1).decode()
                    for label, path in (("programme_read", f"/epg/{hash_value}.json"),
                                        ("programme_by_name", "/epg/unregistered-name-probe.json?" + urllib.parse.urlencode({"ch": ren}))):
                        # An unregistered hash cannot hide a broken name lookup behind the hash registry.
                        elapsed, body = request(base, path, None, timeout)
                        schedule = json.loads(body)["epg_data"]
                        if not schedule:
                            raise AssertionError("Matched channel has no programme data")
                        report["samples"][label] = {"ms": [elapsed], "max_ms": elapsed, "programmes": len(schedule)}
                    if any(sample["max_ms"] > args.request_ms for sample in report["samples"].values()):
                        raise AssertionError("EPG request exceeded its performance budget")
                    report["passed"] = True
            except Exception as error:
                report["passed"] = False
                report["error"] = str(error)
    serialized = json.dumps(report, indent=2)
    print(serialized)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized + "\n")
    if not report["passed"]:
        raise SystemExit(1)


def terminate(signum, _frame):
    # CI cancellation must unwind the server/container context manager.
    raise SystemExit(128 + signum)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, terminate)
    main()
