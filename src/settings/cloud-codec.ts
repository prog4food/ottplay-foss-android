/** Versioned cloud transport for raw storage strings, including compressed UTF-16. */
var cloudXmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>';
var cloudXmlDoctype =
    '<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">';
var cloudXmlVersion = "<!--ottplay-storage-v2-->";
var cloudXmlComment = "<comment>OTT-Play Preferences</comment>";

function cloudCodecFailure(): never {
    throw new Error("Invalid cloud settings document");
}
function cloudCodecKey(key: string): void {
    if (key === "__proto__" || key === "constructor" || key === "prototype")
        cloudCodecFailure();
}
function cloudCodecEncode(value: string): string {
    // Old JSON.stringify implementations can emit lone surrogates literally.
    // Escaping all surrogate units also preserves pairs without XML normalization.
    return JSON.stringify(value)
        .replace(/[\u0000-\u001f\ud800-\udfff\ufffe\uffff]/g, function (unit) {
            return "\\u" + ("0000" + unit.charCodeAt(0).toString(16)).slice(-4);
        })
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
function cloudCodecDecode(value: string): string {
    if (/[\u0000-\u001f\ud800-\udfff\ufffe\uffff]/.test(value))
        cloudCodecFailure();
    var entities: Record<string, string> = {
        "&amp;": "&",
        "&apos;": "'",
        "&gt;": ">",
        "&lt;": "<",
        "&quot;": '"',
    };
    var decoded = JSON.parse(
        value.replace(/&(?:amp|apos|gt|lt|quot);|[<&]/g, function (entity) {
            return entities[entity] || cloudCodecFailure();
        })
    );
    if (typeof decoded !== "string") cloudCodecFailure();
    return decoded;
}
function cloudCodecPortable(
    items: Record<string, string>,
    portable: (key: string) => boolean
): Record<string, string> {
    var result: Record<string, string> = Object.create(null);
    Object.keys(items).forEach(function (key) {
        if (portable(key))
            result[key] =
                key === "parentPIN"
                    ? (window as any).__ottPinSecurity.prepare(items[key])
                    : items[key];
    });
    return result;
}
function readCloudSettings(
    xml: string,
    portable: (key: string) => boolean
): Record<string, string> {
    if (typeof xml !== "string") cloudCodecFailure();
    var at = xml.charAt(0) === "\ufeff" ? 1 : 0;
    function space(): void {
        while (at < xml.length && /[\t\n\r ]/.test(xml.charAt(at))) at++;
    }
    function take(token: string): boolean {
        if (xml.substr(at, token.length) !== token) return false;
        at += token.length;
        return true;
    }
    function expect(token: string): void {
        if (!take(token)) cloudCodecFailure();
    }
    space();
    take(cloudXmlDeclaration);
    space();
    // This is a fixed framing token, never a request to resolve a DTD.
    take(cloudXmlDoctype);
    space();
    var versioned = take(cloudXmlVersion);
    space();
    expect("<properties>");
    space();
    expect(cloudXmlComment);
    var items: Record<string, string> = Object.create(null);
    while (true) {
        space();
        if (take("</properties>")) break;
        expect('<entry key="');
        var end = xml.indexOf('\">', at);
        if (end < 0) cloudCodecFailure();
        var key = xml.slice(at, end);
        if (/["<]/.test(key)) cloudCodecFailure();
        at = end + 2;
        end = xml.indexOf("</entry>", at);
        if (end < 0) cloudCodecFailure();
        var value = xml.slice(at, end);
        at = end + 8;
        if (versioned) {
            key = cloudCodecDecode(key);
            value = cloudCodecDecode(value);
        } else if (
            /<\/?(?:entry|properties)(?:[\t\n\r >])|<!|<\?/.test(value)
        ) {
            // Old exports did not escape text. Keep entities literal; reject
            // structural delimiters that could instead be another entry/root.
            cloudCodecFailure();
        }
        cloudCodecKey(key);
        if (Object.prototype.hasOwnProperty.call(items, key))
            cloudCodecFailure();
        items[key] = value;
    }
    space();
    if (at !== xml.length) cloudCodecFailure();
    // Validate the entire document, including excluded keys, before filtering.
    return cloudCodecPortable(items, portable);
}
function writeCloudSettings(
    items: Record<string, string>,
    portable: (key: string) => boolean
): string {
    if (!items || typeof items !== "object" || Array.isArray(items))
        cloudCodecFailure();
    var copy: Record<string, string> = Object.create(null);
    Object.keys(items).forEach(function (key) {
        cloudCodecKey(key);
        var value = items[key];
        if (typeof value !== "string") cloudCodecFailure();
        copy[key] = value;
    });
    copy = cloudCodecPortable(copy, portable);
    var lines = [
        cloudXmlDeclaration,
        cloudXmlDoctype,
        cloudXmlVersion,
        "<properties>",
        cloudXmlComment,
    ];
    Object.keys(copy).forEach(function (key) {
        lines.push(
            '<entry key="' +
                cloudCodecEncode(key) +
                '\">' +
                cloudCodecEncode(copy[key]) +
                "</entry>"
        );
    });
    lines.push("</properties>");
    return lines.join("\n");
}
(window as any).__ottCloudSettingsCodec = {
    read: function (xml: string) {
        return readCloudSettings(xml, function (key) {
            return (window as any).isPortableSettingsKey(key);
        });
    },
    write: function (items: Record<string, string>) {
        return writeCloudSettings(items, function (key) {
            return (window as any).isPortableSettingsKey(key);
        });
    },
};
