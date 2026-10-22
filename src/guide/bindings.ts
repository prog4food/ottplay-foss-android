/** Explicit XMLTV identities are scoped to the playlist account and stable channel ID. */
(function (host: any) {
    interface Binding {
        channelId: string;
        feed: string;
        xmltvId: string;
    }
    function source(): string {
        return host.__ottSourceIdentity.current(host);
    }
    function enabled(): boolean {
        return (
            host.p_pref === "m3u" &&
            !!(
                host.Capacitor ||
                host.__TAURI__ ||
                (host.__ottHostedEpg && host.__ottHostedEpg.enabled())
            )
        );
    }
    function channelId(row: any, id: any): string {
        return String(row.itemId || "channel:" + id);
    }
    function storageKey(): string {
        var key = "guideBindings:" + source();
        var keys = host.providerScopedStorageKeys;
        if (keys && keys.indexOf(key) < 0) keys.push(key);
        return key;
    }
    function valid(row: any): boolean {
        return (
            !!row &&
            typeof row.channelId === "string" &&
            row.channelId.length > 0 &&
            row.channelId.length <= 1024 &&
            typeof row.feed === "string" &&
            row.feed.length <= 4096 &&
            /^https?:\/\/[^/?#\s]+(?:[/?#]|$)/i.test(row.feed) &&
            typeof row.xmltvId === "string" &&
            row.xmltvId.length > 0 &&
            row.xmltvId.length <= 512 &&
            !/[\x00-\x1f\x7f]/.test(row.channelId + row.feed + row.xmltvId)
        );
    }
    function bounded(text: string): boolean {
        if (text.length > 524288) return false;
        var bytes = 0;
        for (var index = 0; index < text.length; index++) {
            var code = text.charCodeAt(index);
            if (code < 128) bytes++;
            else if (code < 2048) bytes += 2;
            else if (
                code >= 0xd800 &&
                code <= 0xdbff &&
                text.charCodeAt(index + 1) >= 0xdc00 &&
                text.charCodeAt(index + 1) <= 0xdfff
            ) {
                bytes += 4;
                index++;
            } else bytes += 3;
            if (bytes > 524288) return false;
        }
        return true;
    }
    function read(): Binding[] {
        var text = host.providerGetItem(storageKey());
        if (!text) return [];
        if (!bounded(text)) throw new Error("Invalid setting");
        var value = JSON.parse(text);
        if (
            !value ||
            value.version !== 1 ||
            !Array.isArray(value.rows) ||
            value.rows.length > 500 ||
            !value.rows.every(valid)
        )
            throw new Error("Invalid setting");
        var seen: Record<string, boolean> = Object.create(null);
        value.rows.forEach(function (row: Binding) {
            if (seen[row.channelId]) throw new Error("Invalid setting");
            seen[row.channelId] = true;
        });
        return value.rows;
    }
    function find(row: any, id: any): Binding | null {
        var key = channelId(row, id),
            rows = read();
        for (var i = 0; i < rows.length; i++)
            if (rows[i].channelId === key) return rows[i];
        return null;
    }
    function save(
        expectedSource: string,
        row: any,
        id: any,
        binding: Binding | null
    ): void {
        if (
            !enabled() ||
            source() !== expectedSource ||
            host.channels[id] !== row
        )
            throw new Error("Settings source changed");
        var key = storageKey(),
            before = host.providerGetItem(key),
            identifier = channelId(row, id);
        if (binding && (!valid(binding) || binding.channelId !== identifier))
            throw new Error("Invalid setting");
        var rows = read().filter(function (entry) {
            return entry.channelId !== identifier;
        });
        if (binding) rows.push(binding);
        var after = JSON.stringify({ rows: rows, version: 1 });
        if (rows.length > 500 || !bounded(after))
            throw new Error("Invalid setting");
        if (host.providerGetItem(key) !== before || source() !== expectedSource)
            throw new Error("Backup state changed");
        host.providerSetItem(key, after);
        if (host.providerGetItem(key) !== after)
            throw new Error("Settings storage rejected write");
    }
    function prepare(): Record<string, Binding> {
        var rows: Binding[] = [];
        try {
            if (enabled()) rows = read();
        } catch (_) {}
        var result: Record<string, Binding> = Object.create(null);
        rows.forEach(function (row) {
            result[row.channelId] = row;
        });
        return result;
    }
    function apply(row: any, id: any, plan: Record<string, Binding>): void {
        if (row.epg_external) return;
        var binding = plan[channelId(row, id)];
        if (!binding) return;
        row.epg = binding.xmltvId;
        row.tn = "";
        row.xmltv_urls = [binding.feed];
        row.epg_manual = true;
    }
    function open(): void {
        if (!enabled()) {
            host.infoBox(host._("EPG unavailable: %1", "M3U / XMLTV"));
            return;
        }
        var id = (host.curList || [])[host.primaryIndex],
            row = (host.channels || {})[id];
        if (
            !row ||
            row.epg_external ||
            (row.epg_src && row.epg_src.charAt(0) === "=")
        ) {
            host.infoBox(host._("EPG unavailable: %1", "M3U / XMLTV"));
            return;
        }
        var expectedSource = source(),
            binding: Binding | null;
        try {
            binding = find(row, id);
        } catch (_) {
            host.infoBox(host._("Invalid setting"));
            return;
        }
        var feed = binding
            ? binding.feed
            : (row.xmltv_urls || [])[0] ||
              (host.__OTTPLAY_HOSTED__ && host.__OTTPLAY_HOSTED__.epg.source) ||
              "https://cdn.epg.one/epg2.xml.gz";
        var xmltvId = binding ? binding.xmltvId : String(row.epg || "");
        function current(): boolean {
            return (
                enabled() &&
                source() === expectedSource &&
                host.channels[id] === row
            );
        }
        function edit(
            caption: string,
            value: string,
            accept: (value: string) => void
        ): void {
            if (!current()) return;
            host.editCaption = caption;
            host.editvar = value;
            host.setEdit = function () {
                if (current()) accept(String(host.editvar).trim());
            };
            host.showEditKey2();
        }
        function menu(): void {
            if (!current()) return;
            var authority = /^https?:\/\/([^/?#]+)/i.exec(feed);
            var label = authority ? authority[1].replace(/^.*@/, "") : "—";
            host.showSelectBox(
                0,
                [
                    host._("EPG source: %1", label),
                    "XMLTV " + host._("ID") + ": " + xmltvId,
                    host._("Set"),
                    host._("Automatic"),
                    host._("Back"),
                ],
                function (index: number) {
                    if (!current()) return;
                    if (index === 0)
                        edit(
                            host._("EPG source: %1", "URL"),
                            feed,
                            function (value) {
                                feed = value;
                                host.setTimeout(menu, 0);
                            }
                        );
                    else if (index === 1)
                        edit(
                            "XMLTV " + host._("ID"),
                            xmltvId,
                            function (value) {
                                xmltvId = value;
                                host.setTimeout(menu, 0);
                            }
                        );
                    else if (index === 2 || index === 3) {
                        try {
                            save(
                                expectedSource,
                                row,
                                id,
                                index === 3
                                    ? null
                                    : {
                                          channelId: channelId(row, id),
                                          feed: feed,
                                          xmltvId: xmltvId,
                                      }
                            );
                        } catch (error) {
                            host.infoBox(
                                host._(
                                    (error as Error).message ===
                                        "Settings storage rejected write"
                                        ? "EPG local storage is unavailable or full."
                                        : "Invalid setting"
                                )
                            );
                            return;
                        }
                        host.loadChannels();
                    }
                },
                -1,
                true
            );
        }
        menu();
    }
    host.__ottGuideBindings = {
        apply: apply,
        enabled: enabled,
        find: find,
        open: open,
        prepare: prepare,
        save: save,
    };
})(window as any);
