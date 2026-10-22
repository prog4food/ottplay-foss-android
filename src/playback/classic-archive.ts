/** Compatibility edge for archive UI, provider URLs and device effects. */
var classicArchiveController: any = null;
var classicArchiveReplacing = false;
var classicArchivePublished: any = null;
var classicArchiveSchedule: ArchiveProgramme[] = [];

function classicArchiveRows(values: any): ArchiveProgramme[] {
    if (!Array.isArray(values)) return [];
    return values
        .filter(function (row: any): boolean {
            return (
                !!row &&
                typeof row.time === "number" &&
                typeof row.time_to === "number"
            );
        })
        .map(function (row: any): ArchiveProgramme {
            return {
                end: row.time_to,
                key: JSON.stringify([
                    row.time,
                    row.time_to,
                    row.id === undefined ? row.catchup_id : row.id,
                ]),
                payload: row,
                start: row.time,
            };
        });
}

function classicArchiveCapture(): ArchiveContext | null {
    var w = window as any;
    if (w.__ottKiosk && w.__ottKiosk.enabled()) return null;
    var id = (w.curList || [])[w.primaryIndex];
    var channel = (w.channels || {})[id];
    if (!channel || id === undefined || id === null) return null;
    var context = w.__ottClassicPlayback.context();
    return {
        channelId: String(id),
        file: !!w.fileArchive,
        host: { category: w.catIndex, id: id, index: w.primaryIndex },
        isCurrent: context.isCurrent,
        retention: Math.max(0, Number(channel.rec) || 0) * 3600,
        schedule:
            w.epgArray === classicArchivePublished
                ? classicArchiveSchedule
                : classicArchiveRows(w.epgArray),
        scheduleRevision: w.epgArray,
        sourceId: context.sourceId,
    };
}

function classicArchiveRuntime(): any {
    if (classicArchiveController) return classicArchiveController;
    var w = window as any;
    function enter(
        context: ArchiveContext,
        model: ArchiveView,
        select: boolean
    ): void {
        if (select && typeof w.setCurrent === "function")
            w.setCurrent(context.host.category, context.host.index, true);
        w.__ottClassicPlayback.command({
            archiveStart: model.position,
            channelId: context.channelId,
            label:
                model.current &&
                model.current.payload &&
                typeof model.current.payload.name === "string"
                    ? model.current.payload.name
                    : "",
            type: "archive",
        });
    }
    classicArchiveController = w.__ottArchiveSession.create(w.OttPlayCore, {
        authorize: function (
            context: ArchiveContext,
            allowed: () => void
        ): boolean {
            return (
                typeof w.ifParentalAccessChId === "function" &&
                w.ifParentalAccessChId(context.host.id, allowed)
            );
        },
        capture: classicArchiveCapture,
        epoch: function (): number | null {
            var state = w.__ottClassicPlayback.snapshot();
            return state.target &&
                state.target.kind === "archive" &&
                state.phase !== "stopped"
                ? state.target.archiveStart + state.position
                : null;
        },
        guide: function (
            context: ArchiveContext,
            done: (rows: ArchiveProgramme[]) => void
        ): void {
            if (typeof w.getChannelEpgCached !== "function") {
                done([]);
                return;
            }
            w.getChannelEpgCached(
                context.host.id,
                function (_id: any, data: any): void {
                    done(classicArchiveRows(data));
                }
            );
        },
        now: function (): number {
            return Date.now() / 1000;
        },
        open: function (
            context: ArchiveContext,
            model: ArchiveView,
            url: string,
            offset: number,
            select: boolean
        ): ArchiveContext | null {
            if (w.sStopPlay && typeof w.stbStop === "function") {
                // The coordinator owns this synchronous decoder replacement.
                classicArchiveReplacing = true;
                try {
                    w.stbStop();
                } finally {
                    classicArchiveReplacing = false;
                }
            }
            enter(context, model, select);
            if (model.rewind !== undefined && typeof w.showShift === "function")
                w.showShift(
                    model.rewind
                        ? typeof w.formatSeekOffset === "function"
                            ? w.formatSeekOffset(-model.rewind)
                            : String(-model.rewind)
                        : w._
                          ? w._("Archive - begin")
                          : "Archive - begin"
                );
            if (w.sInfoRew && typeof w.showChannelInfo === "function")
                w.showChannelInfo(1);
            w.stbPlay(url, offset);
            return classicArchiveCapture();
        },
        pause: function (
            context: ArchiveContext,
            model: ArchiveView
        ): ArchiveContext | null {
            enter(context, model, false);
            w.__ottClassicPlayback.command({ type: "pause" });
            if (typeof w.showChannelInfo === "function") w.showChannelInfo(2);
            if (typeof w.showShift === "function")
                w.showShift(w._ ? w._("Pause") : "Pause");
            if (typeof w.stbPause === "function") w.stbPause();
            return classicArchiveCapture();
        },
        publish: function (model: ArchiveView): any {
            // The controller keeps its schedule stable between position ticks.
            // Restore that owned projection even if a view replaced epgArray.
            w.epgArray =
                classicArchiveSchedule === model.rows
                    ? classicArchivePublished
                    : model.rows.map(function (row): any {
                          return row.payload;
                      });
            w.curProg = model.current ? model.rows.indexOf(model.current) : -1;
            // Position ticks repaint the archive footer but do not replace
            // the live guide projection with the same schedule every second.
            if (
                classicArchiveSchedule !== model.rows &&
                typeof w.publishChannelProgrammeRows === "function"
            )
                w.publishChannelProgrammeRows(
                    model.context.host.id,
                    w.epgArray
                );
            if (typeof w.__ottRenderArchive === "function")
                w.__ottRenderArchive(model);
            classicArchivePublished = w.epgArray;
            classicArchiveSchedule = model.rows;
            return w.epgArray;
        },
        resolve: function (
            context: ArchiveContext,
            model: ArchiveView,
            done: (url: string) => void
        ): void {
            var programme = model.current
                ? model.current.payload
                : {
                      descr: "",
                      name: "",
                      time: model.window.start,
                      time_to: model.window.end,
                  };
            done(
                typeof w.getArchiveUrl === "function"
                    ? w.getArchiveUrl(
                          context.host.id,
                          model.position,
                          model.window.end,
                          programme
                      )
                    : ""
            );
        },
        seek: function (
            context: ArchiveContext,
            model: ArchiveView,
            offset: number
        ): ArchiveContext | null {
            enter(context, model, false);
            if (w.sInfoRew && typeof w.showChannelInfo === "function")
                w.showChannelInfo(1);
            w.stbSetPosTime(offset);
            return classicArchiveCapture();
        },
    });
    return classicArchiveController;
}

(window as any).__ottClassicArchive = {
    cancel: function (): void {
        if (!classicArchiveReplacing && classicArchiveController)
            classicArchiveController.cancel();
    },
    open: function (epoch: number): void {
        classicArchiveRuntime().open(epoch);
    },
    pauseLive: function (): void {
        classicArchiveRuntime().pauseLive();
    },
    rewind: function (offset: number): void {
        classicArchiveRuntime().rewind(offset);
    },
    update: function (epoch: number): void {
        classicArchiveRuntime().update(epoch);
    },
};
