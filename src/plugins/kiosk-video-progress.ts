/** Supplemental decoder evidence. A missing counter never means a frozen video. */
export function createKioskVideoProgress(w: any): any {
    var node: any = null;
    var generation: any = null;
    var mediaSource = "";
    var previous: any = null;
    var advanced = false;
    var cadence = 0;
    var lastFrame = 0;
    var report: any;

    function empty(): any {
        return {
            dropped_frames: null,
            frame_age_ms: null,
            source: "unavailable",
            state: "unknown",
            total_frames: null,
            version: 1,
        };
    }
    function reset(): void {
        node = null;
        generation = null;
        mediaSource = "";
        previous = null;
        advanced = false;
        cadence = 0;
        lastFrame = 0;
        report = empty();
    }
    function count(value: any): boolean {
        return (
            typeof value === "number" &&
            isFinite(value) &&
            value >= 0 &&
            value <= 9007199254740991 &&
            Math.floor(value) === value
        );
    }
    function visible(video: any): boolean {
        if (!video || typeof w.getComputedStyle !== "function") return false;
        var el = video;
        for (var depth = 0; el && depth < 32; depth++) {
            var style = w.getComputedStyle(el);
            if (
                !style ||
                style.display === "none" ||
                style.opacity === "0" ||
                (el === video &&
                    (style.visibility === "hidden" ||
                        style.visibility === "collapse"))
            )
                return false;
            el = el.parentElement;
        }
        return !el;
    }
    function sample(time: number, owner: any): any {
        try {
            var doc = w.document;
            var video =
                doc && doc.getElementById && doc.getElementById("video");
            var rect =
                video &&
                video.getBoundingClientRect &&
                video.getBoundingClientRect();
            if (
                !visible(video) ||
                !owner ||
                !count(owner.generation) ||
                !isFinite(time) ||
                (rect &&
                    (rect.width <= 0 ||
                        rect.height <= 0 ||
                        rect.bottom <= 0 ||
                        rect.right <= 0 ||
                        (w.innerWidth > 0 && rect.left >= w.innerWidth) ||
                        (w.innerHeight > 0 && rect.top >= w.innerHeight))) ||
                video.paused ||
                video.seeking ||
                video.ended ||
                video.error ||
                video.readyState < 3 ||
                video.playbackRate !== 1 ||
                !video.videoWidth ||
                !video.videoHeight ||
                doc.visibilityState !== "visible" ||
                (doc.hasFocus && !doc.hasFocus()) ||
                (video.videoTracks && !video.videoTracks.length)
            ) {
                reset();
                return report;
            }
            var position = video.currentTime;
            var ahead = 0;
            for (var i = 0; i < video.buffered.length; i++)
                if (
                    video.buffered.start(i) <= position &&
                    video.buffered.end(i) >= position
                )
                    ahead = video.buffered.end(i) - position;
            if (!isFinite(position) || position < 0 || ahead < 2) {
                reset();
                return report;
            }
            var quality =
                typeof video.getVideoPlaybackQuality === "function"
                    ? video.getVideoPlaybackQuality()
                    : null;
            var total = quality
                ? quality.totalVideoFrames
                : video.webkitDecodedFrameCount;
            var dropped = quality
                ? quality.droppedVideoFrames
                : video.webkitDroppedFrameCount;
            if (!count(total) || !count(dropped) || dropped > total) {
                reset();
                return report;
            }
            var source = quality ? "playback-quality" : "webkit-decoded";
            var current = {
                dropped: dropped,
                position: position,
                time: time,
                total: total,
            };
            if (
                node !== video ||
                generation !== owner.generation ||
                mediaSource !== video.currentSrc ||
                !previous ||
                source !== report.source ||
                time <= previous.time ||
                time - previous.time > 5000 ||
                total < previous.total ||
                dropped < previous.dropped ||
                dropped - previous.dropped > total - previous.total ||
                position < previous.position ||
                Math.abs(
                    (position - previous.position) * 1000 -
                        (time - previous.time)
                ) > 2000
            ) {
                advanced = false;
                cadence = 0;
                lastFrame = time;
            } else if (total - dropped > previous.total - previous.dropped) {
                cadence = time - lastFrame <= 5000 ? cadence + 1 : 1;
                if (cadence >= 3) advanced = true;
                lastFrame = time;
            }
            node = video;
            generation = owner.generation;
            mediaSource = video.currentSrc;
            previous = current;
            // Establish repeated progress at an observable cadence first. A
            // sparse slideshow or unsupported constant counter stays warming.
            var age = advanced
                ? Math.max(0, Math.floor(time - lastFrame))
                : null;
            report = {
                dropped_frames: dropped,
                frame_age_ms: age,
                source: source,
                state: !advanced
                    ? "warming"
                    : age !== null && age >= 15000
                      ? "stalled"
                      : "progressing",
                total_frames: total,
                version: 1,
            };
            return report;
        } catch (_) {
            reset();
            return report;
        }
    }
    reset();
    return {
        reset: reset,
        sample: sample,
        snapshot: function (): any {
            return { ...report };
        },
    };
}
