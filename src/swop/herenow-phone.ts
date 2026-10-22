import { languageNames } from "../localization/assets";
import {
    HereNowSwopPair,
    hereNowCryptoAvailable,
    hereNowOpen,
    hereNowReadPair,
    hereNowSeal,
    hereNowStore,
    hereNowSwopConfig,
    hereNowValidValue,
} from "./herenow";
import { createPhoneLocalization } from "./phone-localization";

(function () {
    var w = window as any;
    var locale = createPhoneLocalization(w);
    var status = document.getElementById("status")!;
    var pairing = document.getElementById("pairing") as HTMLFormElement;
    var entry = document.getElementById("entry") as HTMLFormElement;
    var linkInput = document.getElementById("link") as HTMLTextAreaElement;
    var valueInput = document.getElementById("value") as HTMLTextAreaElement;
    var button = document.getElementById("send") as HTMLButtonElement;
    var pair: HereNowSwopPair | null = null;
    var store: any = null;
    var reply = "";
    var sending = false;
    var loaded = false;
    var generation = 0;
    var expiry: any = null;
    function say(value: string): void {
        locale.label(status, value);
    }
    function forget(): void {
        generation++;
        if (expiry) w.clearTimeout(expiry);
        if (pair)
            for (var i = 0; i < pair.secret.length; i++) pair.secret[i] = 0;
        pair = null;
        reply = "";
        valueInput.value = "";
        linkInput.value = "";
        loaded = false;
        entry.hidden = true;
    }
    function expired(): boolean {
        return !pair || Date.now() >= pair.deadline;
    }
    async function start(link: string): Promise<void> {
        forget();
        valueInput.readOnly = false;
        locale.label(button, "Send to TV");
        button.disabled = false;
        sending = false;
        var revision = generation;
        pairing.hidden = true;
        say("Connecting securely to your TV...");
        try {
            if (!hereNowCryptoAvailable(w)) throw new Error("crypto");
            var cfg = hereNowSwopConfig(w);
            if (!cfg) throw new Error("configuration");
            pair = hereNowReadPair(w, link.trim());
            // Small device clock differences must not reject a freshly scanned
            // QR. The TV independently enforces its original monotonic expiry.
            if (expired() || pair.deadline - Date.now() > 660000)
                throw new Error("expired");
            store = hereNowStore(w, cfg.collection);
            var current = pair;
            var data = await store.get(current.recordId);
            var payload = await hereNowOpen(w, current, "offer", data.offer);
            if (generation !== revision) return;
            if (
                expired() ||
                !payload ||
                typeof payload.caption !== "string" ||
                payload.caption.length > 120 ||
                !hereNowValidValue(payload.draft)
            )
                throw new Error("invalid_message");
            if (
                typeof payload.language === "string" &&
                Object.prototype.hasOwnProperty.call(
                    languageNames,
                    payload.language
                )
            ) {
                await locale.setLanguage(
                    payload.language,
                    locale.browserLanguage(),
                    function () {
                        return generation === revision;
                    }
                );
                if (generation !== revision) return;
                if (expired()) throw new Error("expired");
            }
            var caption = document.getElementById("caption")!;
            if (payload.caption) {
                caption.removeAttribute("data-i18n");
                caption.textContent = payload.caption;
            } else locale.label(caption, "Enter text");
            valueInput.value = payload.draft;
            loaded = true;
            entry.hidden = false;
            say(
                "Only this TV can accept your message. The link expires after 10 minutes."
            );
            valueInput.focus();
            expiry = w.setTimeout(
                function () {
                    forget();
                    say(
                        "This pairing link has expired. Open a new session on your TV."
                    );
                },
                Math.min(600000, Math.max(0, current.deadline - Date.now()))
            );
        } catch (_) {
            if (generation !== revision) return;
            forget();
            pairing.hidden = false;
            say(
                "This secure session is unavailable or expired. Open a new session on the TV and use its complete link."
            );
        }
    }
    pairing.onsubmit = function (event) {
        event.preventDefault();
        void start(linkInput.value);
    };
    entry.onsubmit = function (event) {
        event.preventDefault();
        if (sending || !loaded || !pair) return;
        if (expired()) {
            forget();
            say(
                "This pairing link has expired. Open a new session on your TV."
            );
            return;
        }
        if (!hereNowValidValue(valueInput.value)) {
            say("Text is too long. Please shorten it before sending.");
            return;
        }
        sending = true;
        button.disabled = true;
        // Freeze the submitted value, including retries after an uncertain POST.
        valueInput.readOnly = true;
        var current = pair;
        var revision = generation;
        (async function () {
            try {
                var envelope =
                    reply ||
                    (await hereNowSeal(w, current, "reply", {
                        value: valueInput.value,
                    }));
                if (generation !== revision || expired()) return;
                reply = envelope;
                await store.patch(current.recordId, { reply: reply });
                if (generation !== revision) return;
                forget();
                say("Text sent. Check your TV to confirm it appeared.");
            } catch (_) {
                if (generation !== revision) return;
                if (!reply) {
                    valueInput.readOnly = false;
                    locale.label(button, "Send to TV");
                    say(
                        "Could not prepare this text. Please shorten it and try again."
                    );
                    return;
                }
                say(
                    "Delivery could not be confirmed. Check your TV, or retry the same message before this session expires."
                );
                locale.label(button, "Retry same message");
            } finally {
                if (generation === revision) {
                    sending = false;
                    button.disabled = false;
                }
            }
        })();
    };
    document.getElementById("cancel")!.onclick = function () {
        var id = pair && pair.recordId;
        forget();
        if (id && store) store.remove(id).catch(function () {});
        say("Session closed. Start a new one from your TV when needed.");
    };
    w.addEventListener("pagehide", forget);
    // Keep capability out of persistent browser history as soon as it is read.
    function openFragment(): void {
        var initial = w.location.hash;
        if (!initial) return;
        try {
            w.history.replaceState(null, "", w.location.pathname);
        } catch (_) {
            say("Could not protect the private link. Use a different browser.");
            return;
        }
        void start(initial);
    }
    w.addEventListener("hashchange", openFragment);
    w.addEventListener("pageshow", function (event: any) {
        if (!event.persisted) return;
        forget();
        if (w.location.hash) openFragment();
        else {
            pairing.hidden = false;
            say(
                "Scan the QR code on your TV, or paste its complete private pairing link below."
            );
        }
    });
    void locale.setLanguage(locale.browserLanguage());
    openFragment();
})();
