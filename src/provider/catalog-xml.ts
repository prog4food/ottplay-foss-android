/** DOM projection adapted from xml2json — Stefan Goessner / Creative Commons GNU LGPL 2.1.
 * Retains the provider object shape without serializing JSON or escaping data as JSON text. */
function catalogXmlObject(xml: any): any {
    function stripWhitespace(node: any): void {
        for (var child = node.firstChild; child; ) {
            var next = child.nextSibling;
            if (child.nodeType === 3 && !/[^ \f\n\r\t\v]/.test(child.nodeValue))
                node.removeChild(child);
            else if (child.nodeType === 1) stripWhitespace(child);
            child = next;
        }
    }
    function innerXml(node: any): string {
        if (typeof node.innerHTML === "string") return node.innerHTML;
        function serialize(value: any): string {
            if (value.nodeType === 3) return value.nodeValue;
            if (value.nodeType === 4)
                return "<![CDATA[" + value.nodeValue + "]]>";
            if (value.nodeType !== 1) return "";
            var text = "<" + value.nodeName;
            for (var index = 0; index < value.attributes.length; index++) {
                var attribute = value.attributes[index];
                text +=
                    " " + attribute.nodeName + '="' + attribute.nodeValue + '"';
            }
            return (
                text +
                (value.firstChild
                    ? ">" + innerXml(value) + "</" + value.nodeName + ">"
                    : "/>")
            );
        }
        var text = "";
        for (var child = node.firstChild; child; child = child.nextSibling)
            text += serialize(child);
        return text;
    }
    function read(node: any): any {
        var result: any = Object.create(null);
        if (node.nodeType !== 1) return result;
        var attributes = node.attributes.length;
        for (var index = 0; index < attributes; index++) {
            var attribute = node.attributes[index];
            result["@" + attribute.nodeName] = String(
                attribute.nodeValue || ""
            );
        }
        var textCount = 0,
            cdataCount = 0,
            elements = false;
        for (var child = node.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === 1) elements = true;
            else if (child.nodeType === 3) textCount++;
            else if (child.nodeType === 4) cdataCount++;
        }
        if (elements && textCount < 2 && cdataCount < 2) {
            for (
                var child = node.firstChild;
                child;
                child = child.nextSibling
            ) {
                if (child.nodeType === 3) result["#text"] = child.nodeValue;
                else if (child.nodeType === 4)
                    result["#cdata"] = child.nodeValue;
                else {
                    var name = child.nodeName;
                    var value = read(child);
                    if (!Object.prototype.hasOwnProperty.call(result, name))
                        result[name] = value;
                    else if (Array.isArray(result[name]))
                        result[name].push(value);
                    else result[name] = [result[name], value];
                }
            }
        } else if (elements || textCount) {
            var content = innerXml(node);
            if (!attributes) return content;
            result["#text"] = content;
        } else if (cdataCount) {
            if (cdataCount > 1) return innerXml(node);
            for (var child = node.firstChild; child; child = child.nextSibling)
                if (child.nodeType === 4) return child.nodeValue;
        }
        return attributes || node.firstChild ? result : null;
    }
    if (xml.nodeType === 9) xml = xml.documentElement;
    xml.normalize();
    stripWhitespace(xml);
    var result: any = Object.create(null);
    result[xml.nodeName] = read(xml);
    return result;
}

/** DOM decoding is a host effect; the media session receives plain catalog data. */
function decodeProviderCatalogXml(
    host: any,
    text: string,
    profile?: string
): any {
    if (profile !== "m3u") {
        var query = host.jQuery || host.$;
        return catalogXmlObject(query.parseXML(text));
    }
    function parse(value: string): any {
        var document = new host.DOMParser().parseFromString(value, "text/xml");
        return document.querySelector("parsererror") ? null : document;
    }
    var document = parse(text);
    if (!document) {
        var entity = host.document.createElement("textarea");
        text = text.replace(
            /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|&[a-z0-9]+;/gi,
            function (value) {
                if (value.charAt(0) !== "&") return value;
                entity.innerHTML = value;
                var decoded = entity.textContent;
                if (decoded === value) return "&amp;" + value.slice(1);
                return decoded.replace(/[<>&"'\t\n\r]/g, function (character) {
                    return "&#" + character.charCodeAt(0) + ";";
                });
            }
        );
        document = parse(text);
    }
    if (!document) {
        text = text.replace(
            /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|(title|description)>([^<>\n]+)</gi,
            function (_all, tag, value) {
                if (!tag) return _all;
                entity.innerHTML = value;
                return tag + "><![CDATA[" + entity.textContent + "]]><";
            }
        );
        document = parse(text);
    }
    if (!document) throw new Error("Error: Cannot parse fXML!");
    var result: any = { channels: [] };
    var fields = [
        "search_on",
        "adult",
        "title",
        "logo_30x30",
        "description",
        "playlist_url",
        "stream_url",
    ];
    var headings = ["playlist_name", "title", "next_page_url", "prev_page_url"];
    function append(node: any): void {
        if (node.tagName !== "channel" && node.tagName !== "menu") return;
        var record: any = { t: node.tagName };
        var found = false;
        for (
            var child = node.firstElementChild;
            child;
            child = child.nextElementSibling
        ) {
            if (fields.indexOf(child.tagName) === -1) continue;
            record[child.tagName] = child.textContent;
            found = true;
        }
        if (!found) return;
        // Leave generated labels to the media presentation boundary and its active language.
        if (!record.title) record.title = "";
        result.channels.push(record);
    }
    var first = document.documentElement;
    if (first && first.tagName === "items") first = first.firstElementChild;
    for (var node = first; node; node = node.nextElementSibling) {
        if (headings.indexOf(node.tagName) !== -1)
            result[node.tagName] = node.textContent;
        if (node.tagName === "channels" || node.tagName === "menu")
            for (
                var entry = node.firstElementChild;
                entry;
                entry = entry.nextElementSibling
            )
                append(entry);
        append(node);
    }
    if (!result.channels.length) throw new Error("Error: Bad fXML!");
    return result;
}

(window as any).__ottCatalogXml = { decode: decodeProviderCatalogXml };
