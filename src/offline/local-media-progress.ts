/** Explain actual local-source work without implying media bytes are copied. */
export function formatLocalMediaProgress(
    value: any,
    translate: (text: string) => string
): string {
    if (value.phase === "picker-folder")
        return translate("Choose a folder in the browser window");
    if (value.phase === "picker-files")
        return translate("Choose files in the browser window");
    var playable = (value.items || []).filter(function (item: any) {
        return item.available !== false && !!item.url;
    }).length;
    var result = translate("Local videos") + ": " + playable;
    if (typeof value.discovered === "number")
        result += " · " + translate("Entries found") + ": " + value.discovered;
    if (value.phase === "enumerating")
        result += " · " + translate("Reading folder entries");
    else if (value.phase === "metadata")
        result += " · " + translate("Reading file information");
    else if (value.phase === "permission")
        result += " · " + translate("Checking folder permission");
    return result;
}

/** Initial browser enumeration may warm a large network directory's metadata. */
export function localMediaProgressTimeout(value: any): number {
    return value.phase === "enumerating" &&
        !(value.items || []).some(function (item: any) {
            return item.available !== false && !!item.url;
        })
        ? 600000
        : 60000;
}
