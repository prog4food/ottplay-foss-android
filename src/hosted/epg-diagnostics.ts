/** Optional panel: loading this self-contained module never opens a screen. */
(function (host: any) {
    // A cancelled script fetch may still execute after a later successful load.
    var installed = host.__ottHostedEpgDiagnostics;
    if (
        installed &&
        installed.version === 1 &&
        typeof installed.open === "function"
    )
        return;
    var active: any = null;
    function open(context: any): () => void {
        if (active && !active.owns()) active.close();
        if (active) return active.close;
        var closed = false;
        var owner: any = null;
        var detach: any = null;
        function owns(): boolean {
            return (
                !closed &&
                host.aboutKeyHandler === handler &&
                (!owner || owner.active())
            );
        }
        var panel = host.$("#listAbout");
        var previousHandler = host.aboutKeyHandler;
        var restartShown = false;
        host.saveListPanelState();
        host.$("#listCaption").text(host._("EPG diagnostics"));
        panel.empty().show();
        var content = host
            .$("<pre class='hosted-epg-diagnostics'>")
            .appendTo(panel);
        function seconds(value: number): string {
            return (value / 1000).toFixed(1) + " s";
        }
        function render(): void {
            var status = context.status();
            restartShown = context.restartNeeded();
            var label = restartShown ? "Restart player" : "Retry EPG download";
            action.text(host._(label));
            host.listFooter.innerHTML =
                host.renderButtonHint(host.keys.ENTER, host.strENTER, label) +
                host.renderButtonHint(
                    host.keys.RETURN,
                    host.strRETURN,
                    "Close"
                );
            var lines = [context.description()];
            if (status.transport)
                lines.push(
                    "EPG transport: " +
                        (status.transport === "server"
                            ? "server (matching; guide on demand)"
                            : "device XMLTV")
                );
            if (status.code) {
                lines.push(status.code);
                lines.push(
                    host._(
                        "EPG stopped during: %1",
                        context.phaseDescription(status.failedPhase)
                    )
                );
            }
            if (status.sources && status.sources.length) {
                var index = Math.max(0, status.source || 0);
                lines.push(
                    host._(
                        "EPG source: %1",
                        index +
                            1 +
                            "/" +
                            status.sources.length +
                            " · " +
                            status.sources[index]
                    )
                );
            }
            if (status.total || status.loaded)
                lines.push(
                    host._(
                        "EPG progress: %1",
                        ((status.loaded || 0) / 1048576).toFixed(1) +
                            " / " +
                            ((status.total || 0) / 1048576).toFixed(1) +
                            " MiB"
                    )
                );
            if (status.records != null)
                lines.push(host._("EPG programmes: %1", status.records));
            if (status.matched != null)
                lines.push(
                    host._(
                        "EPG channels: %1",
                        status.matched + "/" + status.channels
                    )
                );
            if (status.fetched)
                lines.push(
                    host._(
                        "EPG cache updated: %1",
                        new Date(status.fetched).toLocaleString()
                    )
                );
            if (status.cached && (status.code || status.sourceStale))
                lines.push(
                    host._("EPG update failed; using saved programme guide")
                );
            if (status.started) {
                lines.push(
                    host._(
                        "EPG elapsed: %1",
                        Math.round(
                            ((status.finished || Date.now()) - status.started) /
                                1000
                        ) + " s"
                    )
                );
                var times = context.timings();
                lines.push(
                    host._("EPG cache and wait time: %1", seconds(times.cache)),
                    host._("EPG download time: %1", seconds(times.download)),
                    host._(
                        "EPG processing and storage time: %1",
                        seconds(times.parse)
                    )
                );
            }
            content.text(lines.join("\n\n"));
        }
        function close(): void {
            if (closed) return;
            var owned = owns();
            closed = true;
            active = null;
            host.clearInterval(timer);
            if (owned) {
                panel.hide().empty();
                host.aboutKeyHandler = previousHandler;
                host.restoreListPanelState();
            }
            if (detach) detach();
            context.closed();
        }
        function retry(): void {
            // A state change must not turn an advertised retry into a restart.
            if (restartShown !== context.restartNeeded()) {
                render();
                return;
            }
            context.retry(restartShown);
            if (owns()) render();
        }
        function button(callback: () => void): any {
            return host
                .$("<button type='button'>")
                .on("click", function (event: any) {
                    event.stopPropagation();
                    callback();
                })
                .appendTo(panel);
        }
        var action = button(retry);
        button(close).text(host._("Back"));
        var handler = function (key: number): boolean {
            if (key === host.keys.RETURN || key === host.keys.EXIT) close();
            else if (key === host.keys.ENTER) retry();
            else if (key === host.keys.UP || key === host.keys.DOWN)
                content.scrollTop(
                    content.scrollTop() + (key === host.keys.UP ? -80 : 80)
                );
            return true;
        };
        host.aboutKeyHandler = handler;
        var screen = host.__ottClassicScreenPort;
        if (screen) {
            owner = screen.owner("about");
            if (owner) detach = owner.own(close);
        }
        active = { close: close, owns: owns };
        var timer = host.setInterval(function () {
            // Modal children may temporarily hide a still-owned parent panel.
            if (
                !owns() ||
                (!panel.is(":visible") && (!owner || owner.foreground()))
            )
                close();
            else render();
        }, 1000);
        render();
        return close;
    }
    host.__ottHostedEpgDiagnostics = { open: open, version: 1 };
})(window as any);
