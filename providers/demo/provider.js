/* Shared HTTPS demo provider. Keep this classic script ES5-compatible. */
(function (w) {
    var mediaBase = "https://liminal-sketch-vv8r.here.now/demo/";
    var generation = {};
    w._ottplayDemoGeneration = generation;
    w.ottplayDemoActive = true;
    w.p_pref = "demo";

    // Demo never borrows M3U credentials or playlists, including after a live
    // provider switch. All persisted demo choices have their own prefix.
    w.providerGetItem = function (key) {
        return w.stbGetItem("demo" + key);
    };
    w.providerSetItem = function (key, value) {
        w.stbSetItem("demo" + key, value);
    };
    w.providerDelItem = function (key) {
        return w.stbDelItem("demo" + key);
    };
    w.providerHasItem = function (key) {
        var value = w.providerGetItem(key);
        return value !== null && value !== undefined;
    };
    w.providerHasItemValue = function (key) {
        var value = w.providerGetItem(key);
        return value !== null && value !== undefined && value !== "";
    };
    w.duneAddSettings = function () {};
    w.getMediaArray = null;
    w.getChannelUrl = function (id) {
        return w.chanels[id] ? w.chanels[id].url : "";
    };
    w.getChannelPicon = function () {
        return "";
    };
    w.getArchiveUrl = function () {
        return "";
    };
    w.getEPGchanel = function (id, callback) {
        callback(id, []);
    };
    w.getChanelsArray = function (callback) {
        if (
            w.ottplayDemoActive !== true ||
            w._ottplayDemoGeneration !== generation
        )
            return;
        var title = "Demo — moving test pattern";
        if (typeof w._ === "function") title = w._(title);
        var names = [title + " (MP4)", title + " (HLS)"];
        var files = ["pattern.mp4", "pattern.m3u8"];
        for (var i = 0; i < files.length; i++) {
            var id = 900000001 + i;
            if (w.cList.indexOf(id) === -1) w.cList.push(id);
            w.chanels[id] = {
                category: { class: 2, name: "Demo" },
                channel_name: names[i],
                logo: "",
                rec: 0,
                time: 0,
                time_to: 0,
                url: mediaBase + files[i],
            };
        }
        callback();
    };
})(window);
