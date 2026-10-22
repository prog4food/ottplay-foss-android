declare function textBoundary(
    value: string,
    position: number,
    direction: number
): number;

/** The only mutable classic ABI. Its fields project the current owned screen. */
function createClassicScreenPort(host: any) {
    var screens = host.__ottScreenController.create();
    var list: any = {
        detail: null,
        focus: 0,
        handler: null,
        items: [],
        render: null,
        rows: [],
    };
    var listOwner: ScreenOwner | null = null;
    var committedHandler: any = null;
    var committedRows: any = null;
    var overlays: { [kind: string]: ScreenOwner | null } = {};
    var callbacks: any = {};
    var panelStack: Array<{
        owner: ScreenOwner | null;
        release?: (() => void) | null;
        value: any;
    }> = [];
    var pendingListBindings: Array<{
        callback: any;
        owner: ScreenOwner | null;
    }> = [];
    var editorSave: any = null;
    var committingEditor: ScreenOwner | null = null;
    var editorState = { caption: "", cursor: 0, value: "" };
    var visibleList = false;
    var intent = 0;
    var replacingKind = "";
    var mainInput: ((command: ScreenCommand) => void) | null = null;
    var keyEvent: any = null;
    function call(name: string, value?: any) {
        if (typeof host[name] === "function") return host[name](value);
    }
    function listInput(
        command: ScreenCommand,
        owner: ScreenOwner,
        callback: any
    ) {
        var direction =
            command.id === "left" ? -1 : command.id === "right" ? 1 : 0;
        if (direction && host.sArrowFun === 1) {
            call("changeVolume", direction * (host.sVolumeStep || 5));
            return;
        }
        if (typeof callback === "function" && callback(command.code)) return;
        if (!owner.foreground()) return;
        var page = host.listPageSize || host.pageSize || 25;
        var steps: any = {
            "channel-down": page,
            "channel-up": -page,
            down: 1,
            forward: page,
            left: -page,
            next: host.sPNFun === 3 ? list.items.length - list.focus - 1 : page,
            previous: host.sPNFun === 3 ? -list.focus : -page,
            rewind: -page,
            right: page,
            up: -1,
        };
        if (command.id === "exit") call("closeList");
        else if (steps[command.id] !== undefined)
            call("changeSelect", steps[command.id]);
    }
    function editorInput(command: ScreenCommand) {
        var key = command.event && command.event.key;
        if (command.text || key === "Backspace" || key === "Delete") {
            var value = String(host.editvar || "");
            var start = textBoundary(
                value,
                host.editPos === undefined ? value.length : host.editPos,
                0
            );
            var end = start;
            var text = command.text || "";
            if (!text) {
                if (key === "Backspace") start = textBoundary(value, start, -1);
                else end = textBoundary(value, end, 1);
            }
            host.editvar = value.slice(0, start) + text + value.slice(end);
            host.editPos = textBoundary(host.editvar, start + text.length, 0);
            call("_changeEdit");
        } else if (typeof host.editKey === "function") {
            var editor = overlays.editor;
            var nativeInput =
                editor && editor.model.nativeInputSecret !== undefined;
            (nativeInput && host.editKey === host.editKey1
                ? host.editKey2
                : host.editKey)(command.code);
        }
    }
    function visible(selector: string): boolean {
        try {
            return !!host.$ && host.$(selector).is(":visible");
        } catch (_) {
            return false;
        }
    }
    function close(kind: string) {
        var previous = overlays[kind];
        var parent = previous && previous.model.parent;
        var restore =
            parent && parent.kind === kind && parent.active() ? parent : null;
        overlays[kind] = restore;
        callbacks[kind] = restore ? restore.model.callback : null;
        if (kind === "editor")
            editorState = {
                caption: editorState.caption,
                cursor: editorState.cursor,
                value: editorState.value,
            };
        if (previous) previous.close();
    }
    function openOverlay(
        kind: string,
        handler: (command: ScreenCommand, owner: ScreenOwner) => void
    ) {
        var request = ++intent;
        var previousReplacement = replacingKind;
        replacingKind = kind;
        var previous = overlays[kind];
        var snapshot = panelStack[panelStack.length - 1];
        var nested =
            kind === "about" &&
            previous &&
            previous.active() &&
            snapshot &&
            snapshot.owner === previous;
        if (!nested) close(kind);
        replacingKind = previousReplacement;
        if (request !== intent) {
            var abandoned = screens.open({
                handle: function () {},
                kind: kind,
            });
            abandoned.close();
            return abandoned;
        }
        var parent = screens.current();
        var owner: ScreenOwner = screens.open({
            handle: handler,
            kind: kind,
            priority: { about: 20, dialog: 50, editor: 30, picker: 40 }[kind],
        });
        overlays[kind] = owner;
        owner.model.parent = parent;
        owner.own(function () {
            if (
                replacingKind === kind ||
                (overlays[kind] && overlays[kind] !== owner)
            )
                return;
            var selector = {
                about: "#listAbout",
                dialog: "#dialogbox",
                editor: "#listEdit",
                picker: "#numprog",
            }[kind];
            if (selector && host.$) host.$(selector).hide();
        });
        if (parent) {
            var detach = parent.own(function () {
                if (overlays[kind] === owner) {
                    overlays[kind] = null;
                    callbacks[kind] = null;
                }
                owner.close();
            });
            owner.own(detach);
        }
        return owner;
    }
    function setCallback(kind: string, callback: any) {
        var snapshot = panelStack[panelStack.length - 1];
        if (
            snapshot &&
            snapshot.owner &&
            snapshot.owner.active() &&
            snapshot.owner.kind === kind &&
            snapshot.owner.model.callback === callback
        ) {
            if (overlays[kind] !== snapshot.owner) close(kind);
            return snapshot.owner;
        }
        if (
            callbacks[kind] === callback &&
            overlays[kind] &&
            overlays[kind]!.active()
        )
            return overlays[kind];
        if (typeof callback !== "function") {
            close(kind);
            return null;
        }
        var next = openOverlay(kind, function (command, owner) {
            var result = owner.model.callback(command.code);
            if (!owner.foreground()) return;
            if (
                kind === "about" &&
                !result &&
                /^(accept|back|exit)$/.test(command.id)
            ) {
                host.$("#listAbout").text("").hide();
                close("about");
                if (host.restoreListPanelState) host.restoreListPanelState();
                if (host.showPage) host.showPage();
            }
        });
        if (next.active()) {
            callbacks[kind] = callback;
            next.model.callback = callback;
        }
        return next;
    }
    function commitList(): ScreenOwner {
        visibleList = true;
        if (
            listOwner &&
            listOwner.active() &&
            listOwner.model === list &&
            committedHandler === list.handler &&
            committedRows === list.rows
        )
            return listOwner;
        var request = ++intent;
        var previous = listOwner;
        listOwner = null;
        // Cleanup may synchronously install a different screen. Respect that newer intent.
        var before = screens.revision();
        if (previous) previous.close();
        var afterCleanup = listOwner as ScreenOwner | null;
        if (afterCleanup && afterCleanup.active()) return afterCleanup;
        if (request !== intent) {
            var abandoned = screens.open({
                handle: function () {},
                kind: "list",
            });
            abandoned.close();
            return abandoned;
        }
        if (
            screens.revision() >
            before + (previous && previous.active() === false ? 1 : 0)
        ) {
            var replacement = screens.current();
            if (replacement && replacement.kind === "list") return replacement;
        }
        committedHandler = list.handler;
        committedRows = list.rows;
        var callback = list.handler;
        listOwner = screens.open({
            handle: function (command, owner) {
                listInput(command, owner, callback);
            },
            kind: "list",
            model: list,
        });
        pendingListBindings.forEach(function (binding) {
            if (binding.callback === callback) binding.owner = listOwner;
        });
        pendingListBindings = [];
        return listOwner!;
    }
    function closeList() {
        intent++;
        visibleList = false;
        var previous = listOwner;
        listOwner = null;
        if (previous) previous.close();
    }
    function openEditor() {
        var save = editorSave;
        var owner = openOverlay("editor", function (command, current) {
            editorInput(command);
        });
        owner.model.save = save;
        owner.model.state = editorState;
        return owner;
    }
    function finishEditor(save: boolean, cleanup: () => void) {
        var owner = overlays.editor;
        if (!owner || !owner.foreground()) return;
        var callback = owner.model.save;
        // Retire input first. Legacy transfer callbacks collect the value before
        // restorePanel commits it; a callback opening another screen owns teardown.
        close("editor");
        var before = screens.revision();
        var previousCommit = committingEditor;
        committingEditor = save ? owner : null;
        try {
            if (save && typeof callback === "function") callback();
        } finally {
            committingEditor = previousCommit;
        }
        if (before === screens.revision()) cleanup();
    }
    function invalidate() {
        intent++;
        listOwner = null;
        overlays = {};
        callbacks = {};
        panelStack = [];
        visibleList = false;
        editorSave = null;
        screens.invalidate();
    }
    function bind(name: string, read: () => any, write: (value: any) => void) {
        var initial = host[name];
        Object.defineProperty(host, name, {
            configurable: true,
            enumerable: true,
            get: read,
            set: write,
        });
        if (initial !== undefined) write(initial);
    }
    var fields: any = {
        detailListAction: "detail",
        detailListActionFn: "detail",
        getListItem: "render",
        getListItemFn: "render",
        listArray: "items",
        listDataArray: "rows",
        listKeyHandler: "handler",
        listKeyHandlerFn: "handler",
        selIndex: "focus",
    };
    Object.keys(fields).forEach(function (name) {
        var field = fields[name];
        bind(
            name,
            function () {
                return list[field];
            },
            function (value) {
                if (
                    listOwner &&
                    listOwner.model === list &&
                    list[field] !== value &&
                    /^(handler|items|rows)$/.test(field)
                ) {
                    var next: any = {};
                    Object.keys(list).forEach(function (key) {
                        next[key] = list[key];
                    });
                    list = next;
                }
                list[field] = value;
            }
        );
    });
    [
        ["dialogBoxKeyHandler", "dialog"],
        ["aboutKeyHandler", "about"],
        ["selectBoxKeyHandler", "picker"],
    ].forEach(function (pair) {
        bind(
            pair[0],
            function () {
                return callbacks[pair[1]] || null;
            },
            function (callback) {
                setCallback(pair[1], callback);
            }
        );
    });
    bind(
        "setEdit",
        function () {
            return editorSave;
        },
        function (callback) {
            editorSave = callback;
        }
    );
    bind(
        "editvar",
        function () {
            return editorState.value;
        },
        function (value) {
            editorState.value = String(value == null ? "" : value);
        }
    );
    bind(
        "editCaption",
        function () {
            return editorState.caption;
        },
        function (value) {
            editorState.caption = String(value || "");
        }
    );
    bind(
        "editPos",
        function () {
            return editorState.cursor;
        },
        function (value) {
            editorState.cursor = Number(value) || 0;
        }
    );
    bind(
        "isListVisible",
        function () {
            return visibleList;
        },
        function (value) {
            visibleList = !!value;
            if (!value) closeList();
        }
    );
    var port = {
        acceptsEditorSave: function (owner: ScreenOwner | null) {
            return (
                !!owner &&
                (owner.foreground() ||
                    (owner === committingEditor &&
                        (!owner.model.parent ||
                            owner.model.parent.foreground())))
            );
        },
        close: close,
        closeList: closeList,
        commitList: commitList,
        decorateOwnedCallback: function (
            kind: string,
            expected: any,
            wrapper: (...args: any[]) => any
        ) {
            var owner = overlays[kind];
            if (
                !owner ||
                !owner.active() ||
                callbacks[kind] !== expected ||
                typeof wrapper !== "function"
            )
                return null;
            var guarded = function () {
                if (owner!.foreground())
                    return wrapper.apply(null, arguments as any);
            };
            callbacks[kind] = guarded;
            owner.model.callback = guarded;
            return guarded;
        },
        dispatch: function (
            code: number,
            event: any,
            main: (command: ScreenCommand) => void
        ) {
            mainInput = main;
            if (event) {
                if (event.preventDefault) event.preventDefault();
                if (event.stopPropagation) event.stopPropagation();
            }
            var previousEvent = keyEvent;
            keyEvent = event;
            try {
                return router.fromKey(code, event);
            } finally {
                keyEvent = previousEvent;
            }
        },
        finishEditor: finishEditor,
        invalidate: invalidate,
        keyEvent: function () {
            return keyEvent;
        },
        listOwner: function () {
            return listOwner;
        },
        onDispose: function (cleanup: () => void) {
            return commitList().own(cleanup);
        },
        openEditor: openEditor,
        openOverlay: openOverlay,
        owner: function (kind: string) {
            return kind === "list" ? listOwner : overlays[kind];
        },
        ownListHandler: function (callback: (...args: any[]) => any) {
            var binding: any = { callback: null, owner: null };
            binding.callback = function () {
                if (binding.owner && binding.owner.foreground())
                    return callback.apply(null, arguments as any);
                return true;
            };
            pendingListBindings.push(binding);
            return binding.callback;
        },
        reconcile: function () {
            [
                ["dialog", "#dialogbox"],
                ["about", "#listAbout"],
                ["editor", "#listEdit"],
            ].forEach(function (entry) {
                // A hidden parent stays alive while its modal child owns input.
                var owner = overlays[entry[0]];
                if (owner && owner.foreground() && !visible(entry[1]))
                    close(entry[0]);
            });
            if (visibleList) commitList();
            if (
                visible("#listEdit") &&
                !overlays.editor &&
                typeof host.editKey === "function"
            )
                openEditor();
            if (visible("#listAbout") && !overlays.about)
                setCallback(
                    "about",
                    callbacks.about ||
                        function () {
                            return false;
                        }
                );
            if (visible("#dialogbox") && !overlays.dialog)
                openOverlay("dialog", function () {});
        },
        restorePanel: function () {
            var snapshot = panelStack.pop();
            if (snapshot && snapshot.release) snapshot.release();
            var current = screens.current();
            if (
                current &&
                current !== (snapshot && snapshot.owner) &&
                current.kind !== "list"
            )
                close(current.kind);
            return snapshot && (!snapshot.owner || snapshot.owner.active())
                ? snapshot.value
                : null;
        },
        revision: function () {
            return intent + screens.revision();
        },
        savedPanel: function () {
            return panelStack.length
                ? panelStack[panelStack.length - 1].value
                : {};
        },
        savePanel: function (value: any) {
            var snapshot = {
                owner: screens.current(),
                release: null as (() => void) | null,
                value: value,
            };
            panelStack.push(snapshot);
            if (snapshot.owner)
                snapshot.release = snapshot.owner.own(function () {
                    var index = panelStack.indexOf(snapshot);
                    if (index >= 0) panelStack.splice(index, 1);
                });
        },
        screens: screens,
        setOwnedCallback: function (
            kind: string,
            callback: (...args: any[]) => any
        ) {
            var owner: ScreenOwner | null = null;
            var guarded = function () {
                if (owner && owner.foreground())
                    return callback.apply(null, arguments as any);
            };
            owner = setCallback(kind, guarded) || null;
            (guarded as any).owner = owner;
            return guarded;
        },
    };
    var router = host.__ottInputRouter.create({
        global: function (command: ScreenCommand) {
            if (command.id === "power") {
                if (mainInput) mainInput(command);
                return true;
            }
            if (command.id === "mute") {
                call("stbToggleMute");
                return true;
            }
            if (
                /^volume-(up|down)$/.test(command.id) &&
                typeof host.changeVolume === "function"
            ) {
                call(
                    "changeVolume",
                    (command.id === "volume-up" ? 1 : -1) *
                        (host.sVolumeStep || 5)
                );
                return true;
            }
            return false;
        },
        keys: function () {
            return host.keys || {};
        },
        main: function (command: ScreenCommand) {
            if (mainInput) mainInput(command);
        },
        reconcile: port.reconcile,
        screens: screens,
    });
    (port as any).normalize = router.normalize;
    return port;
}
(window as any).__ottClassicScreenPort = createClassicScreenPort(window as any);
(window as any).__ottScreens = (window as any).__ottClassicScreenPort.screens;
