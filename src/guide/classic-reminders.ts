/** Storage and UI effects for source/channel/programme reminder identities. */
var classicReminderOwner: any = null;
var classicReminderSource = "";
var classicReminderRevision = 0;
function reminderHost(): any {
    return window as any;
}
function reminderChannel(record: ProgrammeReminder): any {
    var host = reminderHost(),
        channels = host.channels || {},
        ids = Object.keys(channels),
        matches: any[] = [];
    function transportId(key: string): any {
        var list = host.cList || host.curList || [];
        var match = list.filter(function (id: any) {
            return String(id) === key;
        });
        return match.length === 1
            ? match[0]
            : /^-?\d+$/.test(key)
              ? Number(key)
              : key;
    }
    for (var i = 0; i < ids.length; i++) {
        var row = channels[ids[i]],
            own = String(row.itemId || "channel:" + ids[i]);
        if (own === record.channelId) return transportId(ids[i]);
        if (
            "legacy-channel:" + ids[i] === record.channelId ||
            (row.legacyChannelId !== undefined &&
                "legacy-channel:" + row.legacyChannelId === record.channelId)
        )
            matches.push(transportId(ids[i]));
    }
    return matches.length === 1 ? matches[0] : null;
}
function reminderRecord(value: any, source: string): ProgrammeReminder | null {
    var host = reminderHost(),
        resolved = value
            ? reminderChannel({
                  channelId: "legacy-channel:" + value.ci,
              } as ProgrammeReminder)
            : null,
        channel = resolved !== null ? (host.channels || {})[resolved] : null;
    if (
        !value ||
        !isFinite(Number(value.t)) ||
        !isFinite(Number(value.te)) ||
        Number(value.te) <= Number(value.t)
    )
        return null;
    var channelId = channel
        ? String(channel.itemId || "channel:" + resolved)
        : "legacy-channel:" + value.ci;
    var id = host.OttPlayCore.guideProgrammeId(
        source,
        channelId,
        undefined,
        Number(value.t)
    );
    return {
        channelId: channelId,
        end: Number(value.te),
        id: id,
        legacy: true,
        programmeId: id,
        sourceId: source,
        start: Number(value.t),
        title: String(value.n || ""),
    };
}
function publishReminders(): void {
    var host = reminderHost();
    host.publishGuideReminders(
        classicReminderOwner
            ? classicReminderOwner.snapshot().map(function (
                  record: ProgrammeReminder
              ) {
                  return {
                      ci: reminderChannel(record),
                      n: record.title,
                      programmeId: record.programmeId,
                      t: record.start,
                      te: record.end,
                  };
              })
            : []
    );
}
function loadClassicReminders(): any {
    var host = reminderHost(),
        source = host.__ottClassicGuide.source();
    var ticket = ++classicReminderRevision;
    var previous = classicReminderOwner;
    classicReminderOwner = null;
    if (previous) previous.dispose();
    if (
        ticket !== classicReminderRevision ||
        source !== host.__ottClassicGuide.source()
    )
        return classicReminderOwner;
    classicReminderSource = source;
    var keys = host.providerScopedStorageKeys || [],
        canonicalKey = "guideReminders:" + source;
    [canonicalKey, "guideReminderSource"].forEach(function (key) {
        if (keys.indexOf(key) < 0) keys.push(key);
    });
    var get = host.providerGetItem || host.stbGetItem,
        set = host.providerSetItem || host.stbSetItem;
    var globalLegacy = false;
    var owner: any;
    owner = host.__ottReminderService.create({
        clearTimer: function (id: any) {
            clearTimeout(id);
        },
        current: function () {
            return (
                classicReminderOwner === owner &&
                host.__ottClassicGuide.source() === source
            );
        },
        leadSeconds: function () {
            return (Number(host.sEpgRemindMinutes) || 0) * 60;
        },
        legacy: function () {
            var value = get("epgTimers");
            if (value == null && host.stbGetItem) {
                value = host.stbGetItem("epgTimers");
                globalLegacy = value != null;
            }
            return value ? JSON.parse(value) : [];
        },
        legacyRecord: function (value: any) {
            return reminderRecord(value, source);
        },
        notify: function (record: ProgrammeReminder, minutes: number) {
            var id = reminderChannel(record),
                channel = id === null ? null : host.channels[id];
            if (channel && host.showShift)
                host.showShift(
                    host._(
                        "Reminder: %1 — %2 in %3 min",
                        channel.channel_name,
                        record.title,
                        minutes
                    )
                );
        },
        now: function () {
            return Date.now() / 1000;
        },
        play: function (record: ProgrammeReminder) {
            var id = reminderChannel(record);
            if (id === null) return;
            var reference = host.__ottClassicGuide.reference(id),
                used = false;
            var accept = owner.guard(record, function () {
                var position = host.__ottClassicGuideScreen.position(id);
                if (
                    used ||
                    classicReminderOwner !== owner ||
                    !owner.has(record.id) ||
                    !reference ||
                    !host.__ottClassicGuide.valid(reference) ||
                    Date.now() / 1000 >= record.end ||
                    !position
                )
                    return;
                used = true;
                if (host.closeList) host.closeList();
                if (host.__ottClassicGuide.valid(reference))
                    host.playChannel(position[0], position[1]);
            });
            if (host.__ottClassicPlayback)
                accept = host.__ottClassicPlayback.guard(accept);
            if (
                host.ifParentalAccessChId &&
                host.ifParentalAccessChId(id, accept)
            )
                return;
            accept();
        },
        prompt: function (record: ProgrammeReminder, accept: any) {
            if (!host.confirmBox) return;
            var id = reminderChannel(record),
                channel = id === null ? null : host.channels[id];
            host.confirmBox(
                host._("Timer: switch to channel?") +
                    "\n\n" +
                    (channel ? channel.channel_name : "") +
                    "\n" +
                    record.title +
                    "\n" +
                    host.formatEpgTime(record.start) +
                    " - " +
                    host.formatEpgTime(record.end),
                accept
            );
            var handler = host.dialogBoxKeyHandler;
            return function () {
                if (host.dialogBoxKeyHandler === handler) {
                    host.dialogBoxKeyHandler = null;
                    if (host.jQuery) host.jQuery("#dialogbox").hide();
                }
            };
        },
        read: function (key: string) {
            var value =
                key === "guideReminderSource" && globalLegacy
                    ? host.stbGetItem(key)
                    : get(key);
            return value == null ? null : String(value);
        },
        resolve: function (record: ProgrammeReminder) {
            var id = reminderChannel(record);
            return id !== null && !!host.__ottClassicGuideScreen.position(id);
        },
        sourceId: source,
        timer: function (callback: any, delay: number) {
            return setTimeout(callback, delay);
        },
        write: function (key: string, value: string) {
            if (key === "guideReminderSource" && globalLegacy)
                host.stbSetItem(key, value);
            else set(key, value);
        },
    });
    classicReminderOwner = owner;
    owner.load();
    publishReminders();
    return owner;
}
function reminderOwner(): any {
    return !classicReminderOwner ||
        classicReminderSource !== reminderHost().__ottClassicGuide.source()
        ? loadClassicReminders()
        : classicReminderOwner;
}
(window as any).__ottClassicReminders = {
    dispose: function () {
        classicReminderRevision++;
        var owner = classicReminderOwner;
        classicReminderOwner = null;
        if (owner) owner.dispose();
    },
    importRecord: function (value: any) {
        var owner = reminderOwner(),
            record = reminderRecord(value, classicReminderSource);
        if (record && owner) owner.upsert(record);
        publishReminders();
    },
    load: loadClassicReminders,
    toggle: function () {
        var host = reminderHost(),
            screen = host.__ottClassicGuideScreen,
            choice = screen.current();
        if (!choice || choice.row.start < Date.now() / 1000 || !host.confirmBox)
            return;
        var owner = reminderOwner();
        if (!owner) return;
        var row = choice.row,
            reference = choice.reference,
            existing = owner.snapshot().filter(function (
                record: ProgrammeReminder
            ) {
                return (
                    record.id === row.id ||
                    (record.legacy &&
                        record.sourceId === reference.sourceId &&
                        reminderChannel(record) === reference.id &&
                        record.start === row.start)
                );
            })[0],
            remove = !!existing,
            used = false;
        var record = {
            channelId: reference.channelId,
            end: row.end,
            id: row.id,
            programmeId: row.id,
            sourceId: reference.sourceId,
            start: row.start,
            title: row.title,
        };
        host.confirmBox(
            host._(remove ? "Remove timer?" : "Set timer?"),
            screen.guard(function () {
                var current = screen.current();
                if (
                    used ||
                    classicReminderOwner !== owner ||
                    !current ||
                    current.row.id !== row.id ||
                    row.start < Date.now() / 1000
                )
                    return;
                used = true;
                if (remove ? owner.remove(existing.id) : owner.upsert(record)) {
                    publishReminders();
                    if (host.showPage) host.showPage();
                }
            })
        );
    },
};
