// Use the browser's HTML parsing rules, including raw script text and unusual end tags.
const { parse } = require("parse5");

function inlineScripts(html) {
    const scripts = [];
    function visit(node) {
        if (node.tagName === "script") {
            scripts.push(
                (node.childNodes || [])
                    .map((child) => child.value || "")
                    .join("")
            );
            return;
        }
        for (const child of node.childNodes || []) visit(child);
        if (node.content) visit(node.content);
    }
    visit(parse(html));
    return scripts;
}

module.exports = { inlineScripts };
