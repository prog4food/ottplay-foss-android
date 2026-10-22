/** Keyboard/assistive focus follows the same owned overlays as remote input. */
(function (host: any) {
    var installed = false;
    var opened: Array<{ root: HTMLElement; previous: HTMLElement | null }> = [];
    function visible(node: HTMLElement | null): boolean {
        if (!node || !host.document.documentElement.contains(node))
            return false;
        for (
            var parent: HTMLElement | null = node;
            parent;
            parent = parent.parentElement
        ) {
            if (
                host.getComputedStyle(parent).display === "none" ||
                host.getComputedStyle(parent).visibility === "hidden"
            )
                return false;
        }
        return true;
    }
    function top(): HTMLElement | null {
        for (var i = opened.length - 1; i >= 0; i--)
            if (visible(opened[i].root)) return opened[i].root;
        return null;
    }
    function controls(root: HTMLElement): HTMLElement[] {
        return Array.prototype.slice
            .call(
                root.querySelectorAll(
                    "button, input, select, textarea, a[href], [tabindex]"
                )
            )
            .filter(function (node: HTMLElement) {
                return (
                    node.tabIndex >= 0 &&
                    !(node as any).disabled &&
                    visible(node)
                );
            });
    }
    function focus(root: HTMLElement): void {
        var candidates = controls(root);
        // Remote Enter belongs to the dialog until Tab explicitly chooses a
        // control; a wait dialog's first button may be Cancel.
        (root.id === "dialogbox" ? root : candidates[0] || root).focus();
    }
    function install(): void {
        opened = opened.filter(function (entry) {
            return host.document.documentElement.contains(entry.root);
        });
        ["dialogbox", "listEdit", "listAbout"].forEach(function (id) {
            var root = host.document.getElementById(id) as HTMLElement;
            if (!root || (root as any).__ottAccessibilityBound) return;
            (root as any).__ottAccessibilityBound = true;
            root.setAttribute("role", "dialog");
            root.setAttribute("aria-modal", "true");
            root.tabIndex = -1;
            host.$(root)
                .on("show.ottA11y", function () {
                    var existing = opened.some(function (entry) {
                        return entry.root === root;
                    });
                    if (!existing)
                        opened.push({
                            previous: host.document.activeElement,
                            root: root,
                        });
                    host.setTimeout(function () {
                        if (!visible(root) || top() !== root) return;
                        var caption =
                            host.document.getElementById("listCaption");
                        root.setAttribute(
                            "aria-label",
                            id === "dialogbox"
                                ? host._("Information")
                                : (caption && caption.textContent) ||
                                      host._("Settings")
                        );
                        if (root.querySelector("#dialogMessage"))
                            root.setAttribute(
                                "aria-describedby",
                                "dialogMessage"
                            );
                        else root.removeAttribute("aria-describedby");
                        if (!root.contains(host.document.activeElement))
                            focus(root);
                    }, 0);
                })
                .on("hide.ottA11y", function () {
                    var entry: any = null;
                    opened = opened.filter(function (item) {
                        if (item.root === root) {
                            entry = item;
                            return false;
                        }
                        return true;
                    });
                    if (!entry || !root.contains(host.document.activeElement))
                        return;
                    var lastFocus = host.document.activeElement;
                    host.setTimeout(function () {
                        var parent = top();
                        var currentFocus = host.document.activeElement;
                        if (
                            visible(root) ||
                            (parent && parent.contains(currentFocus))
                        )
                            return;
                        if (
                            currentFocus !== lastFocus &&
                            currentFocus !== host.document.body &&
                            visible(currentFocus)
                        )
                            return;
                        if (
                            visible(entry.previous) &&
                            (!parent || parent.contains(entry.previous))
                        )
                            entry.previous.focus();
                        else if (parent) focus(parent);
                        else {
                            var selected = host.document.querySelector(
                                '#listIn [aria-selected="true"]'
                            ) as HTMLElement;
                            if (visible(selected)) selected.focus();
                        }
                    }, 0);
                });
        });
        var list = host.document.getElementById("listIn");
        if (list && !list.__ottAccessibilityBound) {
            list.__ottAccessibilityBound = true;
            var pointerFocus = false;
            list.addEventListener(
                "mousedown",
                function () {
                    // Native mouse focus precedes click. Selection still belongs
                    // to the PC two-click or TV one-click pointer handler.
                    pointerFocus = true;
                    host.setTimeout(function () {
                        pointerFocus = false;
                    }, 0);
                },
                true
            );
            list.addEventListener("focusin", function (event: FocusEvent) {
                if (pointerFocus) return;
                var row = event.target as HTMLElement;
                if (row.parentNode !== list || !row.hasAttribute("data-idx"))
                    return;
                var index = Number(row.getAttribute("data-idx"));
                if (index !== host.selIndex && host.changeSelect)
                    host.changeSelect(index - host.selIndex);
            });
        }
        if (installed) return;
        installed = true;
        host.document.addEventListener(
            "keydown",
            function (event: KeyboardEvent) {
                if (event.keyCode !== 9) return;
                var root = top();
                if (!root) return;
                var candidates = controls(root);
                var index = candidates.indexOf(host.document.activeElement);
                var next = index + (event.shiftKey ? -1 : 1);
                if (index < 0 || next < 0 || next >= candidates.length) {
                    event.preventDefault();
                    (candidates.length
                        ? candidates[event.shiftKey ? candidates.length - 1 : 0]
                        : root
                    ).focus();
                }
                // Tab belongs to the modal, never to a legacy player key mapping.
                event.stopImmediatePropagation();
            },
            true
        );
    }
    function select(
        root: HTMLElement | null,
        index: number,
        moveFocus?: boolean
    ): void {
        if (!root) return;
        var rows = root.querySelectorAll(".item[data-idx]");
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i] as HTMLElement;
            var selected = Number(row.getAttribute("data-idx")) === index;
            row.setAttribute("aria-selected", String(selected));
            row.tabIndex = selected ? 0 : -1;
            if (selected && moveFocus && !top()) row.focus();
        }
    }
    host.__ottAccessibility = { install: install, select: select };
})(window as any);
