import { remotePlayerInfo } from "./remote-restart";

/** Uses the connected controller and existing capture source; never opens a browser picker. */
export function executeRemoteScreenshot(
    w: any,
    params: any,
    done: (result: any) => void
): (() => void) | void {
    var runtime = remotePlayerInfo(w).runtime;
    if (
        !params ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        Object.keys(params).length !== 1 ||
        params.runtime !== runtime
    ) {
        done({
            data: {
                error: "The requested player instance changed. Discover capabilities again.",
            },
            status: "rejected",
        });
        return;
    }
    var hook = w.__ottRemoteScreenshot;
    if (!hook || hook.snapshot().state === "unsupported") {
        done({
            data: { error: "Screenshots are unsupported by this player." },
            status: "unsupported",
        });
        return;
    }
    return hook.capture(function (result: any) {
        if (result.status !== "ok") {
            done(result);
            return;
        }
        if (
            w.__ottRemoteScreenshot !== hook ||
            remotePlayerInfo(w).runtime !== runtime
        ) {
            done({
                data: { error: "Screenshot source or player changed." },
                status: "rejected",
            });
            return;
        }
        done({
            data: {
                captured_at: Date.now(),
                encoding: "base64",
                height: result.data.height,
                image: result.data.image,
                mime: "image/png",
                runtime: runtime,
                source: result.data.source,
                version: 1,
                video: result.data.video,
                width: result.data.width,
            },
            status: "ok",
        });
    });
}
