"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const acorn = require("acorn");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { declarations } = require("./helpers/playlist-fixture.cjs");
const bundleMode = process.argv[2] === "--bundle";
const profiles = bundleMode
    ? process.argv[3]
        ? [process.argv[3]]
        : [
              "dist/player.js",
              "src-tauri/frontend/dist/player.js",
              "dist-mobile/dist/player.js",
          ]
    : [null];
for (const profile of profiles) {
    const dom = new JSDOM("", { runScripts: "outside-only" });
    const w = dom.window;
    const realm = dom.getInternalVMContext();
    if (profile) {
        const file = path.resolve(profile);
        const text = fs.readFileSync(file, "utf8");
        acorn.parse(text, { ecmaVersion: 5 });
        const ast = ts.createSourceFile(
            file,
            text,
            ts.ScriptTarget.Latest,
            true
        );
        const expressions = [];
        function split(node) {
            if (ts.isParenthesizedExpression(node)) split(node.expression);
            else if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.CommaToken
            ) {
                split(node.left);
                split(node.right);
            } else expressions.push(node);
        }
        for (const statement of ast.statements)
            if (ts.isExpressionStatement(statement))
                split(statement.expression);
        const publishers = expressions.filter((expression) => {
            let published = false;
            function visit(node) {
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    ts.isPropertyAccessExpression(node.left) &&
                    ts.isIdentifier(node.left.expression) &&
                    node.left.expression.text === "window" &&
                    node.left.name.text === "__ottCatalogXml"
                )
                    published = true;
                ts.forEachChild(node, visit);
            }
            visit(expression);
            return published;
        });
        assert.equal(
            publishers.length,
            1,
            "artifact must contain exactly one real private XML codec"
        );
        vm.runInContext(publishers[0].getText(ast) + ";", realm, {
            filename: file,
        });
    } else {
        require("./helpers/private-runtime.cjs")(
            realm,
            "src/provider/catalog-xml.ts"
        );
    }
    const plain = (value) => JSON.parse(JSON.stringify(value));
    const decode = (text, profile = "m3u") =>
        w.__ottCatalogXml.decode(w, text, profile);
    vm.runInContext(
        declarations("providers/m3u/provider.js")
            .filter((entry) =>
                ["fXMLCh2Json", "fXML_to_JSON"].includes(entry.name)
            )
            .map((entry) => entry.text)
            .join("\n"),
        realm
    );
    const cases = [
        "<items><playlist_name>Library</playlist_name><channel><title>One</title><stream_url>https://media.test/1</stream_url></channel></items>",
        "<items><title>Nested</title><channels><channel><title>A &amp; B</title><adult>1</adult><description><![CDATA[<b>Text</b>]]></description></channel></channels><next_page_url>page2</next_page_url></items>",
        "<menu><menu><title>Folder</title><playlist_url>folder</playlist_url></menu><channel><stream_url>movie</stream_url></channel></menu>",
        "<channels><channel><ignored>hidden</ignored></channel><channel><logo_30x30>icon</logo_30x30></channel></channels>",
        "<items><menu><title>Root menu</title><playlist_url>root</playlist_url></menu><prev_page_url>previous</prev_page_url></items>",
        '<?xml version="1.0"?><!-- preamble --><items><channel><title>Unicode — Ж</title><search_on>1</search_on></channel></items>',
    ];
    for (const text of cases) {
        const expected = {};
        assert(
            w.fXML_to_JSON(
                new w.DOMParser().parseFromString(text, "text/xml"),
                expected
            )
        );
        for (const item of expected.channels)
            if (item.title === "<Без названия>") item.title = "";
        assert.deepEqual(plain(decode(text)), plain(expected));
    }
    assert.equal(
        decode(
            "<items><channel><title>&lt;Без названия&gt;</title></channel></items>"
        ).channels[0].title,
        "<Без названия>",
        "Explicit provider titles stay intact even when they resemble the retired fallback"
    );
    assert.equal(
        decode("<items><channel><title>A&nbsp;B</title></channel></items>")
            .channels[0].title,
        "A\u00a0B"
    );
    assert.equal(
        decode(
            "<items><channel><title>A & B</title><description>X & Y</description></channel></items>"
        ).channels[0].description,
        "X & Y"
    );
    assert.throws(
        () => decode("<items><channel><title>unclosed"),
        /Cannot parse fXML/
    );
    assert.throws(
        () =>
            decode(
                "<items><channel><ignored>empty</ignored></channel></items>"
            ),
        /Bad fXML/
    );
    assert.throws(() => decode("<items/>"), /Bad fXML/);
    const first = decode(cases[0]);
    first.channels[0].title = "changed";
    assert.equal(decode(cases[0]).channels[0].title, "One");
    // The private decoder retains attribution and works without old global helpers.
    assert.equal(w.operatorXmlToJson, undefined);
    assert.equal(w.catalogXmlObject, undefined);
    w.jQuery = {
        parseXML: (text) => {
            const document = new w.DOMParser().parseFromString(
                text,
                "text/xml"
            );
            if (document.querySelector("parsererror"))
                throw Error("Invalid XML");
            return document;
        },
    };
    const operator = decode(
        '<items><channel id="7"><title><![CDATA[Film]]></title></channel></items>',
        "antifriz"
    );
    assert.equal(operator.items.channel["@id"], "7");
    assert.equal(operator.items.channel.title, "Film");
    // Compare valid historical object shapes with the retained licensed oracle.
    const oracle = declarations("src/provider/operator.ts").find(
        (entry) => entry.name === "operatorXmlToJson"
    );
    vm.runInContext(
        ts.transpileModule(oracle.text, {
            compilerOptions: { target: ts.ScriptTarget.ES5 },
        }).outputText,
        realm
    );
    const operatorCases = [
        '<items><channel id="7"><title>One</title><stream_url>https://media.test/a?x=1&amp;y=2</stream_url></channel></items>',
        "<items><channel><title>One</title></channel><channel><title>Two</title></channel></items>",
        '<items><menu enabled="1"><title>Folder</title><playlist_url>next</playlist_url></menu><empty/></items>',
        "<items><channel><description>Text <b>bold</b></description></channel></items>",
        "<items><channel><description>Text <b>bold</b> tail</description></channel></items>",
        '<items><channel><description format="html">Text <b>bold</b> tail</description></channel></items>',
        "<items><channel><description><![CDATA[<b>html</b>]]></description></channel></items>",
        "<items><channel><description><![CDATA[one]]><![CDATA[two]]></description></channel></items>",
        '<items><channel><description legacy="kept-shape"><![CDATA[only]]></description></channel></items>',
        "<items><channel><description><b>one</b><![CDATA[two]]></description></channel></items>",
        "<items><channel><description>  leading and trailing  </description></channel></items>",
        "<items>  <channel>\n<title>One</title>\n<empty/>  </channel>  </items>",
        "<items><!-- retained comment --><channel><title>One</title></channel></items>",
        '<items><channel tag="plain"><title>One</title></channel></items>',
        '<items><channel id="x"><![CDATA[A]]><![CDATA[B]]></channel></items>',
    ];
    for (const text of operatorCases) {
        const expected = JSON.parse(
            w.operatorXmlToJson(w.jQuery.parseXML(text), " ")
        );
        for (const profile of ["antifriz", "kb-team"])
            assert.deepEqual(
                plain(decode(text, profile)),
                plain(expected),
                text
            );
    }
    // Invalid manual JSON escaping previously rejected attributes or changed their data.
    for (const profile of ["antifriz", "kb-team"]) {
        const value = decode(
            '<items><channel id="A &quot;B&quot; \\ path"><title><![CDATA[A\tB\nC\rD]]></title></channel></items>',
            profile
        );
        assert.equal(value.items.channel["@id"], 'A "B" \\ path');
        // XML itself normalizes a literal CR to LF; the decoded tab remains intact.
        assert.equal(value.items.channel.title, "A\tB\nC\nD");
        assert.deepEqual(
            plain(
                decode(
                    "<items><channel/><channel><title>Second</title></channel><channel/></items>",
                    profile
                )
            ),
            { items: { channel: [null, { title: "Second" }, null] } }
        );
        const names = decode(
            "<items><constructor>first</constructor><constructor>second</constructor><__proto__><polluted>no</polluted></__proto__></items>",
            profile
        );
        assert.deepEqual(plain(names), {
            items: {
                ["__proto__"]: { polluted: "no" },
                constructor: ["first", "second"],
            },
        });
        assert.equal({}.polluted, undefined);
        assert.throws(
            () => decode("<items><unclosed>", profile),
            /Invalid XML/
        );
    }
    // Normalize the private DOM once, not once per ancestor/child conversion.
    const originalNormalize = w.Node.prototype.normalize;
    let normalizations = 0;
    w.Node.prototype.normalize = function () {
        normalizations++;
        return originalNormalize.call(this);
    };
    try {
        decode(
            "<items><channels><channel><title>Nested</title></channel></channels></items>",
            "antifriz"
        );
        assert.equal(normalizations, 1);
    } finally {
        w.Node.prototype.normalize = originalNormalize;
    }
    // No object→JSON→object copy and no manual JSON escaping is needed in the active codec.
    const nativeParse = w.JSON.parse;
    const nativeStringify = w.JSON.stringify;
    w.JSON.parse = w.JSON.stringify = () => {
        throw Error("unexpected JSON conversion");
    };
    try {
        assert.equal(
            decode(
                '<items><channel id="5"><title>Direct</title></channel></items>',
                "antifriz"
            ).items.channel.title,
            "Direct"
        );
    } finally {
        w.JSON.parse = nativeParse;
        w.JSON.stringify = nativeStringify;
    }
    for (const [entity, expected] of [
        ["&Afr;", "𝔄"],
        ["&NotEqualTilde;", "≂̸"],
        ["&Bogus;", "&Bogus;"],
        ["&nbsp;", "\u00a0"],
    ]) {
        assert.equal(
            decode(
                "<items><channel><title>A" +
                    entity +
                    "B</title></channel></items>"
            ).channels[0].title,
            "A" + expected + "B"
        );
    }
    assert.equal(
        decode(
            "<items><channel><title>A&amp;B &NotEqualTilde; &Bogus;</title></channel></items>"
        ).channels[0].title,
        "A&B ≂̸ &Bogus;"
    );
    assert.equal(
        decode(
            '<items><channel key="&quot;value&quot; &Afr;"><title>&nbsp;</title></channel></items>'
        ).channels[0].title,
        "\u00a0"
    );
    assert.equal(
        decode(
            "<items><channel><title>A & B &amp; C &Afr;</title></channel></items>"
        ).channels[0].title,
        "A & B & C 𝔄"
    );
    assert.equal(
        decode(
            "<items><channel><title>&nbsp;</title><description><![CDATA[&Afr; &nbsp; &Bogus;]]></description></channel></items>"
        ).channels[0].description,
        "&Afr; &nbsp; &Bogus;"
    );
    const parser = w.DOMParser;
    const attempts = [];
    const documents = [];
    w.DOMParser = function () {
        return {
            parseFromString(text, kind) {
                attempts.push(text);
                const document = new parser().parseFromString(text, kind);
                documents.push(document);
                return document;
            },
        };
    };
    try {
        decode(
            '<items><channel key="A&Tab;B&NewLine;C&#13;D&Afr;&NotEqualTilde;&quot;&apos;&lt;&gt;&amp;"><title>Whitespace</title></channel></items>'
        );
        const repairedDocument = documents[documents.length - 1];
        assert.equal(
            repairedDocument.querySelector("channel").getAttribute("key"),
            "A\tB\nC\rD𝔄≂̸\"'<>&",
            "repaired attribute entities preserve whitespace, Unicode and XML metacharacters"
        );
        assert(
            attempts[attempts.length - 1].includes("A&#9;B&#10;C&#13;D"),
            "tab/newline entity recovery must remain numeric to avoid XML attribute normalization"
        );
        const comment = "<!-- <title>A & B</title> -->";
        const cdata = "<![CDATA[<title>C & D</title>]]>";
        const repaired = decode(
            "<items>" +
                comment +
                "<channel><title>Bad & title</title><description>" +
                cdata +
                "</description></channel></items>"
        );
        assert.equal(repaired.channels[0].title, "Bad & title");
        assert.equal(repaired.channels[0].description, "<title>C & D</title>");
        assert(
            attempts[attempts.length - 1].includes(comment),
            "repair must not edit existing comments"
        );
        assert(
            attempts[attempts.length - 1].includes(cdata),
            "repair must not edit existing CDATA"
        );
    } finally {
        w.DOMParser = parser;
    }
    // Each decode is detached, including arrays and nested attributes.
    const detached = decode(operatorCases[1], "antifriz");
    detached.items.channel[0].title = "changed";
    assert.equal(
        decode(operatorCases[1], "antifriz").items.channel[0].title,
        "One"
    );
    dom.window.close();
    console.log(
        "PASS catalog XML (" +
            (profile || "source") +
            "): oracle shapes, direct objects, quotes/control text, Unicode entities, malformed data and isolated results"
    );
}
