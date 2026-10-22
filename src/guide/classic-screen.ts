/** Screen and input codec; async selection carries identities, never array offsets. */
var classicGuideScreen: any = null;
var classicGuideView: any = null;
function currentGuideScreen(): any {
    var host = window as any,
        guide = host.__ottClassicGuide;
    if (!classicGuideScreen)
        classicGuideScreen = host.__ottGuideScreen.create({
            current: guide.valid,
            now: function () {
                return Date.now() / 1000;
            },
            request: function (ref: any, callback: any) {
                guide.bind(ref);
                return guide.owner().request(ref, callback);
            },
            select: function (rows: any, now: number, count: number) {
                return host.OttPlayCore.guideScheduleSelection(
                    rows,
                    now,
                    count
                );
            },
        });
    return classicGuideScreen;
}
function guidePosition(id: any, preferred?: string): [number, number] | null {
    var host = window as any,
        names = host.catsArray || [],
        groups = host.cats || {};
    var order = names.slice();
    if (preferred && order.indexOf(preferred) >= 0) {
        order.splice(order.indexOf(preferred), 1);
        order.unshift(preferred);
    }
    for (var c = 0; c < order.length; c++) {
        var at = (groups[order[c]] || []).indexOf(id);
        if (at >= 0) return [names.indexOf(order[c]), at];
    }
    return null;
}
function validClassicGuideView(view: any): boolean {
    var host = window as any,
        guide = host.__ottClassicGuide;
    if (!view.category) return guide.valid(view.reference);
    var members = (host.cats || {})[view.group];
    if (
        view.source !== guide.source() ||
        (host.catsArray || []).indexOf(view.group) < 0 ||
        !Array.isArray(members)
    )
        return false;
    var present: Record<string, boolean> = Object.create(null);
    members.forEach(function (id: any) {
        present[typeof id + ":" + String(id)] = true;
    });
    return view.references.every(function (reference: any) {
        return (
            guide.valid(reference) &&
            present[typeof reference.id + ":" + String(reference.id)] === true
        );
    });
}
function openClassicGuideView(view: any): void {
    var host = window as any,
        screen = currentGuideScreen(),
        previous = classicGuideView;
    classicGuideView = view;
    if (previous && previous.release) {
        previous.publishing = true;
        previous.release();
    }
    if (classicGuideView !== view || !validClassicGuideView(view)) return;
    function bindOwner(): void {
        if (!host.__ottClassicScreenPort) return;
        view.release = host.__ottClassicScreenPort.onDispose(function () {
            if (!view.publishing && classicGuideView === view) {
                classicGuideView = null;
                screen.close();
            }
        });
    }
    bindOwner();
    if (host.jQuery)
        host.jQuery("#listPopUp")
            .html(
                '<div class="ott-spinner" aria-hidden="true"><span class="blob"></span><span class="blob"></span><span class="blob"></span><span class="blob"></span></div>'
            )
            .show();
    function publish(model: any): void {
        if (
            classicGuideView !== view ||
            !screen.current() ||
            !validClassicGuideView(view)
        )
            return;
        var position = view.category
            ? [(host.catsArray || []).indexOf(view.group), 0]
            : guidePosition(view.reference.id, view.group);
        if (!position) return;
        view.publishing = true;
        if (view.release) view.release();
        try {
            if (view.category)
                host.renderCategoryRecordings(position[0], model);
            else
                host.renderGuideView(
                    view.mode,
                    view.reference.id,
                    model,
                    view.returnToList,
                    position
                );
        } finally {
            view.publishing = false;
        }
        if (
            classicGuideView !== view ||
            !screen.current() ||
            !validClassicGuideView(view)
        )
            return;
        bindOwner();
        if (view.after) screen.guard(view.after)();
    }
    if (classicGuideView !== view || !validClassicGuideView(view)) return;
    var now = Date.now() / 1000;
    if (view.category)
        screen.openCategory(view.references, now, publish, view.selectedId);
    else
        screen.open(
            view.reference,
            view.mode,
            Number(view.reference.token.rec) || 0,
            host.playType > 0 &&
                view.reference.id === (host.curList || [])[host.primaryIndex]
                ? host.playType + host.playTime
                : now,
            publish,
            view.selectedId
        );
}
function openClassicGuide(
    mode: number,
    category: number,
    index: number,
    returnToList: boolean,
    selectedId?: string,
    after?: any
): void {
    var host = window as any,
        guide = host.__ottClassicGuide,
        group = (host.catsArray || [])[category],
        id = ((host.cats || {})[group] || [])[index],
        reference = guide.reference(id);
    if (!reference || (mode === 0 && !(Number(reference.token.rec) > 0)))
        return;
    if (
        !selectedId &&
        classicGuideView &&
        classicGuideView.reference &&
        classicGuideView.reference.channelId === reference.channelId &&
        classicGuideView.reference.sourceId === reference.sourceId
    ) {
        var previousChoice = selectedClassicGuide();
        if (previousChoice) selectedId = previousChoice.row.id;
    }
    openClassicGuideView({
        after: after,
        group: group,
        mode: mode,
        publishing: false,
        reference: reference,
        release: null,
        returnToList: returnToList,
        selectedId: selectedId,
    });
}
function openClassicCategoryRecordings(category: number): void {
    var host = window as any,
        guide = host.__ottClassicGuide,
        group = (host.catsArray || [])[category],
        members = (host.cats || {})[group];
    if (!Array.isArray(members)) return;
    var seen: Record<string, boolean> = Object.create(null),
        references: any[] = [],
        selectedId: string | undefined;
    if (
        classicGuideView &&
        classicGuideView.category &&
        classicGuideView.group === group &&
        classicGuideView.source === guide.source()
    ) {
        var previousChoice = selectedClassicGuide();
        selectedId = previousChoice
            ? previousChoice.row.id
            : classicGuideView.selectedId;
    }
    guide.references(members).forEach(function (reference: any) {
        if (
            reference &&
            !seen[reference.channelId] &&
            Number(reference.token.rec) > 0
        ) {
            seen[reference.channelId] = true;
            references.push(reference);
        }
    });
    openClassicGuideView({
        category: true,
        group: group,
        publishing: false,
        references: references,
        release: null,
        selectedId: selectedId,
        source: guide.source(),
    });
}
function selectedClassicGuide(): any {
    var host = window as any,
        screen = currentGuideScreen(),
        item = (host.listArray || [])[host.selIndex];
    if (
        !item ||
        !classicGuideView ||
        !validClassicGuideView(classicGuideView) ||
        !screen.current()
    )
        return null;
    var row = screen.select(String(item.programmeId || "")),
        reference = screen.reference();
    return row && reference
        ? { reference: reference, row: row, view: classicGuideView }
        : null;
}
(window as any).__ottClassicGuideScreen = {
    close: function () {
        var previous = classicGuideView;
        classicGuideView = null;
        if (classicGuideScreen) classicGuideScreen.close();
        if (previous && previous.release) previous.release();
    },
    current: selectedClassicGuide,
    guard: function (callback: any) {
        return currentGuideScreen().guard(callback);
    },
    open: openClassicGuide,
    openCategory: openClassicCategoryRecordings,
    position: guidePosition,
    refresh: function () {
        var view = classicGuideView;
        if (!view) return;
        if (view.category) {
            openClassicCategoryRecordings(
                ((window as any).catsArray || []).indexOf(view.group)
            );
            return;
        }
        selectedClassicGuide();
        var at = guidePosition(view.reference.id, view.group);
        if (at)
            openClassicGuide(
                view.mode,
                at[0],
                at[1],
                view.returnToList,
                currentGuideScreen().snapshot().selectedId
            );
    },
    select: function () {
        var host = window as any,
            guide = host.__ottClassicGuide,
            choice = selectedClassicGuide();
        if (!choice) return;
        var reference = choice.reference,
            row = choice.row,
            used = false;
        if (
            !(Number(reference.token.rec) > 0) ||
            row.start > Date.now() / 1000
        ) {
            if (host.showProgramInfo) host.showProgramInfo(row.title);
            return;
        }
        var schedule = guide.encodeRows(
            currentGuideScreen().snapshot().schedule
        );
        var accept = currentGuideScreen().guard(function () {
            var selected = selectedClassicGuide(),
                now = Date.now() / 1000,
                position = guidePosition(reference.id, choice.view.group);
            if (
                used ||
                !selected ||
                selected.row.id !== row.id ||
                !position ||
                !guide.valid(reference) ||
                !(Number(reference.token.rec) > 0) ||
                row.start > now ||
                row.start <= now - Number(reference.token.rec) * 3600
            )
                return;
            used = true;
            if (host.closeList) host.closeList();
            if (!guide.valid(reference)) return;
            host.setCurrent(position[0], position[1], true);
            host.epgArray = schedule;
            host.playArchive(row.start);
        });
        if (host.__ottClassicPlayback)
            accept = host.__ottClassicPlayback.guard(accept);
        if (
            host.ifParentalAccessChId &&
            host.ifParentalAccessChId(reference.id, accept)
        )
            return;
        accept();
    },
};
