/** Archive resolution is explicit and private to the authenticated controller.
 * Ordinary catalogue/guide queries never return playback URLs.
 */
export function handleRemoteArchive(
    host: any,
    request: any,
    channel: any,
    current: () => boolean,
    reply: (data: any) => void,
    reject: (message: string) => void
): void {
    var params = request.params;
    var row = (host.channels || {})[channel.id];
    var hours = Math.min(
        144,
        Math.max(0, Math.floor(Number(row && row.rec) || 0))
    );
    var now = Math.floor(Date.now() / 1000);
    if (
        !current() ||
        !isFinite(hours) ||
        !(hours > 0) ||
        typeof params.start !== "number" ||
        typeof params.end !== "number" ||
        !isFinite(params.start) ||
        !isFinite(params.end) ||
        Math.floor(params.start) !== params.start ||
        Math.floor(params.end) !== params.end ||
        params.start < now - hours * 3600 ||
        !(params.start > 0) ||
        !(params.start < params.end && params.end <= now) ||
        typeof params.title !== "string" ||
        !params.title.trim() ||
        params.title.length > 16384
    ) {
        reject(
            "The programme is outside this channel's available archive window."
        );
        return;
    }
    if (
        typeof host.getArchiveUrl !== "function" ||
        typeof host.ifParentalAccessChId !== "function" ||
        !Array.isArray(host.parentalArray)
    ) {
        reject("Archive playback is unavailable on this player.");
        return;
    }
    // Read-only archive checks must not open a PIN prompt. Unlock on the player
    // first; no deferred callback may start an old remote request afterwards.
    if (
        host.parentalArray.some(function (id: any) {
            return String(id) === String(channel.id);
        }) &&
        (!host.__ottParental || host.__ottParental.needs("channels"))
    ) {
        reject(
            "Unlock this channel on the player before searching its archive."
        );
        return;
    }
    var category = -1;
    var index = -1;
    for (var c = 0; c < (host.catsArray || []).length && category < 0; c++) {
        var list = host.cats[host.catsArray[c]] || [];
        for (var i = 0; i < list.length; i++) {
            if (String(list[i]) === String(channel.id)) {
                category = c;
                index = i;
                break;
            }
        }
    }
    if (category < 0) {
        reject("Channel is unavailable in the current categories.");
        return;
    }
    var programme = {
        descr: "",
        name: params.title,
        time: params.start,
        time_to: params.end,
    };
    var url: string;
    try {
        url = host.getArchiveUrl(
            channel.id,
            params.start,
            params.end,
            programme
        );
    } catch (_) {
        reject("The provider could not resolve this archive.");
        return;
    }
    if (!current() || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        reject("The provider has no HTTP archive for this programme.");
        return;
    }
    if (request.action === "resolve_archive") {
        // Only this dedicated RPC returns a private URL. The CLI probes it
        // locally; it must never forward it to the public EPG service or print it.
        reply({ resolved: true, url: url });
        return;
    }
    if (
        !host.__ottClassicArchive ||
        typeof host.__ottClassicArchive.open !== "function" ||
        typeof host.setCurrent !== "function"
    ) {
        reject("Update the player to support remote archive playback.");
        return;
    }
    if (host.ifParentalAccessChId(channel.id, function () {}) || !current()) {
        reject("Channel access or the catalogue changed before playback.");
        return;
    }
    host.setCurrent(category, index, true);
    // Supply the selected programme, not the previous channel's guide. The
    // archive controller owns decoder replacement and later guide refills.
    host.epgArray = [programme];
    host.__ottClassicArchive.open(params.start);
    reply({
        channel: channel,
        dispatched: true,
        end: params.end,
        start: params.start,
    });
}
