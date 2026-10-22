/** Hosted EPG has an explicit server transport and a custom-source XMLTV worker. */
(window as any).__OTT_HOSTED_EPG_SERVER_VERSION__ = 1;
(function (host: any) {
    var previous: any = null;
    var status: any = { phase: "idle" };
    function now(): number {
        return Date.now();
    }
    function timings(): any {
        var saved = status.timings;
        if (!saved) return { cache: 0, download: 0, parse: 0 };
        var values: any = {
            cache: saved.cache,
            download: saved.download,
            parse: saved.parse,
        };
        var key = status.phase;
        if (key === "starting" || key === "waiting") key = "cache";
        if (typeof values[key] === "number")
            values[key] += Math.max(0, now() - status.phaseStarted);
        return values;
    }
    function phase(next: string): void {
        status.timings = timings();
        status.phaseStarted = now();
        status.phase = next;
    }
    // Dedicated transport DTO: the local diagnostics API also contains source labels.
    function remoteSnapshot(): any {
        var value: any = { available: true, enabled: !!settings() };
        if (!value.enabled) return value;
        function count(number: any): number | null {
            return typeof number === "number" &&
                number >= 0 &&
                number <= 9007199254740991 &&
                Math.floor(number) === number
                ? number
                : null;
        }
        function state(name: any): string | null {
            return "idle starting waiting cache download parse ready error"
                .split(" ")
                .indexOf(name) >= 0
                ? name
                : null;
        }
        var times = timings();
        Object.keys(times).forEach(function (key: string) {
            times[key] = count(times[key]);
        });
        value.phase = state(status.phase);
        value.failedPhase = state(status.failedPhase);
        value.elapsedMs = count((status.finished || now()) - status.started);
        value.timingsMs = times;
        return value;
    }
    function restartNeeded(): boolean {
        return (
            status.code === "EPG_WORKER" && status.failedPhase === "starting"
        );
    }
    function description(): string {
        var code = status.code || "";
        if (!code) return phaseDescription(status.phase);
        if (code === "EPG_INSECURE_SOURCE")
            return host._(
                "An HTTPS player cannot download an HTTP EPG source. Use an HTTPS source."
            );
        if (code === "EPG_EMPTY")
            return host._(
                "No programmes matched the playlist channels and dates. Check the source and device clock."
            );
        var message = restartNeeded()
            ? "could not start. Restart the player to reload its files. Playback will stop."
            : code === "EPG_HTTP"
              ? "source returned HTTP %1"
              : code === "EPG_NETWORK"
                ? "download failed. Check the connection, HTTPS and source CORS permissions."
                : code === "EPG_TIMEOUT"
                  ? "download timed out. Retry the download."
                  : /^EPG_STORAGE/.test(code)
                    ? "local storage is unavailable or full."
                    : /LIMIT$/.test(code)
                      ? "exceeds the device processing limit. Use a smaller source or archive window."
                      : /^EPG_(GZIP|XML|UTF8)/.test(code)
                        ? "archive or XML is invalid."
                        : "processing stopped. Retry and check browser support.";
        return host._("EPG " + message, status.httpStatus);
    }
    function phaseDescription(phase: string): string {
        var message =
            phase === "idle"
                ? " has not started. Load an M3U playlist."
                : phase === "ready"
                  ? " ready"
                  : phase === "download"
                    ? ": downloading programme guide..."
                    : phase === "parse"
                      ? ": processing programme guide..."
                      : phase === "waiting"
                        ? ": waiting for another player tab..."
                        : ": opening local cache...";
        return host._("EPG" + message);
    }
    function sourceLabel(url: string): string {
        // A source path or query may contain subscription credentials.
        var match = /^https?:\/\/([^/?#]+)/i.exec(url);
        return match ? match[1].replace(/^.*@/, "").slice(0, 128) : "?";
    }
    var diagnosticsLoad: any = null;
    var diagnosticsClose: any = null;
    function cancelDiagnostics(pendingOnly?: boolean): void {
        if (diagnosticsLoad) diagnosticsLoad.cancel();
        if (!pendingOnly && diagnosticsClose) diagnosticsClose();
    }
    function showDiagnostics(): void {
        if (diagnosticsLoad) {
            if (diagnosticsLoad.current()) return;
            diagnosticsLoad.cancel();
        }
        function initialized(): boolean {
            var module = host.__ottHostedEpgDiagnostics;
            return (
                module &&
                module.version === 1 &&
                typeof module.open === "function"
            );
        }
        function openPanel(): void {
            diagnosticsClose = host.__ottHostedEpgDiagnostics.open({
                closed: function () {
                    diagnosticsClose = null;
                },
                description: description,
                phaseDescription: phaseDescription,
                restartNeeded: restartNeeded,
                retry: function (restart: boolean) {
                    if (restart) host.restart();
                    else if (previous) previous.retry();
                },
                status: function () {
                    return status;
                },
                timings: timings,
            });
        }
        if (initialized()) {
            openPanel();
            return;
        }
        var screen = host.__ottClassicScreenPort;
        var owner = screen && screen.screens.current();
        var revision = screen && screen.revision();
        var about = host.aboutKeyHandler;
        var list = host.listKeyHandler;
        var script: any = null;
        var timeout: any = null;
        var detach: any = null;
        var closed = false;
        function cancel(): void {
            if (closed) return;
            closed = true;
            diagnosticsLoad = null;
            host.clearTimeout(timeout);
            host.document.removeEventListener("keydown", back, true);
            if (script) {
                script.onload = script.onerror = null;
                if (script.parentNode) script.parentNode.removeChild(script);
            }
            if (detach) detach();
        }
        function back(event: any): void {
            if (
                event.keyCode === host.keys.RETURN ||
                event.keyCode === host.keys.EXIT
            )
                cancel();
        }
        function current(): boolean {
            return (
                !closed &&
                host.aboutKeyHandler === about &&
                host.listKeyHandler === list &&
                (!screen || screen.revision() === revision) &&
                (!owner || owner.active())
            );
        }
        function finish(success: boolean): void {
            if (closed) return;
            var owned = current();
            cancel();
            if (!owned) return;
            if (success && initialized()) openPanel();
            else if (host.showShift)
                host.showShift(
                    host._(
                        "EPG diagnostics could not load. Open it again to retry."
                    )
                );
        }
        diagnosticsLoad = { cancel: cancel, current: current };
        if (owner) detach = owner.own(cancel);
        host.document.addEventListener("keydown", back, true);
        var configuration = settings();
        var url =
            (configuration && configuration.diagnosticsUrl) ||
            "/hosted/epg-diagnostics.js";
        if (
            typeof url !== "string" ||
            !/^\/(?![\/\\])[^\\\u0000-\u0020]*$/.test(url)
        ) {
            finish(false);
            return;
        }
        if (host.showShift)
            host.showShift(
                host._("EPG diagnostics") + " · " + host._("Loading...")
            );
        timeout = host.setTimeout(function () {
            finish(false);
        }, 10000);
        try {
            script = host.document.createElement("script");
            script.src = url;
            script.onload = function () {
                finish(true);
            };
            script.onerror = function () {
                finish(false);
            };
            host.document.body.appendChild(script);
        } catch (_) {
            finish(false);
        }
    }
    function settings(): any {
        var deployment = host.__OTTPLAY_HOSTED__;
        return deployment &&
            deployment.version === 1 &&
            !host.Capacitor &&
            !host.__TAURI__
            ? deployment.epg
            : null;
    }
    function open(
        channels: any[],
        notify: (mappings: any) => void,
        progress?: (message: string) => void
    ): any {
        if (previous) previous.close();
        if (host.__ottStandby?.blocked())
            return {
                close: function () {},
                guide: function (_id: any, done: any) {
                    done(null);
                },
            };
        var configuration = settings();
        var worker: any = null;
        var disposed = false;
        var nextQuery = 0;
        var pending: any = Object.create(null);
        var sources: string[] = [];
        var heartbeat = now();
        var watchdog: any = null;
        var attempt = 0;
        var closing: any = null;
        var resumed: any = null;
        var accepted: any = null;
        var rows = channels.map(function (channel: any) {
            var urls = (
                channel.xmltv_urls && channel.xmltv_urls.length
                    ? channel.xmltv_urls
                    : [configuration.source]
            ).map(function (url: string) {
                // The publisher moved these public aliases; HTTPS avoids old mixed-content redirects.
                url = url.replace(
                    /^https?:\/\/(?:epg\.it999\.ru|epg\.one)\//i,
                    "https://cdn.epg.one/"
                );
                if (sources.indexOf(url) < 0) sources.push(url);
                return url;
            });
            return {
                archiveHours: Math.max(0, Number(channel.rec) || 0),
                id: String(channel.id),
                name: channel.epg_manual
                    ? ""
                    : channel.channel_name || channel.name || "",
                sources: urls,
                tvgId: channel.epg || "",
                tvgName: channel.tn || "",
            };
        });
        // A custom or ordered mixed source list stays entirely device-owned.
        // Only this exact public default is represented by the server source ID.
        var server =
            configuration &&
            configuration.mode === "server" &&
            sources.length === 1 &&
            sources[0] === "https://cdn.epg.one/epg2.xml.gz";
        function report(message: string): void {
            if (!disposed && progress) progress(message);
        }
        function failed(code: string, value?: any): void {
            if (disposed) return;
            status.code = code;
            status.httpStatus = (value && value.httpStatus) || 0;
            status.cached = value ? !!value.cached : !!status.cached;
            status.failedPhase = (value && value.phase) || status.phase;
            phase("error");
            status.finished = now();
            var expected = attempt;
            if (!value || !value.recoverable) clearPending();
            if (disposed || attempt !== expected) return;
            report(description());
            if (host.showShift)
                host.showShift(
                    host._("EPG error. Open Information → EPG diagnostics.")
                );
        }
        function cancel(query: string, value: any): void {
            var job = pending[query];
            if (!job) return;
            delete pending[query];
            host.clearTimeout(job.timer);
            if (!disposed) job.callback(value);
        }
        function clearPending(): void {
            Object.keys(pending).forEach(function (query) {
                cancel(query, null);
            });
        }
        function stop(callback?: () => void): void {
            resumed = callback;
            if (closing) return;
            var old = worker;
            worker = null;
            if (!old) {
                if (callback) callback();
                return;
            }
            closing = old;
            var timeout: any;
            function finished(): void {
                if (closing !== old) return;
                host.clearTimeout(timeout);
                old.onmessage = old.onerror = null;
                old.terminate();
                closing = null;
                var next = resumed;
                resumed = null;
                if (next) next();
            }
            old.onmessage = function (event: any) {
                if (event.data && event.data.type === "closed") finished();
            };
            old.onerror = finished;
            // A wedged Worker must not prevent a retry or keep resources alive.
            timeout = host.setTimeout(finished, 1000);
            try {
                if (host.__ottStandby?.blocked()) {
                    finished();
                    return;
                }
                old.postMessage({ type: "close" });
            } catch (_) {
                finished();
            }
        }
        var session = {
            close: function () {
                if (disposed) return;
                disposed = true;
                cancelDiagnostics();
                ++attempt;
                host.clearInterval(watchdog);
                clearPending();
                stop();
                if (previous === session) {
                    previous = null;
                    status = { phase: "idle" };
                }
            },
            guide: function (
                id: string | number,
                callback: (rows: any) => void
            ): void {
                if (disposed || !worker) {
                    callback(null);
                    return;
                }
                var query = String(++nextQuery);
                pending[query] = {
                    callback: callback,
                    timer: host.setTimeout(
                        function () {
                            if (server && worker)
                                worker.postMessage({
                                    query: query,
                                    type: "cancel",
                                });
                            cancel(query, null);
                        },
                        server ? 45000 : 15000
                    ),
                };
                worker.postMessage({
                    id: String(id),
                    query: query,
                    type: "guide",
                });
            },
            retry: function () {
                if (disposed) return;
                cancelDiagnostics(true);
                var expected = ++attempt;
                host.clearInterval(watchdog);
                clearPending();
                if (disposed || attempt !== expected) return;
                stop(function () {
                    if (!disposed && attempt === expected) start(true);
                });
            },
        };
        previous = session;
        function start(force: boolean): void {
            var currentAttempt = ++attempt;
            accepted = null;
            worker = null;
            heartbeat = now();
            status = {
                channels: rows.length,
                phase: "starting",
                phaseStarted: heartbeat,
                sources: sources.map(sourceLabel),
                started: heartbeat,
                timings: { cache: 0, download: 0, parse: 0 },
                transport: server ? "server" : "client",
            };
            try {
                var workerUrl =
                    configuration &&
                    configuration[server ? "serverWorkerUrl" : "workerUrl"];
                // The deployment controls this fixed same-origin worker path, never a playlist.
                if (!host.Worker || !/^\/(?!\/)/.test(workerUrl || ""))
                    throw new Error();
                worker = new host.Worker(workerUrl);
                worker.onmessage = function (event: any) {
                    if (disposed || attempt !== currentAttempt) return;
                    var value = event.data || {};
                    heartbeat = now();
                    if (value.type === "guide") {
                        if (server) status.cached = !!value.cached;
                        cancel(String(value.query), value.rows);
                    } else if (value.type === "ready") {
                        status.cached = !server || !!value.cached;
                        status.fetched = value.fetched;
                        status.matched = Object.keys(
                            value.mappings || {}
                        ).length;
                        status.records = value.records;
                        status.sourceStale = !!value.sourceStale;
                        phase(value.stale ? "cache" : "ready");
                        status.code = "";
                        status.finished = value.stale ? 0 : now();
                        var revision = value.generation || value.fetched;
                        if (accepted === null || accepted !== revision) {
                            accepted = revision;
                            notify(value.mappings || {});
                            if (disposed || attempt !== currentAttempt) return;
                            // Channel IDs can survive a schedule replacement.
                            if (
                                host.__ottClassicGuide &&
                                host.__ottClassicGuide.invalidate
                            )
                                host.__ottClassicGuide.invalidate(true);
                            // A completed empty screen no longer has a pending
                            // guide consumer; refresh its current owned view.
                            if (
                                !disposed &&
                                attempt === currentAttempt &&
                                host.__ottClassicGuideScreen
                            )
                                host.__ottClassicGuideScreen.refresh();
                        }
                        report(
                            value.stale
                                ? host._(
                                      "EPG: updating saved programme guide..."
                                  )
                                : host._("EPG ready")
                        );
                    } else if (value.type === "progress") {
                        var changed = status.phase !== value.phase;
                        if (
                            value.phase === "cache" &&
                            (status.phase === "ready" ||
                                status.phase === "error")
                        ) {
                            status.started = now();
                            status.timings = null;
                        }
                        phase(value.phase);
                        status.source = value.source;
                        status.loaded = value.loaded;
                        status.total = value.total;
                        status.records = value.records;
                        status.code = "";
                        status.finished = 0;
                        if (changed) report(description());
                    } else if (value.type === "error") {
                        failed(value.code, value);
                    }
                };
                worker.onerror = function () {
                    if (!disposed && attempt === currentAttempt)
                        failed("EPG_WORKER");
                };
                worker.postMessage({
                    apiBase: configuration.apiBase,
                    channels: rows,
                    force: force,
                    refreshMs: Math.max(
                        60000,
                        Number(configuration.refreshMs) || 7200000
                    ),
                    sourceId: configuration.sourceId,
                    sources: sources,
                    type: "load",
                });
                watchdog = host.setInterval(function () {
                    if (
                        disposed ||
                        status.phase === "ready" ||
                        status.phase === "error"
                    )
                        return;
                    if (
                        now() - heartbeat >
                        (status.phase === "download" ? 200000 : 60000)
                    ) {
                        ++attempt;
                        host.clearInterval(watchdog);
                        stop();
                        failed("EPG_STALLED");
                    }
                }, 5000);
            } catch (_) {
                failed("EPG_WORKER");
            }
        }
        start(false);
        return session;
    }
    host.__ottHostedEpg = {
        diagnostics: function () {
            var value = JSON.parse(JSON.stringify(status));
            value.timings = timings();
            return value;
        },
        enabled: function () {
            return !!settings();
        },
        open: open,
        remoteSnapshot: remoteSnapshot,
        showDiagnostics: showDiagnostics,
        suspend: function () {
            cancelDiagnostics();
            if (previous) previous.close();
        },
    };
})(window);
