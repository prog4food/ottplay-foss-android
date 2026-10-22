/** Lazy classic presentation adapter. Wire parsing and stream URLs stay in shared core. */
function mountXtreamMedia(host: any, driver: any, owner: DriverLifetime): void {
    var previous = host.providerMediaClient;
    if (previous && previous.xtream && previous.dispose) previous.dispose();
    var disposed = false,
        revision = 0;
    var pending: any = null;
    var source = host.__ottSourceIdentity.media(host);
    var credentials = JSON.stringify(driver.credentials());
    var rows: Record<string, any> = Object.create(null);
    function active(): boolean {
        return (
            !disposed &&
            owner.active() &&
            host.__ottActiveProviderDriver === driver &&
            credentials === JSON.stringify(driver.credentials()) &&
            source === host.__ottSourceIdentity.media(host)
        );
    }
    function cancel(): void {
        revision++;
        var previous = pending;
        pending = null;
        if (previous && previous.abort) previous.abort();
    }
    function client(): any {
        var config = driver.credentials();
        var base = host.OttPlayCore.xtreamBase(config.server);
        return new host.OttPlayCore.XtreamClient(
            {
                base: base,
                id: source,
                output: "m3u8",
                password: config.password,
                username: config.username,
            },
            false,
            function (path: string[], query: string[][]) {
                return (
                    base +
                    "/" +
                    path.map(encodeURIComponent).join("/") +
                    (query.length
                        ? "?" +
                          query
                              .map(function (pair) {
                                  return (
                                      encodeURIComponent(pair[0]) +
                                      "=" +
                                      encodeURIComponent(pair[1])
                                  );
                              })
                              .join("&")
                        : "")
                );
            },
            function (url: string) {
                return /^https?:\/\//i.test(url) ? url : "";
            },
            encodeURIComponent,
            function (parts: string[]) {
                return String(host.murmurhash3_32_gc(parts.join("\u0000"), 10));
            }
        );
    }
    function send(
        url: string,
        token: number,
        done: (data: any) => void,
        fail: () => void
    ): void {
        if (!active() || token !== revision) return;
        var finished = false;
        var request = host.$.ajax({
            dataType: "json",
            timeout: 15000,
            url: url,
        });
        request
            .done(function (data: any) {
                finished = true;
                if (pending === request) pending = null;
                if (active() && token === revision) done(data);
            })
            .fail(function () {
                finished = true;
                if (pending === request) pending = null;
                if (active() && token === revision) fail();
            });
        if (!finished && active() && token === revision) pending = request;
    }
    function present(item: any, kind: string, series?: string): any {
        var row: any = {
            adult: item.adult ? 1 : 0,
            itemId: item.id,
            logo_30x30: item.logo || "",
            request: { id: item.id, kind: kind, series: series || "" },
            title: item.name,
        };
        if (item.kind === "folder") {
            row.playlist_url = {
                adult: item.adult ? 1 : 0,
                kind: "episodes",
                name: item.name,
                series: item.seriesId,
            };
            delete row.request;
        } else {
            row.stream_url = item.url;
            rows[item.id] = row;
        }
        return row;
    }
    function browse(
        target: any,
        token: number,
        done: (records: any[]) => void,
        fail: () => void
    ): void {
        var api = client();
        if (target.kind === "episodes") {
            if (
                typeof target.series !== "string" ||
                !/^[0-9]{1,20}$/.test(target.series)
            )
                return fail();
            // Persisted routes are identities, never authority for parental access.
            // Refresh the parent before each browse/resolve; episodes inherit its policy.
            browse(
                { kind: "series" },
                token,
                function (series) {
                    var parents = series.filter(function (row) {
                        return (
                            row.playlist_url &&
                            row.playlist_url.series === target.series
                        );
                    });
                    if (parents.length !== 1) return fail();
                    var parent = {
                        adult: parents[0].adult === 1,
                        description: "",
                        folderType: "series",
                        logo: parents[0].logo_30x30,
                        name: parents[0].title,
                        seriesId: target.series,
                    };
                    var request = api.seriesRequest(parent);
                    if (!request || request.failure) return fail();
                    send(
                        request.url,
                        token,
                        function (response) {
                            var result = api.series(response, parent);
                            if (!result || result.failure) return fail();
                            var records: any[] = [];
                            Object.keys(result.episodes || {}).forEach(
                                function (season) {
                                    (result.episodes[season] || []).forEach(
                                        function (episode: any) {
                                            records.push(
                                                present(
                                                    episode,
                                                    "episodes",
                                                    target.series
                                                )
                                            );
                                        }
                                    );
                                }
                            );
                            done(records);
                        },
                        fail
                    );
                },
                fail
            );
            return;
        }
        if (target.kind !== "vod" && target.kind !== "series") return fail();
        function next(): void {
            if (!active() || token !== revision) return;
            var url = api.request();
            if (!url) {
                var result = api.catalog();
                if (!result || result.failure) return fail();
                return done(
                    result.channels
                        .filter(function (item: any) {
                            return item.kind !== "live";
                        })
                        .map(function (item: any) {
                            return present(item, target.kind);
                        })
                );
            }
            // Reuse the common protocol machine, fetching only the requested library.
            // Live data has already loaded through the independent TV driver.
            var action = /[?&]action=([^&]+)/.exec(url);
            if (
                action &&
                decodeURIComponent(action[1]).indexOf(
                    target.kind === "vod" ? "get_vod" : "get_series"
                ) !== 0
            ) {
                if (api.accept([])) return fail();
                next();
                return;
            }
            send(
                url,
                token,
                function (data) {
                    if (api.accept(data)) return fail();
                    next();
                },
                fail
            );
        }
        next();
    }
    var media = {
        cancel: cancel,
        dispose: function () {
            disposed = true;
            cancel();
            rows = Object.create(null);
        },
        load: function (target: any, done: any) {
            cancel();
            var token = revision;
            function deliver(records: any[]): void {
                if (
                    !active() ||
                    token !== revision ||
                    (done.isCurrent && !done.isCurrent())
                )
                    return;
                host.mediaRecords = records;
                host.mediaName =
                    (target && target.name) || host._("Media Library");
                done();
            }
            if (!target)
                return deliver([
                    {
                        itemId: "xtream:vod",
                        playlist_url: { kind: "vod", name: host._("Movies") },
                        title: host._("Movies"),
                    },
                    {
                        itemId: "xtream:series",
                        playlist_url: {
                            kind: "series",
                            name: host._("Series"),
                        },
                        title: host._("Series"),
                    },
                ]);
            browse(target, token, deliver, function () {
                deliver([]);
                if (active() && token === revision)
                    host.infoBox(host._("Failed to load!"));
            });
        },
        persist: function (item: any) {
            var saved: any = {
                adult: item.adult,
                itemId: item.itemId,
                title: item.title,
            };
            // Signed artwork and playback URLs stay out of durable history.
            var route = item.playlist_url;
            if (
                route &&
                route.kind === "episodes" &&
                typeof route.series === "string" &&
                /^[0-9]{1,20}$/.test(route.series)
            )
                saved.playlist_url = {
                    kind: "episodes",
                    name: item.title,
                    series: route.series,
                };
            var request = item.request;
            if (
                request &&
                ["vod", "episodes"].indexOf(request.kind) >= 0 &&
                typeof request.id === "string"
            )
                saved.request = {
                    id: request.id,
                    kind: request.kind,
                    series: request.kind === "episodes" ? request.series : "",
                };
            return saved;
        },
        resolve: function (item: any, done: any, automatic?: boolean) {
            cancel();
            var token = revision,
                request = item && item.request;
            function current(): boolean {
                return (
                    active() &&
                    token === revision &&
                    (!done.isCurrent || done.isCurrent())
                );
            }
            function locked(): boolean {
                return host.__ottParental
                    ? host.__ottParental.needs("channels")
                    : !!(
                          host.sPSchannels &&
                          host.parentPIN !== "*" &&
                          !host.parentAccess
                      );
            }
            if (
                !request ||
                ["vod", "episodes"].indexOf(request.kind) < 0 ||
                typeof request.id !== "string"
            )
                return done(null);
            // Resolve again after each selection so expired provider URLs are never replayed from history.
            delete rows[request.id];
            browse(
                { kind: request.kind, series: request.series },
                token,
                function () {
                    if (!current()) return;
                    var row = rows[request.id] || null;
                    // The library checks the cached row before resolve. Its refreshed
                    // policy can be stricter, so authorize again before handing over.
                    if (row && row.adult === 1 && locked()) {
                        if (
                            automatic ||
                            typeof host.enterPinAndSetAccess !== "function"
                        )
                            return done(null);
                        host.enterPinAndSetAccess(
                            function () {
                                if (current()) done(locked() ? null : row);
                            },
                            function () {
                                if (current()) done(null);
                            }
                        );
                    } else done(row);
                },
                function () {
                    if (current()) done(null);
                }
            );
        },
        stableRequests: true,
        xtream: true,
    };
    host.providerMediaClient = media;
    host.getMediaArray = media.load;
    owner.own(media.dispose);
}
(window as any).__ottXtreamMedia = { mount: mountXtreamMedia };
