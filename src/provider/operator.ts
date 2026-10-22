/** HTTP/UI effects only; the shared core owns request routes, retry state and timeouts. */
function operatorLoadPlaylist(
    url: string,
    success: (data: string) => void,
    complete: () => void,
    profile: string = "classic",
    failed?: (request: any, status: string, error: any) => void
): void {
    const runtime = window as any;
    if (typeof runtime.launch_id === "undefined") runtime.launch_id = "#launch";
    const plan = new runtime.OttPlayCore.OperatorPlaylistClient(
        url,
        runtime.host,
        typeof runtime.stbInterceptRequest === "function",
        profile,
        encodeURIComponent
    );
    const intercepted = plan.interceptUrl();
    if (intercepted) runtime.stbInterceptRequest(intercepted);
    function send(request: any): void {
        if (!request) {
            complete();
            return;
        }
        request.success = function (data: string): void {
            plan.accept();
            success(data);
        };
        request.error = function (xhr: any, status: string, error: any): void {
            plan.reject();
            const next = plan.request();
            if (next) {
                if (plan.progress())
                    runtime.$(runtime.launch_id).append("p...");
                send(next);
            } else if (failed) failed(xhr, status, error);
            else {
                if (profile === "classic")
                    runtime.console.log(
                        "channels : jqXHR:" +
                            JSON.stringify(xhr) +
                            "; textStatus: " +
                            status +
                            ", errorThrown: " +
                            error
                    );
                runtime.alert(
                    runtime._(
                        profile === "generic"
                            ? "Failed to load!"
                            : "Failed to load channel list!"
                    )
                );
                complete();
            }
        };
        runtime.$.ajax(request);
    }
    send(plan.request());
}
(window as any).operatorLoadPlaylist = operatorLoadPlaylist;

/** Shared native DOM codec: xml2json — Stefan Goessner / Creative Commons GNU LGPL 2.1.
 * Domain catalog policy is supplied by the common core. */
function operatorXmlToJson(xml: any, tab: any): string {
    var X: any = {
        escape: function (txt: any): any {
            return txt
                .replace(/[\\]/g, "\\\\")
                .replace(/[\"]/g, '\\"')
                .replace(/[\n]/g, "\\n")
                .replace(/[\r]/g, "\\r");
        },
        innerXml: function (node: any): any {
            var s = "";
            if ("innerHTML" in node) s = node.innerHTML;
            else {
                var asXml = function (n: any): any {
                    var s = "";
                    if (n.nodeType == 1) {
                        s += "<" + n.nodeName;
                        for (var i = 0; i < n.attributes.length; i++)
                            s +=
                                " " +
                                n.attributes[i].nodeName +
                                '="' +
                                (n.attributes[i].nodeValue || "").toString() +
                                '"';
                        if (n.firstChild) {
                            s += ">";
                            for (var c = n.firstChild; c; c = c.nextSibling)
                                s += asXml(c);
                            s += "</" + n.nodeName + ">";
                        } else s += "/>";
                    } else if (n.nodeType == 3) s += n.nodeValue;
                    else if (n.nodeType == 4)
                        s += "<![CDATA[" + n.nodeValue + "]]>";
                    return s;
                };
                for (var c = node.firstChild; c; c = c.nextSibling)
                    s += asXml(c);
            }
            return s;
        },
        removeWhite: function (e: any): any {
            e.normalize();
            for (var n = e.firstChild; n; ) {
                if (n.nodeType == 3) {
                    if (!n.nodeValue.match(/[^ \f\n\r\t\v]/)) {
                        var nxt = n.nextSibling;
                        e.removeChild(n);
                        n = nxt;
                    } else n = n.nextSibling;
                } else if (n.nodeType == 1) {
                    X.removeWhite(n);
                    n = n.nextSibling;
                } else n = n.nextSibling;
            }
            return e;
        },
        toJson: function (o: any, name: any, ind: any): any {
            var json = name ? '"' + name + '"' : "";
            if (o instanceof Array) {
                for (var i = 0, n = o.length; i < n; i++)
                    o[i] = X.toJson(o[i], "", ind + "\t");
                json +=
                    (name ? ":[" : "[") +
                    (o.length > 1
                        ? "\n" +
                          ind +
                          "\t" +
                          o.join(",\n" + ind + "\t") +
                          "\n" +
                          ind
                        : o.join("")) +
                    "]";
            } else if (o == null) json += (name && ":") + "null";
            else if (typeof o == "object") {
                var arr: string[] = [];
                for (var m in o)
                    arr[arr.length] = X.toJson(o[m], m, ind + "\t");
                json +=
                    (name ? ":{" : "{") +
                    (arr.length > 1
                        ? "\n" +
                          ind +
                          "\t" +
                          arr.join(",\n" + ind + "\t") +
                          "\n" +
                          ind
                        : arr.join("")) +
                    "}";
            } else if (typeof o == "string")
                json += (name && ":") + '"' + o.toString() + '"';
            else json += (name && ":") + o.toString();
            return json;
        },
        toObj: function (xml: any): any {
            var o: any = {};
            if (xml.nodeType == 1) {
                if (xml.attributes.length)
                    for (var i = 0; i < xml.attributes.length; i++)
                        o["@" + xml.attributes[i].nodeName] = (
                            xml.attributes[i].nodeValue || ""
                        ).toString();
                if (xml.firstChild) {
                    var textChild = 0,
                        cdataChild = 0,
                        hasElementChild = false;
                    for (var n = xml.firstChild; n; n = n.nextSibling) {
                        if (n.nodeType == 1) hasElementChild = true;
                        else if (
                            n.nodeType == 3 &&
                            n.nodeValue.match(/[^ \f\n\r\t\v]/)
                        )
                            textChild++;
                        else if (n.nodeType == 4) cdataChild++;
                    }
                    if (hasElementChild) {
                        if (textChild < 2 && cdataChild < 2) {
                            X.removeWhite(xml);
                            for (
                                var n2 = xml.firstChild;
                                n2;
                                n2 = n2.nextSibling
                            ) {
                                if (n2.nodeType == 3)
                                    o["#text"] = X.escape(n2.nodeValue);
                                else if (n2.nodeType == 4)
                                    o["#cdata"] = X.escape(n2.nodeValue);
                                else if (o[n2.nodeName]) {
                                    if (o[n2.nodeName] instanceof Array)
                                        o[n2.nodeName][o[n2.nodeName].length] =
                                            X.toObj(n2);
                                    else
                                        o[n2.nodeName] = [
                                            o[n2.nodeName],
                                            X.toObj(n2),
                                        ];
                                } else o[n2.nodeName] = X.toObj(n2);
                            }
                        } else {
                            if (!xml.attributes.length)
                                o = X.escape(X.innerXml(xml));
                            else o["#text"] = X.escape(X.innerXml(xml));
                        }
                    } else if (textChild) {
                        if (!xml.attributes.length)
                            o = X.escape(X.innerXml(xml));
                        else o["#text"] = X.escape(X.innerXml(xml));
                    } else if (cdataChild) {
                        if (cdataChild > 1) o = X.escape(X.innerXml(xml));
                        else
                            for (
                                var n3 = xml.firstChild;
                                n3;
                                n3 = n3.nextSibling
                            )
                                o = X.escape(n3.nodeValue);
                    }
                }
                if (!(xml.attributes.length || xml.firstChild)) o = null;
            } else if (xml.nodeType == 9) o = X.toObj(xml.documentElement);
            return o;
        },
    };
    if (xml.nodeType == 9) xml = xml.documentElement;
    var json = X.toJson(X.toObj(X.removeWhite(xml)), xml.nodeName, "\t");
    return (
        "{\n" +
        tab +
        (tab ? json.replace(/\t/g, tab) : json.replace(/\t|\n/g, "")) +
        "\n}"
    );
}
(window as any).operatorXmlToJson = operatorXmlToJson;

function operatorMediaPlaylist(profile: string, data: string): void {
    const runtime = window as any;
    try {
        runtime.mediaName = runtime.mediaName || "?";
        runtime.mediaRecords = [];
        runtime.OttPlayCore.parsePlaylistMedia(data).forEach(function (
            entry: any
        ): void {
            const name = entry.generatedName
                ? profile === "antifriz"
                    ? runtime._("Untitled")
                    : runtime._("??? No channel name")
                : entry.name;
            var record: any = {
                description:
                    "<table><h2><center>" +
                    name +
                    "</center></h2>" +
                    (entry.logo
                        ? '<img id="detal" height="285" src="' +
                          entry.logo +
                          '" style="float: left; margin-right: 5px; margin-bottom: 5px; border-width: 0px; border-style: solid;" width="210">'
                        : "") +
                    "</table>",
                logo_30x30: entry.logo,
                stream_url: entry.url,
                title: name,
            };
            if (entry.generatedName)
                record.__ottMediaLabel = {
                    heading: true,
                    key:
                        profile === "antifriz"
                            ? "Untitled"
                            : "??? No channel name",
                    value: name,
                };
            runtime.mediaRecords.push(record);
        });
    } catch (error) {
        runtime.alert(runtime._("Unable to load playlist") + " (M3U)");
    }
}
(window as any).operatorMediaPlaylist = operatorMediaPlaylist;

/** The host retains HTTP, DOM parsing, stale view checks and UI effects. */
function operatorLoadVod(profile: string, url: string, callback: any): void {
    const runtime = window as any;
    runtime.mediaUrls[runtime.mediaUrls.length - 1] = url;
    if (url === "") {
        callback();
        return;
    }
    runtime
        .$("#dialogbox")
        .html(
            '<span class="ott-spinner ott-spinner--inline" aria-hidden="true"><span class="blob"></span><span class="blob"></span><span class="blob"></span><span class="blob"></span></span> ' +
                runtime._("Download! Wait ...")
        )
        .show();
    runtime.$.ajax({
        complete: function (): void {
            if (callback.isCurrent && !callback.isCurrent()) return;
            runtime.$("#dialogbox").hide();
            callback();
        },
        dataType: "text",
        success: function (data: string): void {
            if (callback.isCurrent && !callback.isCurrent()) return;
            try {
                const content = runtime.OttPlayCore.operatorVodContent(data);
                data = content.text;
                if (content.format === "XML") {
                    try {
                        data = operatorXmlToJson(
                            runtime.jQuery.parseXML(data),
                            " "
                        );
                    } catch (error) {
                        runtime.alert(
                            runtime._("Unable to load playlist") + " (XML)"
                        );
                        return;
                    }
                } else if (content.format === "M3U") {
                    operatorMediaPlaylist(profile, data);
                    return;
                }
                let decoded: any;
                try {
                    decoded = JSON.parse(data);
                } catch (error) {
                    runtime.alert(
                        runtime._("Unable to load playlist") + " (JSON)"
                    );
                    return;
                }
                const catalog = runtime.OttPlayCore.operatorVodCatalog(
                    decoded,
                    runtime.mediaName
                );
                runtime.mediaName = catalog.name;
                runtime.mediaRecords = catalog.records;
            } catch (error) {
                runtime.console.log(error);
            }
        },
        timeout: 60000,
        url: runtime.OttPlayCore.operatorVodUrl(
            profile,
            url,
            runtime.box_mac || ""
        ),
    });
}
(window as any).operatorLoadVod = operatorLoadVod;

function operatorPublishCatalog(catalog: any): void {
    const runtime = window as any;
    runtime.cList = catalog.ids;
    runtime.channels = catalog.channels;
    runtime.cats = catalog.groups;
    runtime.catsArray = catalog.groupOrder;
}

function operatorParsePlaylist(data: string, complete: () => void): void {
    const runtime = window as any;
    operatorPublishCatalog({
        channels: {},
        groupOrder: [],
        groups: {},
        ids: [],
    });
    try {
        operatorPublishCatalog(
            runtime.OttPlayCore.parseProviderPlaylist(
                data,
                "generic",
                function (url: string): number {
                    return runtime.xxHash32S(url, true);
                },
                0
            )
        );
    } catch (error) {
        runtime.console.log(error);
    }
    complete();
}
(window as any).operatorParsePlaylist = operatorParsePlaylist;

function operatorGenericPlaylist(config: any, complete: () => void): void {
    const runtime = window as any;
    runtime.$(runtime.launch_id).append(runtime._("Loading M3U..."));
    operatorLoadPlaylist(
        config.m3u,
        function (data: string): void {
            operatorParsePlaylist(data, complete);
        },
        complete,
        "generic"
    );
}
(window as any).operatorGenericPlaylist = operatorGenericPlaylist;

function operatorGenericSession(config: any, complete: () => void): void {
    const runtime = window as any;
    runtime.$(runtime.launch_id).append(runtime._("Loading from API..."));
    const client = new runtime.OttPlayCore.OperatorClient(
        config,
        encodeURIComponent,
        function (name: string): number {
            return runtime.xxHash32S(name, true);
        }
    );
    runtime.$.ajax({
        dataType: "json",
        timeout: 15000,
        type: "GET",
        url: client.request(),
    })
        .done(function (response: any): void {
            try {
                client.accept(response);
            } finally {
                operatorPublishCatalog(client.catalog());
            }
            if (client.action() === "PLAYLIST") {
                config.m3u = client.request();
                operatorGenericPlaylist(config, complete);
                return;
            }
            complete();
        })
        .fail(function (): void {
            client.reject();
            config.m3u = client.request();
            operatorGenericPlaylist(config, complete);
        });
}
(window as any).operatorGenericSession = operatorGenericSession;

function operatorLoadGuide(
    profile: string,
    id: any,
    options: any,
    callback: any,
    current: boolean
): void {
    const runtime = window as any;
    const guide = new runtime.OttPlayCore.OperatorGuideClient(profile, current);
    function request(): void {
        const phase = guide.phase();
        if (!phase) {
            callback(id, guide.result());
            return;
        }
        runtime.$.ajax({
            complete: function (): void {
                guide.complete();
                request();
            },
            dataType: "jsonp",
            success: function (data: any): void {
                guide.accept(data, phase, options.rec);
            },
            timeout: 10000,
            url: runtime.OttPlayCore.operatorGuideUrl(
                profile,
                String(id),
                options,
                phase
            ),
        });
    }
    request();
}
(window as any).operatorLoadGuide = operatorLoadGuide;
