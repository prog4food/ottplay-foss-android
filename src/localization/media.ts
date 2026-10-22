import {
    languageLocales,
    languageLocaleTag,
    resolveLanguagePreferences,
} from "./assets";

/** Common ISO-639 bibliographic/terminologic tags carried by media manifests. */
function mediaLanguage(tag: string): string {
    var base = tag.toLowerCase().replace(/_/g, "-").split("-")[0];
    var aliases: Record<string, string> = {
        ces: "cs",
        deu: "de",
        ell: "el",
        eus: "eu",
        fas: "fa",
        fre: "fr",
        hye: "hy",
        in: "id",
        isl: "is",
        iw: "he",
        kat: "ka",
        lat: "la",
        lav: "lv",
        mkd: "mk",
        msa: "ms",
        mya: "my",
        nld: "nl",
        no: "nb",
        nob: "nb",
        nor: "nb",
        ron: "ro",
        rum: "ro",
        slk: "sk",
        sqi: "sq",
        tgl: "fil",
        tl: "fil",
        zho: "zh",
    };
    if (Object.prototype.hasOwnProperty.call(aliases, base))
        return aliases[base];
    // Most stored IDs use ISO 639-2; _lat is Latvian, not Latin, and _rou
    // remains a nonstandard Romanian alias for existing media manifests.
    var code = "_" + base;
    return Object.prototype.hasOwnProperty.call(languageLocales, code)
        ? languageLocaleTag(code).split("-")[0]
        : base;
}

/** Defaults never choose another language when the requested track is absent. */
export function preferredTrackIndex(
    kind: string,
    preference: string,
    tracks: any[] | null | undefined
): number | undefined {
    if (kind !== "audio" && kind !== "subtitle") return undefined;
    if (kind === "subtitle" && preference === "off") return 0;
    if (!Object.prototype.hasOwnProperty.call(languageLocales, preference))
        return undefined;
    var expected = languageLocaleTag(preference).toLowerCase();
    var base = mediaLanguage(expected);
    var fallback: number | undefined;
    for (var i = 0; tracks && i < tracks.length; i++) {
        var track = tracks[i];
        if (
            !track ||
            typeof track.language !== "string" ||
            typeof track.id !== "number" ||
            !isFinite(track.id) ||
            track.id < (kind === "audio" ? 0 : 1) ||
            Math.floor(track.id) !== track.id
        )
            continue;
        var tag = track.language.toLowerCase().replace(/_/g, "-");
        var canonical =
            mediaLanguage(tag) + tag.slice(tag.split("-")[0].length);
        if (canonical === expected) return track.id;
        // Written subtitles must not silently use a conflicting script (e.g. sr-Latn
        // or zh-Hant for a Cyrillic/Simplified preference). Audio has no script.
        if (
            fallback === undefined &&
            mediaLanguage(tag) === base &&
            (kind === "audio" ||
                resolveLanguagePreferences([canonical]) === preference)
        )
            fallback = track.id;
    }
    return fallback;
}
