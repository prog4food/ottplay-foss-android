/** Search owns its editor intent and stable group/channel targets, never positions. */
declare function normalizeSearchText(value: string): string;
function createClassicChannelSearch(host: any) {
    var sequence = 0;
    var pending: any = null;
    function cancelPlay(): void {
        if (pending) host.clearTimeout(pending.timer);
        pending = null;
    }
    function open(): void {
        cancelPlay();
        var request = ++sequence;
        var port = host.__ottClassicScreenPort;
        var parent = port.listOwner();
        var catalog = host.__ottChannels.capture(host.listCatIndex);
        if (!parent || !parent.active() || !catalog) return;
        var returnId = catalog.members()[host.listChannel];
        var editor: any = null;
        var submitted = false;
        function current(): boolean {
            return catalog.active();
        }
        function canPublish(): boolean {
            return (
                request === sequence &&
                current() &&
                parent.active() &&
                (!editor || port.acceptsEditorSave(editor)) &&
                catalog.category() >= 0
            );
        }
        function hint(
            code: number,
            symbol: string,
            title: string,
            extra?: string,
            alternate?: string
        ): string {
            return typeof host.renderButtonHint === "function"
                ? host.renderButtonHint(code, symbol, title, extra, alternate)
                : "";
        }
        function publish(query: string): void {
            var lower = normalizeSearchText(query);
            var rows: number[] = [];
            var owner: any = null;
            function visible(): boolean {
                return (
                    current() &&
                    owner &&
                    owner.foreground() &&
                    host.listArray === rows
                );
            }
            function play(id: number): void {
                var position = catalog.position(id);
                if (!visible() || !position) return;
                if (
                    host.ifParentalAccessChId(id, function () {
                        play(id);
                    })
                )
                    return;
                position = catalog.position(id);
                if (!visible() || !position) return;
                var preview = host.sPreview;
                if (
                    preview == 2 &&
                    (!host.previewChan || host.previewChan.ch_id != id)
                ) {
                    host.previewChId(id);
                    return;
                }
                var keep =
                    preview == 1 ||
                    preview == 2 ||
                    (host.catIndex === position[0] &&
                        host.primaryIndex === position[1] &&
                        !host.playType);
                host.previewChan = null;
                var before = port.screens.revision();
                host.closeList();
                // A cleanup can synchronously replace the screen, even briefly.
                var revision = port.screens.revision();
                if (
                    !current() ||
                    revision !== before + 1 ||
                    port.screens.current()
                )
                    return;
                var intent = port.revision();
                function accepted(): boolean {
                    return current() && port.revision() === intent;
                }
                if (keep) {
                    position = catalog.position(id);
                    if (!position) return;
                    host.setCurrent(position[0], position[1]);
                    if (!accepted()) return;
                    host.updateChannelInfo(id);
                    if (!accepted()) return;
                    if (host.sInfoSwitch) host.showChannelInfo(1);
                    if (accepted()) host.playType = 0;
                    return;
                }
                cancelPlay();
                var action: any = {};
                pending = action;
                action.timer = host.setTimeout(function () {
                    if (pending !== action) return;
                    pending = null;
                    var position = accepted() && catalog.position(id);
                    // The normal playback entry point rechecks current parental policy.
                    if (position) host.playChannel(position[0], position[1]);
                }, 10);
            }
            function back(): void {
                var position = catalog.position(returnId);
                var category = catalog.category();
                if (category >= 0)
                    host.channelsList(category, position ? position[1] : 0);
                else host.closeList();
            }
            function handle(key: number): boolean {
                if (!visible()) return true;
                var keys = host.keys;
                var id = rows[host.selIndex];
                if (
                    keys.RANDOM &&
                    key === keys.RANDOM &&
                    /^pc(?:2)?$/.test(host.ott_device || "")
                ) {
                    var playing =
                        host.curList && host.curList[host.primaryIndex];
                    var choices = rows.filter(function (candidate: number) {
                        return candidate !== playing;
                    });
                    if (choices.length)
                        play(
                            choices[Math.floor(Math.random() * choices.length)]
                        );
                    return true;
                }
                if (key === keys.EXIT) {
                    host.closeList();
                    return true;
                }
                if (
                    key === keys.RETURN ||
                    (key === keys.LEFT && host.sArrowFun == 2) ||
                    (key === keys.RW && host.sRewFun == 1) ||
                    (key === keys.PREV && host.sPNFun == 1)
                ) {
                    back();
                    return true;
                }
                if (key === keys.RIGHT && host.sArrowFun == 2) return true;
                if (
                    key === keys.N0 ||
                    key === keys.YELLOW ||
                    key === keys.TOOLS
                ) {
                    open();
                    return true;
                }
                if (key === keys.ENTER) {
                    play(id);
                    return true;
                }
                if (
                    key === keys.N2 ||
                    key === keys.INFO ||
                    (key === keys.FF && host.sRewFun == 1) ||
                    (key === keys.NEXT && host.sPNFun == 1)
                ) {
                    if (catalog.position(id))
                        host.showProgramInfo(host.channels[id].name);
                    return true;
                }
                if (
                    key === keys.GREEN ||
                    key === keys.PLAY ||
                    key === keys.PAUSE ||
                    key === keys.N3
                ) {
                    var position = catalog.position(id);
                    if (position) {
                        host.listCatIndex = position[0];
                        host.addChannel2bucket(function (
                            admitted: () => boolean
                        ) {
                            render(id, admitted);
                        });
                    }
                    return true;
                }
                return false;
            }
            function render(
                selected: number | undefined,
                admitted: () => boolean
            ): void {
                rows = catalog.members().filter(function (id: number) {
                    var row = host.channels[id];
                    return (
                        row &&
                        typeof row.channel_name === "string" &&
                        normalizeSearchText(row.channel_name).indexOf(lower) >=
                            0
                    );
                });
                var keys = host.keys;
                var caption =
                    host._("Search") + ':"' + query + '" (' + rows.length + ")";
                var footer =
                    hint(
                        keys.RETURN,
                        host.strRETURN,
                        "Close",
                        host.sArrowFun == 2
                            ? host.strLEFT
                            : host.sRewFun == 1
                              ? host.strRW
                              : host.sPNFun == 1
                                ? host.strPREV
                                : ""
                    ) +
                    hint(
                        keys.N2,
                        host.strInfo,
                        "Description",
                        "2",
                        host.sArrowFun == 2
                            ? host.strRIGHT
                            : host.sRewFun == 1
                              ? host.strFF
                              : host.sPNFun == 1
                                ? host.strNEXT
                                : ""
                    ) +
                    hint(keys.YELLOW, "", "Search", host.strTools, "0") +
                    hint(
                        keys.GREEN,
                        "",
                        "Add channel to " +
                            (host.sFavorites ? "favorites" : "category"),
                        host.strPlayPause,
                        "3"
                    );
                if (!current() || !admitted() || catalog.category() < 0) return;
                host.listArray = rows;
                host.listDataArray = rows;
                host.selIndex = Math.max(0, rows.indexOf(selected!));
                host.listCatIndex = catalog.category();
                host.listKeyHandler = port.ownListHandler(handle);
                var element = host.document.getElementById("listCaption");
                if (element) element.textContent = caption;
                element = host.document.getElementById("listPodval");
                if (element) element.innerHTML = footer;
                host.$("#listPopUp").hide();
                host.$("#listEdit").hide();
                host.showPage();
                owner = port.listOwner();
            }
            render(undefined, canPublish);
        }
        var caption = host._("String for search");
        var saved = host.stbGetItem("chSearch") || "";
        if (!canPublish()) return;
        host.$("#listPopUp").hide();
        host.editCaption = caption;
        host.editvar = saved;
        var save = function () {
            if (submitted || !canPublish() || !port.acceptsEditorSave(editor))
                return;
            var input = host.document.getElementById("editvar");
            var query = (input && input.value) || host.editvar || "";
            if (!query || !canPublish()) return;
            submitted = true;
            host.editvar = query;
            host.stbSetItem("chSearch", query);
            if (canPublish()) publish(query);
        };
        host.setEdit = save;
        if (!canPublish()) return;
        host.showEditKey();
        editor = port.owner("editor");
        if (editor && editor.model.save !== save) editor = null;
    }
    return { open: open };
}
(window as any).__ottChannelSearch = createClassicChannelSearch(window);
