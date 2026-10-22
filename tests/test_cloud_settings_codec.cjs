const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { parse } = require("acorn");
const { storagePolicySource } = require("./helpers/cloud-source-fixture.cjs");
const root = path.resolve(__dirname, "..");
const w = vm.createContext({ console });
w.window = w;
require("./helpers/shared-core-runtime.cjs")(w, { vendorOnly: true });
vm.runInContext(storagePolicySource(), w);
require("./helpers/private-runtime.cjs")(w, "src/settings/cloud-codec.ts");
require("./helpers/pin-runtime.cjs")(w);
const codec = w.__ottCloudSettingsCodec;
const normalized = (value) => JSON.parse(JSON.stringify(value));
const legacy = (entries) =>
    "<properties><comment>OTT-Play Preferences</comment>" +
    entries +
    "</properties>";
const entry = (key, value) => '<entry key="' + key + '">' + value + "</entry>";
let groups = 0;
function group(name, run) {
    run();
    groups++;
    console.log("PASS " + name);
}

group(
    "versioned storage round-trip preserves XML, compression and all UTF-16 units",
    () => {
        const units = [];
        for (let i = 0; i <= 0xffff; i++) units.push(String.fromCharCode(i));
        const items = Object.create(null);
        items["ordinary"] = 'amp &amp; <entry key="x"> > \' "\r\n';
        items["compressed"] = "\x01LZ\x01" + units.join("");
        items['\x00\ud800<&"\uffff'] = "\udc00";
        items[""] = "";
        const xml = codec.write(items);
        assert(xml.includes("<!--ottplay-storage-v2-->"));
        assert(xml.includes("<comment>OTT-Play Preferences</comment>"));
        assert(
            xml.includes(
                '<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">'
            )
        );
        assert(
            !/[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]/.test(xml)
        );
        assert.deepEqual(normalized(codec.read(xml)), normalized(items));
        assert.equal(Object.getPrototypeOf(codec.read(xml)), null);
    }
);

group("old JSON.stringify that emits lone surrogates is supported", () => {
    vm.runInContext(
        `var savedStringify = JSON.stringify; JSON.stringify = function(value) {
        return savedStringify(value).replace(/\\\\u(d[89a-f][0-9a-f]{2})/gi, function(_, hex) { return String.fromCharCode(parseInt(hex,16)); });
    };`,
        w
    );
    try {
        const value = "\ud800 lone \udfff";
        const xml = codec.write({ value });
        assert(!/[\ud800-\udfff]/.test(xml));
        assert.equal(codec.read(xml).value, value);
    } finally {
        vm.runInContext("JSON.stringify = savedStringify;", w);
    }
});

group(
    "genuine retained serializer output reads without entity reinterpretation",
    () => {
        const fixture = JSON.parse(
            fs.readFileSync(
                path.join(__dirname, "fixtures/cloud/legacy.json"),
                "utf8"
            )
        );
        assert.deepEqual(normalized(codec.read(fixture.xml)), fixture.expected);
        assert.deepEqual(normalized(codec.read(legacy(entry("a", "&amp;")))), {
            a: "&amp;",
        });
    }
);

group(
    "installation keys are excluded from both versions and from output",
    () => {
        const keys = [
            "commandServerAddress",
            "commandServerToken",
            "commandServerEnabled",
            "sLocalHttpEnabled",
            "sLocalHttpDeviceCode",
            "stb_settings_backup",
        ];
        const input = { ordinary: "value" };
        for (const key of keys) input[key] = "secret";
        assert.deepEqual(normalized(codec.read(codec.write(input))), {
            ordinary: "value",
        });
        assert(!codec.write(input).includes("secret"));
        assert.deepEqual(
            normalized(
                codec.read(
                    legacy(
                        Object.keys(input)
                            .map((key) => entry(key, input[key]))
                            .join("")
                    )
                )
            ),
            { ordinary: "value" }
        );
    }
);

group(
    "fallback protocol metadata cannot migrate through either cloud format",
    () => {
        const metadata = [
            "ottplayStorageFallback",
            "ottplayStorageFallback.0",
            "ottplayStorageFallback.12",
            "ottplayStorageFallback.pending",
        ];
        const ordinary = {
            ottplaylang: "_rus",
            ottplaylangmode: "manual",
            ottplayStorageFallbackCustom: "ordinary setting",
            "provider:ottplayStorageFallback.0": "provider payload",
        };
        const input = { ...ordinary };
        for (const key of metadata) input[key] = "internal bookkeeping";
        assert.deepEqual(normalized(codec.read(codec.write(input))), ordinary);
        assert(!codec.write(input).includes("internal bookkeeping"));
        const legacyXml = legacy(
            Object.keys(input)
                .map((key) => entry(key, input[key]))
                .join("")
        );
        assert.deepEqual(normalized(codec.read(legacyXml)), ordinary);
        for (const key of metadata) {
            // A v2 document produced by an older/importing installation may contain
            // protocol keys even though the current writer excludes them.
            const xml = codec
                .write({ ordinary: "internal bookkeeping" })
                .replace("&quot;ordinary&quot;", "&quot;" + key + "&quot;");
            assert.deepEqual(normalized(codec.read(xml)), {});
        }
    }
);

group("duplicate and prototype keys rejected even when excluded", () => {
    for (const key of [
        "ordinary",
        "commandServerToken",
        "__proto__",
        "constructor",
        "prototype",
    ]) {
        assert.throws(() =>
            codec.read(legacy(entry(key, "a") + entry(key, "b")))
        );
        if (["__proto__", "constructor", "prototype"].includes(key)) {
            assert.throws(() => codec.read(legacy(entry(key, "a"))));
            assert.throws(() => codec.write(JSON.parse('{"' + key + '":"a"}')));
        }
    }
    const xml = codec.write({ ordinary: "a" });
    const line = xml.split("\n").find((line) => line.startsWith("<entry"));
    assert.throws(() => codec.read(xml.replace(line, line + line)));
    for (const key of ["__proto__", "constructor", "prototype"])
        assert.throws(() => codec.read(xml.replace("ordinary", key)));
});

group("complete validation precedes filter calls", () => {
    const original = w.OttPlayCore.classicPortableKey;
    let calls = 0;
    w.OttPlayCore.classicPortableKey = () => {
        calls++;
        return true;
    };
    try {
        assert.throws(() =>
            codec.read(
                legacy(entry("ordinary", "ok") + '<entry key="bad">truncated')
            )
        );
        assert.equal(calls, 0);
        assert.throws(() =>
            codec.write({ commandServerToken: {}, ordinary: "ok" })
        );
        assert.equal(calls, 0);
    } finally {
        w.OttPlayCore.classicPortableKey = original;
    }
});

group(
    "malformed framing, injected structure, external entities and unknown versions reject",
    () => {
        const xml = codec.write({ ordinary: "ok" });
        const invalid = [
            "",
            "<comment>OTT-Play Preferences</comment>",
            xml + "garbage",
            xml + xml,
            xml.replace("storage-v2", "storage-v3"),
            xml.replace("properties.dtd", "evil.dtd"),
            xml.replace("<properties>", '<properties extra="x">'),
            xml.replace("</properties>", ""),
            xml.replace("</entry>", ""),
            xml.replace("&quot;ok&quot;", "&quot;&unknown;&quot;"),
            xml.replace("&quot;ok&quot;", "&quot;&#65;&quot;"),
            xml.replace("&quot;ok&quot;", "&quot;unclosed&bogus&quot;"),
            xml.replace("&quot;ok&quot;", '<![CDATA["ok"]]>'),
            xml.replace("&quot;ok&quot;", "null"),
            xml.replace("&quot;ok&quot;", "{}"),
            xml.replace("&quot;ordinary&quot;", "null"),
            xml.replace("&quot;ok&quot;", "&quot;\x00&quot;"),
            legacy(entry("a", 'before <entry key="b">after')),
            legacy(entry("a", "before </properties> after")),
            legacy(entry("a", "<!DOCTYPE anything>")),
            legacy(entry("a", "<?xml anything?>")),
            legacy(entry('a"bad', "value")),
            '<!DOCTYPE properties [<!ENTITY stolen SYSTEM "file:///etc/passwd">]>' +
                legacy(entry("a", "&stolen;")),
        ];
        for (const input of invalid)
            assert.throws(() => codec.read(input), input.slice(0, 200));
        assert.throws(() => codec.read(null));
        assert.throws(() => codec.write(null));
        assert.throws(() => codec.write([]));
    }
);

group(
    "legacy fixtures keep literal values, empty strings and whitespace",
    () => {
        const input = {
            empty: "",
            entity: "&amp;lt;",
            html: "<b>x</b>",
            quotes: 'a">b',
            whitespace: "\r\n\t  ",
        };
        const xml = legacy(
            Object.keys(input)
                .map((key) => entry(key, input[key]))
                .join("\n")
        );
        assert.deepEqual(
            normalized(codec.read("\ufeff \n" + xml + "\r\n")),
            input
        );
        assert.deepEqual(normalized(codec.read(legacy(""))), {});
    }
);

group(
    "ES5 source compiles and uses no browser XML or modern encoding services",
    () => {
        const source = fs.readFileSync(
            path.join(root, "src/settings/cloud-codec.ts"),
            "utf8"
        );
        const compiled = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES5 },
        }).outputText;
        parse(compiled, { ecmaVersion: 5 });
        for (const unsupported of [
            "DOMParser",
            "TextEncoder",
            "TextDecoder",
            "btoa",
            "atob",
            "fetch(",
            "new Map",
            "new Set",
        ])
            assert(!compiled.includes(unsupported), unsupported);
    }
);
group(
    "PIN export and legacy XML import never produce new plaintext storage",
    () => {
        const exported = codec.write({ ordinary: "kept", parentPIN: "2468" });
        const stored = codec.read(exported);
        assert.match(
            stored.parentPIN,
            /^pbkdf2-sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}$/
        );
        assert.equal(stored.ordinary, "kept");
        assert.equal(
            codec.read(codec.write(stored)).parentPIN,
            stored.parentPIN
        );
        const imported = codec.read(legacy(entry("parentPIN", "2468")));
        assert.match(imported.parentPIN, /^pbkdf2-sha256\$600000\$/);
        assert.notEqual(
            imported.parentPIN,
            stored.parentPIN,
            "legacy imports get fresh independent salts"
        );
        assert.throws(() => codec.read(legacy(entry("parentPIN", "damaged"))));
    }
);
console.log("Cloud settings codec: " + groups + " groups PASS");
