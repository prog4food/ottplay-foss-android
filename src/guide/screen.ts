interface GuideScreenPorts {
    current(reference: GuideReference): boolean;
    now(): number;
    request(
        reference: GuideReference,
        notify: (rows: GuideProgramme[] | null) => void
    ): () => void;
    select(rows: GuideProgramme[], now: number, count: number): GuideProjection;
}
/** One guide view owns its request, programme identity and filtered schedule. */
function createGuideScreen(ports: GuideScreenPorts) {
    var revision = 0,
        cancel: (() => void) | null = null,
        state: any = null;
    function close(): void {
        revision++;
        state = null;
        var old = cancel;
        cancel = null;
        if (old) old();
    }
    function current(): boolean {
        return (
            !!state &&
            (state.children
                ? state.children.every(function (child: any) {
                      return child.current();
                  })
                : ports.current(state.reference))
        );
    }
    function selectedChild(): any {
        return state && state.children ? state.owners[state.selectedId] : null;
    }
    function snapshot(): any {
        var model =
            state && state.children
                ? state.models[state.order[state.selectedId]]
                : null;
        return state
            ? JSON.parse(
                  JSON.stringify({
                      channelIds: state.channelIds,
                      mode: state.mode,
                      rows: state.rows,
                      schedule: model ? model.schedule : state.schedule,
                      selectedId: state.selectedId,
                  })
              )
            : null;
    }
    return {
        close: close,
        current: current,
        guard: function (callback: any) {
            var expected = revision,
                captured = state;
            return function () {
                if (revision === expected && captured === state && current())
                    callback();
            };
        },
        open: function (
            reference: GuideReference,
            mode: number,
            archiveHours: number,
            playhead: number,
            notify: any,
            selectedId?: string
        ) {
            var expected = revision + 1;
            close();
            if (expected !== revision) return;
            if (!ports.current(reference)) return;
            state = {
                mode: mode,
                reference: reference,
                rows: [],
                schedule: [],
                selectedId: selectedId || "",
            };
            var completed = false;
            var stop = ports.request(reference, function (rows) {
                if (expected !== revision || !ports.current(reference)) return;
                completed = true;
                cancel = null;
                var now = ports.now(),
                    all = rows || [];
                var schedule = all
                    .filter(function (row) {
                        return archiveHours > 0
                            ? row.start > now - archiveHours * 3600
                            : row.end > now - 7200;
                    })
                    .sort(function (a, b) {
                        return a.start - b.start;
                    });
                var visible = schedule.slice();
                if (mode === 2)
                    visible = visible.filter(function (row) {
                        return archiveHours > 0 || row.end > now;
                    });
                if (mode === 0) {
                    var titles: Record<string, boolean> = Object.create(null);
                    visible = visible.reverse().filter(function (row) {
                        if (row.end > now || titles[row.title]) return false;
                        titles[row.title] = true;
                        return true;
                    });
                }
                if (mode !== 1)
                    visible.sort(function (a, b) {
                        return a.title < b.title
                            ? -1
                            : a.title > b.title
                              ? 1
                              : a.start - b.start;
                    });
                var current = ports.select(all, playhead, 0).current;
                state.schedule = schedule;
                state.rows = visible;
                if (
                    !visible.some(function (row) {
                        return row.id === state.selectedId;
                    })
                )
                    state.selectedId =
                        current &&
                        visible.some(function (row) {
                            return row.id === current!.id;
                        })
                            ? current.id
                            : visible.length
                              ? visible[0].id
                              : "";
                notify(snapshot());
            });
            if (!completed && expected === revision) cancel = stop;
            else stop();
        },
        openCategory: function (
            references: GuideReference[],
            playhead: number,
            notify: any,
            selectedId?: string
        ) {
            var expected = revision + 1;
            close();
            if (
                expected !== revision ||
                !references.every(function (reference) {
                    return ports.current(reference);
                })
            )
                return;
            var children = references.map(function () {
                return createGuideScreen(ports);
            });
            var view: any = {
                channelIds: Object.create(null),
                children: children,
                mode: 3,
                models: [],
                order: Object.create(null),
                owners: Object.create(null),
                rows: [],
                schedule: [],
                selectedId: selectedId || "",
            };
            state = view;
            cancel = function () {
                children.forEach(function (child) {
                    child.close();
                });
            };
            var remaining = references.length;
            function publish(): void {
                if (state !== view || expected !== revision || !current())
                    return;
                view.models.forEach(function (model: any, index: number) {
                    model.rows.forEach(function (row: any) {
                        view.rows.push(row);
                        view.owners[row.id] = children[index];
                        view.order[row.id] = index;
                        view.channelIds[row.id] = references[index].id;
                    });
                });
                view.rows.sort(function (a: any, b: any) {
                    return a.title < b.title
                        ? -1
                        : a.title > b.title
                          ? 1
                          : a.start - b.start ||
                            view.order[a.id] - view.order[b.id];
                });
                if (!view.owners[view.selectedId])
                    view.selectedId = view.rows.length ? view.rows[0].id : "";
                notify(snapshot());
            }
            if (!remaining) publish();
            references.forEach(function (reference, index) {
                if (state !== view || expected !== revision) return;
                children[index].open(
                    reference,
                    0,
                    Number((reference.token as any).rec) || 0,
                    playhead,
                    function (model: any) {
                        view.models[index] = model;
                        if (--remaining === 0) publish();
                    }
                );
            });
        },
        reference: function () {
            var child = selectedChild();
            return child ? child.reference() : state && state.reference;
        },
        select: function (id: string) {
            if (!current()) return null;
            var row = state.rows.filter(function (item: GuideProgramme) {
                return item.id === id;
            })[0];
            if (!row) return null;
            state.selectedId = id;
            var child = selectedChild();
            if (child) child.select(id);
            return JSON.parse(JSON.stringify(row));
        },
        snapshot: snapshot,
    };
}
(window as any).__ottGuideScreen = { create: createGuideScreen };
