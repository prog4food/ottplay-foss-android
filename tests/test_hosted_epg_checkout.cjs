"use strict";
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "hosted-epg-checkout-")
);
const source = path.join(temporary, "source");
const checkout = path.join(temporary, "checkout");
const git = (...args) =>
    execFileSync(
        "git",
        [
            "-c",
            "core.hooksPath=" + path.join(temporary, "no-hooks"),
            "-c",
            "core.attributesFile=" + path.join(temporary, "no-attributes"),
            ...args,
        ],
        { cwd: source, stdio: "pipe" }
    );

try {
    fs.mkdirSync(source);
    for (const relative of [
        ".gitattributes",
        "scripts/hosted-epg.cjs",
        "src/hosted/epg-worker.ts",
        "src/hosted/epg-server.ts",
        "src/hosted/epg-diagnostics.ts",
        "vendor/hosted-epg",
    ]) {
        const destination = path.join(source, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(path.join(root, relative), destination, { recursive: true });
    }
    // Prove that checkout conversion is active, rather than merely hashing LF files.
    fs.writeFileSync(
        path.join(source, "checkout-control.txt"),
        "first\nsecond\n"
    );
    git("init", "-q");
    git("-c", "core.autocrlf=false", "add", ".");
    git(
        "-c",
        "user.name=Hosted EPG checkout fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "Receipt-pinned hosted EPG inputs"
    );
    git("-c", "core.autocrlf=true", "clone", "-q", source, checkout);
    assert.equal(
        fs.readFileSync(path.join(checkout, "checkout-control.txt"), "utf8"),
        "first\r\nsecond\r\n"
    );

    // Exercise the shipping verifier against the checked-out dependency bytes.
    const result = execFileSync(
        process.execPath,
        [path.join(checkout, "scripts/hosted-epg.cjs")],
        {
            cwd: checkout,
            encoding: "utf8",
            env: {
                ...process.env,
                NODE_PATH: [
                    path.join(root, "node_modules"),
                    process.env.NODE_PATH,
                ]
                    .filter(Boolean)
                    .join(path.delimiter),
            },
            stdio: "pipe",
        }
    );
    assert.match(result, /PASS hosted EPG assets/);
    console.log("PASS hosted EPG receipts after core.autocrlf=true checkout");
} finally {
    fs.rmSync(temporary, { force: true, maxRetries: 3, recursive: true });
}
