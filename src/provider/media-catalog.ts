/** Owned media navigation. Native XML decoding is a port; core owns operator envelopes. */
interface MediaCatalogRequest {
    mac?: string;
    name?: string;
    profile: string;
    url: string;
}
interface MediaCatalogResult {
    detail?: string;
    error?: string;
    name?: string;
    records?: any[];
    status?: any;
    url: string;
}
function createOwnedMediaCatalog(
    ports: any,
    owner: DriverLifetime,
    helpers: any
) {
    var disposed = false;
    var navigation = ports.createLifetime();
    function active() {
        return !disposed && owner.active();
    }
    var transport = helpers.transport(ports, owner, active);
    function detach(value: any): any {
        if (!value || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(detach);
        var result: any = {};
        Object.keys(value).forEach(function (key) {
            Object.defineProperty(result, key, {
                configurable: true,
                enumerable: true,
                value: detach(value[key]),
                writable: true,
            });
        });
        return result;
    }
    function escape(value: any): string {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
    function playlist(profile: string, text: string, name?: string): any {
        return {
            name: name || "?",
            records: ports.core.parsePlaylistMedia(text).map(function (
                entry: any
            ) {
                var title = entry.generatedName
                    ? profile === "kb-team"
                        ? ports.translate("??? No channel name")
                        : ports.translate("Untitled")
                    : entry.name;
                var logo =
                    typeof entry.logo === "string" &&
                    !/[\x00-\x1f]/.test(entry.logo) &&
                    (!/^[a-z][a-z0-9+.-]*:/i.test(entry.logo.trim()) ||
                        /^https?:/i.test(entry.logo.trim()))
                        ? entry.logo
                        : "";
                var record: any = {
                    description:
                        "<table><h2><center>" +
                        escape(title) +
                        "</center></h2>" +
                        (logo
                            ? '<img id="detal" height="285" src="' +
                              escape(logo) +
                              '" style="float: left; margin-right: 5px; margin-bottom: 5px; border-width: 0px; border-style: solid;" width="210">'
                            : "") +
                        "</table>",
                    logo_30x30: entry.logo,
                    stream_url: entry.url,
                    title: title,
                };
                if (entry.generatedName)
                    record.__ottMediaLabel = {
                        heading: true,
                        key:
                            profile === "kb-team"
                                ? "??? No channel name"
                                : "Untitled",
                        value: title,
                    };
                return record;
            }),
        };
    }
    function duneCatalog(data: any, previous?: string): any {
        var records: any[] = [];
        if (!data || typeof data !== "object")
            throw new Error("Invalid media catalog");
        Object.keys(data).forEach(function (key) {
            if (
                (key === "menu" || key === "channels") &&
                Array.isArray(data[key])
            )
                data[key].forEach(function (row: any) {
                    if (!row || typeof row !== "object") return;
                    // JSON.parse owns these rows; detach once at delivery.
                    row.t = key === "menu" ? "menu" : "channel";
                    records.push(row);
                });
        });
        if (data.next_page_url)
            records.push({
                description: "...",
                logo_30x30: "",
                playlist_url: data.next_page_url,
                title: "...",
            });
        return {
            name: data.playlist_name || data.title || previous || "?",
            records: records,
        };
    }
    var result = {
        cancel: function () {
            navigation.dispose();
        },
        dispose: function () {
            if (disposed) return;
            disposed = true;
            navigation.dispose();
            transport.dispose();
        },
        load: function (
            request: MediaCatalogRequest,
            callback: (result: MediaCatalogResult) => void
        ): () => void {
            if (!active()) return function () {};
            request = {
                mac: request.mac,
                name: request.name,
                profile: request.profile,
                url: request.url,
            };
            var scope = navigation.activate("media");
            if (!active() || !scope.active()) return function () {};
            var url = request.url;
            if (!url) {
                callback({ url: url });
                return scope.dispose;
            }
            var routed = ports.core.operatorVodUrl(
                request.profile === "m3u" ? "antifriz" : request.profile,
                url,
                request.mac || ""
            );
            transport.send(
                scope,
                { dataType: "text", timeout: 60000, url: routed },
                function (text: any) {
                    var decoded: any,
                        stage = "json";
                    var header =
                        request.profile === "m3u"
                            ? String(text).slice(0, 16)
                            : null;
                    if (header !== null && header.length < 7) {
                        callback({ error: "length", url: url });
                        return;
                    }
                    var format =
                        header === null
                            ? ""
                            : header[0] === "<"
                              ? "XML"
                              : header.indexOf("#EXTM3U") >= 0
                                ? "M3U"
                                : header[0] === "{"
                                  ? "JSON"
                                  : "";
                    if (header !== null && !format) {
                        callback({ detail: header, error: "header", url: url });
                        return;
                    }
                    try {
                        var content: any;
                        if (request.profile === "m3u") {
                            content = { format: format, text: text };
                        } else
                            content = ports.core.operatorVodContent(
                                String(text)
                            );
                        stage = content.format.toLowerCase();
                        if (content.format === "M3U")
                            decoded = playlist(
                                request.profile,
                                content.text,
                                request.name
                            );
                        else {
                            var value =
                                content.format === "XML"
                                    ? ports.decodeXml(
                                          content.text,
                                          request.profile
                                      )
                                    : JSON.parse(content.text);
                            if (
                                request.profile === "m3u" &&
                                content.format === "XML"
                            ) {
                                // The native fXML codec already labels channel/menu rows.
                                decoded = {
                                    name:
                                        value.playlist_name ||
                                        value.title ||
                                        request.name ||
                                        "?",
                                    records: (value.channels || []).map(
                                        function (item: any) {
                                            var record = detach(item);
                                            if (!record.title) {
                                                record.title =
                                                    ports.translate("Untitled");
                                                record.__ottMediaLabel = {
                                                    key: "Untitled",
                                                    value: record.title,
                                                };
                                            }
                                            return record;
                                        }
                                    ),
                                };
                                if (value.next_page_url)
                                    decoded.records = decoded.records.concat([
                                        {
                                            description: "...",
                                            logo_30x30: "",
                                            playlist_url: value.next_page_url,
                                            title: "...",
                                        },
                                    ]);
                            } else {
                                stage = "catalog";
                                decoded =
                                    request.profile === "m3u"
                                        ? duneCatalog(value, request.name)
                                        : ports.core.operatorVodCatalog(
                                              value,
                                              request.name
                                          );
                            }
                        }
                    } catch (error) {
                        if (active() && scope.active())
                            callback({
                                detail:
                                    error instanceof Error
                                        ? error.message
                                        : String(error),
                                error: stage,
                                url: url,
                            });
                        return;
                    }
                    if (active() && scope.active())
                        callback({
                            name: decoded.name,
                            records: detach(decoded.records),
                            url: url,
                        });
                },
                function (xhr: any) {
                    callback({
                        error: "network",
                        status: xhr && xhr.status,
                        url: url,
                    });
                }
            );
            return scope.dispose;
        },
    };
    owner.own(result.dispose);
    return result;
}
(window as any).__ottMediaCatalog = { create: createOwnedMediaCatalog };
