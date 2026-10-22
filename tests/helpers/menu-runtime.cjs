const assert = require("node:assert/strict");

module.exports = function assertMenuRuntime(registry) {
    let playbackReads = 0;
    let playing = true;
    let receiver;
    const host = {
        channels: { news: { rec: 1 } },
        curList: ["news"],
        keys: {},
        optionsList() {
            receiver = this;
        },
        p_pref: "custom",
        pipIndex: null,
        playType: 0,
        popPause() {},
        popStop() {},
        popTogglePip() {},
        primaryIndex: 0,
        sHideMenus: [],
        sNoColorKeys: 1,
        sNoNumbersKeys: 1,
        stbIsPlaying() {
            playbackReads++;
            return playing;
        },
    };
    function dealerSettings() {
        receiver = this;
    }
    host.popupActions = [
        host.optionsList,
        host.popPause,
        host.popStop,
        host.popTogglePip,
        dealerSettings,
    ];
    host.popupArray = [
        "Settings",
        "Paused / Playing",
        "Restart / Live",
        "Create PiP / Swap PiP",
        "Dealer / unchanged",
    ];
    host.popupDetail = ["", "", "", "", "External settings"];

    function open() {
        playbackReads = 0;
        return registry.open(host, "provider:custom:4");
    }
    function label(menu, id) {
        return menu.rows.find((row) => row.id === id)?.name;
    }
    let menu = open();
    assert.equal(playbackReads, 1, "query playback only for its toggle row");
    assert.equal(label(menu, "playback.toggle"), "Playing");
    assert.equal(label(menu, "playback.live"), "Restart");
    assert.equal(label(menu, "pip.toggle"), "Create PiP");
    assert.equal(label(menu, "provider:custom:4"), "Dealer / unchanged");
    assert.equal(menu.focus, 4);
    menu.invoke("provider:custom:4");
    assert.equal(
        receiver,
        menu.records[4],
        "retain provider callback receiver"
    );
    assert.equal(receiver.detail, "External settings");

    playing = false;
    host.playType = 100;
    host.pipIndex = 0;
    menu = open();
    assert.equal(playbackReads, 1);
    assert.equal(label(menu, "playback.toggle"), "Paused");
    assert.equal(label(menu, "playback.live"), "Live");
    assert.equal(label(menu, "pip.toggle"), "Swap PiP");

    let language = {
        "External settings": "Externe Einstellungen",
        Live: "Direkt",
        Paused: "Pausiert",
        "Paused / Playing": "Pausiert / Wiedergabe",
        Settings: "Einstellungen",
        "Swap PiP": "PiP tauschen",
    };
    const translationKeys = [];
    host._ = function (key) {
        translationKeys.push(key);
        return language[key] || key;
    };
    host.sNoNumbersKeys = 0;
    host.strTools = "TOOLS";
    menu = open();
    assert.equal(
        label(menu, "settings.open"),
        '<div class="btn">TOOLS</div> <div class="btn">9</div> Einstellungen',
        "translate the raw title before adding remote button markup"
    );
    assert.equal(label(menu, "playback.toggle"), "Pausiert");
    assert.equal(
        label(menu, "playback.live"),
        '<div class="btn">7</div> Direkt'
    );
    assert.equal(
        label(menu, "pip.toggle"),
        '<div class="btn">5</div> PiP tauschen'
    );
    assert.equal(menu.rows[4].desc, "Externe Einstellungen");
    assert.equal(menu.rows[1].desc, "Pausiert / Wiedergabe");
    assert.ok(!translationKeys.some((key) => key.includes('<div class="btn')));
    assert.equal(menu.records[0].title, "Settings");
    assert.equal(menu.records[4].detail, "External settings");
    assert.equal(
        menu.focus,
        4,
        "localization must not affect command identity"
    );

    language = {
        "Create PiP": "Ouvrir PiP",
        "External settings": "Paramètres externes",
        Playing: "Lecture",
        Restart: "Redémarrer",
        Settings: "Paramètres",
    };
    playing = true;
    host.playType = 0;
    host.pipIndex = null;
    menu = open();
    assert.equal(
        label(menu, "settings.open"),
        '<div class="btn">TOOLS</div> <div class="btn">9</div> Paramètres',
        "reopening resolves the new language without rebuilding provider arrays"
    );
    assert.equal(label(menu, "playback.toggle"), "Lecture");
    assert.equal(
        label(menu, "playback.live"),
        '<div class="btn">7</div> Redémarrer'
    );
    assert.equal(
        label(menu, "pip.toggle"),
        '<div class="btn">5</div> Ouvrir PiP'
    );
    assert.equal(menu.rows[4].desc, "Paramètres externes");
    delete host._;
    delete host.strTools;
    host.sNoNumbersKeys = 1;

    for (const hidden of ["playback.toggle", "popPause"]) {
        host.sHideMenus = [hidden];
        menu = open();
        assert.equal(label(menu, "playback.toggle"), undefined);
        assert.equal(playbackReads, 0, "hidden toggle needs no playback query");
    }
    host.sHideMenus = [];
    host.playType = 0;
    host.channels.news.rec = 0;
    menu = open();
    assert.equal(label(menu, "playback.toggle"), undefined);
    assert.equal(
        playbackReads,
        0,
        "unavailable toggle needs no playback query"
    );

    const bindings = [
        ["ZOOM", "video.zoom"],
        ["ASPECT", "video.aspect"],
        ["N0", "app.exit"],
        ["N1", "audio.track"],
        ["AUDIO", "audio.track"],
        ["N2", "information.open"],
        ["N3", "channel.previous"],
        ["N4", "archive.seek"],
        ["N5", "pip.toggle"],
        ["N6", "pip.close"],
        ["N7", "playback.live"],
        ["N8", "app.restart"],
        ["N9", "settings.open"],
        ["TOOLS", "settings.open"],
        ["SUBTITLE", "subtitle.track"],
        ["EPG", "guide.open"],
        ["RED", "guide.open"],
        ["GREEN", "archive.records"],
        ["YELLOW", "media.open"],
        ["BLUE", "channels.categories"],
        ["PREV", "channels.categories"],
    ];
    for (let index = 0; index < bindings.length; index++) {
        const [key, command] = bindings[index];
        host.keys[key] = index + 1;
        assert.equal(menu.command(index + 1), command);
    }
    host.keys = { ASPECT: 55, ZOOM: 55 };
    assert.equal(
        menu.command(55),
        "video.zoom",
        "first alias wins a collision"
    );
    host.keys.ZOOM = 0;
    assert.equal(menu.command(55), "video.aspect");
    assert.equal(
        menu.command(0),
        "",
        "zero-valued device keys remain disabled"
    );
    host.keys = { BLUE: 78, PREV: 77 };
    assert.equal(menu.command(77), "channels.categories");
    assert.equal(menu.command(78), "channels.categories");
    assert.equal(menu.command(99), "");

    host.popupActions.push(host.optionsList);
    host.popupArray.push("Duplicate settings action");
    menu = open();
    menu.invoke("settings.open");
    assert.equal(receiver, menu.records[0], "first imported matching ID wins");
    receiver = null;
    menu.invoke("missing");
    assert.equal(receiver, null);

    host.popupActions = [dealerSettings];
    host.popupArray = ["External only"];
    host.stbIsPlaying = function () {
        throw new Error("unrelated external menu must not inspect playback");
    };
    assert.equal(open().rows[0].name, "External only");

    host.popBuckets = function () {};
    host.popupActions = [host.popBuckets];
    host.popupArray = ["Category selection"];
    host.popupDetail = [];
    host.sNoColorKeys = 0;
    host._ = (key) =>
        key === "Category selection" ? "Choix de catégorie" : key;
    menu = open();
    assert.equal(
        menu.rows[0].name,
        '<div class="btn blue">&nbsp;</div> Choix de catégorie'
    );
    assert.equal(menu.rows[0].desc, "Choix de catégorie");
};
