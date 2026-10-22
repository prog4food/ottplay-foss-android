/** Per-device quality ceilings and explicit, source-scoped live stream alternatives. */
(function (w: any) {
    var key = "streamBackupsV1";
    var report: any;
    function reset(): void {
        report = {
            attempts: 0,
            available: true,
            endpoint: 0,
            engine: "none",
            maxBitrate: 0,
            maxHeight: 0,
            state: "loading",
            supported: false,
        };
    }
    reset();
    function quality(): any {
        function limit(value: any, maximum: number): number {
            return typeof value === "number" && isFinite(value) && value > 0
                ? Math.min(maximum, Math.floor(value))
                : 0;
        }
        return {
            maxBitrate: limit(w.sStreamMaxBitrate, 100000000),
            maxHeight: limit(w.sStreamMaxHeight, 4320),
        };
    }
    function url(value: any): boolean {
        if (
            typeof value !== "string" ||
            value.length > 4096 ||
            /[\x00-\x20\x7f\\]/.test(value)
        )
            return false;
        var match =
            /^https?:\/\/(?:\[[a-f0-9:.]+\]|[^\s:/@?#]+)(?::(\d{1,5}))?(?:[/?#]|$)/i.exec(
                value
            );
        return (
            !!match &&
            (!match[1] || (Number(match[1]) > 0 && Number(match[1]) <= 65535))
        );
    }
    function capture(): any {
        var playback = w.__ottClassicPlayback;
        var state = playback && playback.snapshot();
        var owner = playback && playback.context();
        var target = state && state.phase !== "stopped" && state.target;
        if (!target || !owner || !owner.isCurrentBackend) return null;
        return {
            active: owner.isCurrentBackend,
            id: JSON.stringify([target.sourceId, target.channelId]),
            live: target.kind === "live",
        };
    }
    function read(): any {
        try {
            var raw = w.providerGetItem(key);
            if (!raw) return { channels: {}, version: 1 };
            if (raw.length > 262144) return null;
            var value = JSON.parse(raw);
            if (
                !value ||
                value.version !== 1 ||
                !value.channels ||
                typeof value.channels !== "object" ||
                Array.isArray(value.channels) ||
                Object.keys(value.channels).length > 256
            )
                return null;
            var valid = Object.keys(value.channels).every(function (id) {
                var rows = value.channels[id];
                return (
                    id.length <= 2048 &&
                    Array.isArray(rows) &&
                    rows.length <= 3 &&
                    rows.every(function (row) {
                        return row === "" || url(row);
                    })
                );
            });
            return valid ? value : null;
        } catch (_) {
            return null;
        }
    }
    function endpoints(primary: string): string[] {
        var owner = capture(),
            value = read();
        var rows =
            owner &&
            owner.live &&
            owner.active() &&
            value &&
            value.channels[owner.id];
        return [primary].concat(rows || []).filter(function (item, index, all) {
            return !!item && all.indexOf(item) === index;
        });
    }
    function edit(editor: any): void {
        var owner = capture(),
            value = read();
        if (!owner || !owner.live || !owner.active()) {
            w.showShift(w._("Select a live channel first"));
            return;
        }
        if (!value) {
            w.showShift(w._("Invalid setting"));
            return;
        }
        if (w.__ottParental && w.__ottParental.needs("settings")) {
            w.enterPinAndSetAccess(function () {
                if (owner.active()) edit(editor);
            });
            return;
        }
        var rows = (value.channels[owner.id] || []).slice();
        w.showSelectBox(
            0,
            [1, 2, 3].map(function (n) {
                return (
                    w._("Backup streams") + " " + n + (rows[n - 1] ? " ✓" : "")
                );
            }),
            function (index: number) {
                if (!owner.active() || index < 0 || index > 2) return;
                function save(text: string): void {
                    if (
                        !owner.active() ||
                        (w.__ottParental && w.__ottParental.needs("settings"))
                    )
                        return;
                    text = text.trim();
                    if (text && !url(text)) {
                        w.showShift(
                            w._(
                                "Use HTTP or HTTPS without a username or password in the address."
                            )
                        );
                        return;
                    }
                    var next = read();
                    if (!next) {
                        w.showShift(w._("Invalid setting"));
                        return;
                    }
                    var current = (next.channels[owner.id] || []).slice();
                    if ((current[index] || "") !== (rows[index] || "")) {
                        w.showShift(w._("Backup state changed"));
                        return;
                    }
                    while (current.length <= index) current.push("");
                    current[index] = text;
                    while (current.length && !current[current.length - 1])
                        current.pop();
                    if (current.length) next.channels[owner.id] = current;
                    else delete next.channels[owner.id];
                    var raw = JSON.stringify(next);
                    if (
                        raw.length > 262144 ||
                        Object.keys(next.channels).length > 256
                    ) {
                        w.showShift(w._("Invalid setting"));
                        return;
                    }
                    try {
                        w.providerSetItem(key, raw);
                        w.showShift(
                            owner.active() && w.providerGetItem(key) === raw
                                ? w._("Settings saved")
                                : w._("ERROR!")
                        );
                    } catch (_) {
                        w.showShift(w._("ERROR!"));
                    }
                }
                function change(): void {
                    if (owner.active())
                        editor(
                            w._("Backup streams") +
                                " " +
                                (index + 1) +
                                " (HTTP/HTTPS)",
                            rows[index] || "",
                            save
                        );
                }
                if (rows[index])
                    w.showSelectBox(
                        0,
                        [w._("Edit"), w._("Delete")],
                        function (action: number) {
                            if (action === 0) change();
                            else if (action === 1) save("");
                        },
                        -1
                    );
                else change();
            },
            -1
        );
    }
    function begin(engine: string, supported: boolean): any {
        var value = quality();
        report.engine = engine;
        report.maxHeight = value.maxHeight;
        report.maxBitrate = value.maxBitrate;
        report.supported = supported;
        report.available = true;
        return value;
    }
    function hls(player: any, value: any): boolean {
        if (!value.maxHeight && !value.maxBitrate) return true;
        // HLS levels are not monotonically sorted by bandwidth/height across codec
        // groups. Remove disallowed variants before starting any fragment loader;
        // an index cap alone could leak a high-bitrate variant below an allowed one.
        var levels = player.levels || [],
            allowed: boolean[] = [],
            count = 0;
        for (var i = 0; i < levels.length; i++) {
            var level = levels[i];
            var fits =
                (!value.maxHeight ||
                    (level.height > 0 && level.height <= value.maxHeight)) &&
                (!value.maxBitrate ||
                    (level.bitrate > 0 && level.bitrate <= value.maxBitrate));
            allowed.push(fits);
            if (fits) count++;
        }
        report.available = count > 0;
        if (!count) return false;
        if (typeof player.removeLevel === "function") {
            for (var n = allowed.length - 1; n >= 0; n--)
                if (!allowed[n]) player.removeLevel(n);
            player.autoLevelCapping = player.levels.length - 1;
            player.startLevel = 0;
        } else {
            // Older engines have no removeLevel: enforce only a contiguous safe
            // prefix. Refuse if the first variant cannot satisfy the ceiling.
            var cap = -1;
            while (allowed[cap + 1]) cap++;
            if (cap < 0) {
                report.available = false;
                return false;
            }
            player.autoLevelCapping = cap;
            player.startLevel = 0;
        }
        return true;
    }
    w.__ottStreamPolicy = {
        begin: begin,
        capture: capture,
        edit: edit,
        endpoints: endpoints,
        hls: hls,
        quality: quality,
        report: function (value: any) {
            Object.keys(value).forEach(function (name) {
                report[name] = value[name];
            });
        },
        reset: reset,
        snapshot: function () {
            return Object.assign({}, report);
        },
        validUrl: url,
    };
})(window as any);
