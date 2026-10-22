const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureMediaRuntime } = require("../scripts/media-runtime-cache.cjs");

const project = path.resolve(__dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ottplay-media-cache-"));
const names = [
    "core-js",
    "hls.js",
    "video.js",
    "@videojs/http-streaming",
    "typescript",
    "rollup",
    "terser",
    "@rollup/plugin-commonjs",
    "@rollup/plugin-node-resolve",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function read(file) {
    return fs.readFileSync(path.join(root, file));
}
function write(file, value) {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, value);
}

function createFixture() {
    // Use the actual production auditor against a small independent source tree.
    // Only the expensive compiler is replaced by a deterministic fixture writer.
    write(
        "scripts/media-runtime.cjs",
        fs.readFileSync(path.join(project, "scripts/media-runtime.cjs"))
    );
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.symlinkSync(
        path.dirname(require.resolve("acorn/package.json")),
        path.join(root, "node_modules/acorn"),
        "dir"
    );
    const packages = {};
    for (const name of names) {
        packages["node_modules/" + name] = {
            integrity: "fixture-integrity-" + name,
            version: "1.0.0",
        };
        write(
            "node_modules/" + name + "/package.json",
            JSON.stringify({
                dependencies: { "@videojs/http-streaming": "1.0.0" },
                name,
                version: "1.0.0",
            })
        );
    }
    packages[""] = { name: "ottplay-fixture", version: "1.0.0" };
    write(
        "package-lock.json",
        JSON.stringify({ lockfileVersion: 3, packages, version: "1.0.0" })
    );
    write("src/polyfills/runtime.ts", "export function fixtureRuntime() {}\n");
    write(
        "node_modules/hls.js/dist/hls.min.js",
        "var Hls = function Hls() {};\n"
    );
    write(
        "node_modules/hls.js/dist/hls.worker.js",
        "self.onmessage = function () {};\n"
    );
    write("node_modules/core-js/LICENSE", "Fixture core-js license\n");
    write("node_modules/hls.js/LICENSE", "Fixture HLS license\n");
    write(
        "node_modules/video.js/dist/video.min.js",
        "var videojs = function () {};\n"
    );
    write("node_modules/video.js/LICENSE", "Fixture Video.js license\n");
    write(
        "node_modules/@videojs/http-streaming/LICENSE",
        "Fixture VHS license\n"
    );
    write("LICENSE", "Fixture project license\n");
    write("licenses/android/Apache-2.0.txt", "Fixture Apache license\n");
}

function fixtureBuild() {
    const lock = JSON.parse(read("package-lock.json"));
    const { lockInputsDigest } = require(
        path.join(root, "scripts/media-runtime.cjs")
    );
    const packages = {};
    for (const name of names) {
        const installed = JSON.parse(
            read("node_modules/" + name + "/package.json")
        );
        packages[name] = {
            integrity: lock.packages["node_modules/" + name].integrity,
            version: installed.version,
        };
    }
    const source = {
        builderSha256: sha(read("scripts/media-runtime.cjs")),
        lockInputsSha256: lockInputsDigest(lock),
        packages,
        webPolyfillsSha256: sha(read("src/polyfills/runtime.ts")),
    };
    const runtimeVersion = sha(JSON.stringify(source)).slice(0, 16);
    const runtime =
        "var fixtureRuntimeVersion = " + JSON.stringify(runtimeVersion) + ";\n";
    const outputs = {
        "hls.min.js": read("node_modules/hls.js/dist/hls.min.js"),
        "hls.worker.js": Buffer.concat([
            Buffer.from(
                "/*! OTT-play ES5 worker bootstrap; shared runtime and licenses in js/. */\n" +
                    'importScripts("./runtime-polyfills.js?v=' +
                    runtimeVersion +
                    '");\n' +
                    "if (self.__ottRuntimePolyfillsReady !== true || self.__ottMediaRuntimeVersion !== " +
                    JSON.stringify(runtimeVersion) +
                    ') { throw new Error("OTT-play worker runtime mismatch"); }\n' +
                    "/* Upstream hls.js worker follows unchanged. */\n"
            ),
            read("node_modules/hls.js/dist/hls.worker.js"),
        ]),
        "runtime-polyfills.js": runtime,
        "video.min.js": read("node_modules/video.js/dist/video.min.js"),
    };
    const assets = {};
    for (const [name, value] of Object.entries(outputs)) {
        write("js/" + name, value);
        assets[name] = sha(value);
    }
    write(
        "js/media-runtime.json",
        JSON.stringify({ schema: 2, ...source, assets, runtimeVersion })
    );
    for (const name of [
        "core-js",
        "hls.js",
        "video.js",
        "@videojs/http-streaming",
    ])
        write(
            "js/licenses/" + name.replace("/", "-") + "-LICENSE.txt",
            read("node_modules/" + name + "/LICENSE")
        );
    write("js/licenses/project-LICENSE.txt", read("LICENSE"));
    write(
        "js/licenses/Apache-2.0.txt",
        read("licenses/android/Apache-2.0.txt")
    );
    for (const name of ["index.html", "src-tauri/pip/pip.html"])
        write(
            name,
            '<script src="/js/runtime-polyfills.js?v=' +
                runtimeVersion +
                '"></script>'
        );
}

async function verifyCheckoutBytes() {
    const temporary = fs.mkdtempSync(
        path.join(os.tmpdir(), "ottplay-media-checkout-")
    );
    let checkout = path.join(temporary, "seed");
    fs.mkdirSync(checkout);
    const git = (...args) =>
        execFileSync("git", args, {
            cwd: checkout,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    try {
        const policy = JSON.parse(
            fs.readFileSync(path.join(project, ".release-policy.json"))
        );
        const files = [
            ...new Set([
                ".gitattributes",
                ".release-policy.json",
                "scripts/version_plan.py",
                "scripts/release_control.py",
                "scripts/verify-player-build-source.py",
                "scripts/player-build-identity.cjs",
                "scripts/media-runtime.cjs",
                "src/polyfills/runtime.ts",
                "package-lock.json",
                "LICENSE",
                "licenses/android/Apache-2.0.txt",
                "index.html",
                "src-tauri/pip/pip.html",
                ...[
                    "runtime-polyfills.js",
                    "hls.min.js",
                    "hls.worker.js",
                    "video.min.js",
                    "media-runtime.json",
                ].map((name) => "js/" + name),
                ...fs
                    .readdirSync(path.join(project, "js/licenses"))
                    .map((name) => "js/licenses/" + name),
                ...policy.versioning.files.map((item) => item.path),
            ]),
        ];
        for (const name of files) {
            const destination = path.join(checkout, name);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(path.join(project, name), destination);
        }
        fs.writeFileSync(
            path.join(checkout, "newline-control.txt"),
            "Unpinned checkout control\n"
        );
        fs.writeFileSync(
            path.join(checkout, ".gitignore"),
            "/node_modules\n.release-plan.json\n.release-inputs.json\n"
        );
        git("init", "--quiet");
        git("config", "core.autocrlf", "false");
        git("add", "--all");
        const hooks = path.join(checkout, ".git/empty-hooks");
        fs.mkdirSync(hooks);
        git(
            "-c",
            "core.hooksPath=" + hooks,
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Media checkout test",
            "-c",
            "user.email=media-checkout@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "Test pinned media checkout"
        );
        // A fresh clone exercises Git's real checkout conversion on every OS.
        const destination = path.join(temporary, "checkout");
        git(
            "clone",
            "--quiet",
            "--no-hardlinks",
            "--config",
            "core.autocrlf=true",
            checkout,
            destination
        );
        checkout = destination;
        assert.equal(
            fs.readFileSync(path.join(checkout, "newline-control.txt"), "utf8"),
            "Unpinned checkout control\r\n"
        );
        fs.symlinkSync(
            path.join(project, "node_modules"),
            path.join(checkout, "node_modules"),
            "junction"
        );
        const runtime = require(
            path.join(checkout, "scripts/media-runtime.cjs")
        );
        const expected = JSON.parse(
            fs.readFileSync(path.join(project, "js/media-runtime.json"))
        );
        assert.deepEqual(runtime.auditMediaRuntime(checkout), expected);
        assert.equal((await ensureMediaRuntime(checkout)).rebuilt, false);
        assert.equal(git("status", "--porcelain"), "");
        console.log(
            "PASS media cache: autocrlf checkout preserves audited bytes without rebuilding"
        );

        const head = git("rev-parse", "HEAD").trim();
        execFileSync(
            "python3",
            [
                "-I",
                "-B",
                "-c",
                `import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / "scripts"))
import version_plan
root = pathlib.Path(sys.argv[1])
policy = json.loads((root / ".release-policy.json").read_bytes())
plan = version_plan.create_plan(version_plan.read_base_version(root, policy), "beta", 11, sys.argv[2], policy, build_number=19001)
(root / ".release-plan.json").write_text(json.dumps(plan))
version_plan.sync_versions(root, policy, plan)
`,
                checkout,
                head,
            ],
            { stdio: ["ignore", "pipe", "pipe"] }
        );
        const overlayStatus = git("status", "--porcelain");
        assert.notEqual(overlayStatus, "");
        assert.equal((await ensureMediaRuntime(checkout)).rebuilt, false);
        const { createPlayerBuildIdentity } = require(
            path.join(checkout, "scripts/player-build-identity.cjs")
        );
        assert.equal(
            createPlayerBuildIdentity("compiled checkout", checkout, {
                requireReleaseSource: true,
            }).sourceRevision,
            head
        );
        assert.equal(git("status", "--porcelain"), overlayStatus);
        console.log(
            "PASS media cache: frozen release overlay retains strict source identity after autocrlf checkout"
        );

        // A real byte change must still fail; do not normalize it in the audit.
        fs.writeFileSync(
            path.join(checkout, ".git/info/attributes"),
            "scripts/media-runtime.cjs text eol=crlf\n"
        );
        fs.unlinkSync(path.join(checkout, "scripts/media-runtime.cjs"));
        git("checkout-index", "--force", "--", "scripts/media-runtime.cjs");
        assert.throws(
            () => runtime.auditMediaRuntime(checkout),
            /Stale media URL version/
        );
        console.log(
            "PASS media cache: changed source bytes still reject the committed runtime"
        );
    } finally {
        fs.rmSync(temporary, { force: true, recursive: true });
    }
}

async function main() {
    await verifyCheckoutBytes();
    createFixture();
    fixtureBuild();
    const { auditMediaRuntime } = require(
        path.join(root, "scripts/media-runtime.cjs")
    );
    let audits = 0;
    let builds = 0;
    const dependencies = {
        auditMediaRuntime(directory) {
            audits++;
            assert.equal(directory, root);
            return auditMediaRuntime(directory);
        },
        async buildMediaRuntime() {
            builds++;
            fixtureBuild();
        },
    };
    assert.equal((await ensureMediaRuntime(root)).rebuilt, false);
    const first = await ensureMediaRuntime(root, dependencies);
    const second = await ensureMediaRuntime(root, dependencies);
    assert.equal(first.rebuilt, false);
    assert.deepEqual(first.manifest, second.manifest);
    assert.equal(audits, 2, "Every hit reruns the complete production audit");
    assert.equal(builds, 0, "Valid artifacts are never rebuilt");
    console.log("PASS media cache: complete fresh audit permits reuse");

    async function reuses(name, mutate) {
        const beforeBuilds = builds;
        const beforeVersion = auditMediaRuntime(root).runtimeVersion;
        mutate();
        const result = await ensureMediaRuntime(root, dependencies);
        assert.equal(result.rebuilt, false, name);
        assert.equal(builds, beforeBuilds, name + " must not rebuild");
        assert.equal(result.manifest.runtimeVersion, beforeVersion);
        console.log("PASS media cache: " + name);
    }

    await reuses("release root versions do not change media inputs", () => {
        const lock = JSON.parse(read("package-lock.json"));
        lock.version = "1.0.0-beta.43";
        lock.packages[""].version = "1.0.0-beta.43";
        write("package-lock.json", JSON.stringify(lock));
    });
    await reuses(
        "JSON formatting and object order do not change media inputs",
        () => {
            const lock = JSON.parse(read("package-lock.json"));
            function reverse(value) {
                if (Array.isArray(value)) return value.map(reverse);
                if (value && typeof value === "object")
                    return Object.fromEntries(
                        Object.keys(value)
                            .reverse()
                            .map((key) => [key, reverse(value[key])])
                    );
                return value;
            }
            write(
                "package-lock.json",
                JSON.stringify(reverse(lock), null, 4) + "\n"
            );
        }
    );

    async function invalidates(name, mutate) {
        const beforeAudits = audits;
        const beforeBuilds = builds;
        mutate();
        const result = await ensureMediaRuntime(root, dependencies);
        assert.equal(result.rebuilt, true, name);
        assert.equal(builds, beforeBuilds + 1, name + " must rebuild once");
        assert.equal(audits, beforeAudits + 2, name + " must audit the repair");
        assert.deepEqual(result.manifest, auditMediaRuntime(root));
        assert.equal(
            (await ensureMediaRuntime(root, dependencies)).rebuilt,
            false
        );
        console.log("PASS media cache: " + name);
    }
    await invalidates("changed web runtime input", () => {
        write(
            "src/polyfills/runtime.ts",
            "export function changedRuntime() {}\n"
        );
    });
    function editLock(edit) {
        const lock = JSON.parse(read("package-lock.json"));
        edit(lock);
        write("package-lock.json", JSON.stringify(lock));
    }
    await invalidates("changed dependency version", () => {
        editLock((lock) => {
            lock.packages["node_modules/core-js"].version = "1.0.1";
        });
        const installed = JSON.parse(read("node_modules/core-js/package.json"));
        installed.version = "1.0.1";
        write("node_modules/core-js/package.json", JSON.stringify(installed));
    });
    await invalidates("changed dependency integrity", () => {
        editLock((lock) => {
            lock.packages["node_modules/core-js"].integrity =
                "different-integrity";
        });
    });
    await invalidates("changed root package metadata", () => {
        editLock((lock) => {
            lock.packages[""].engines = { node: ">=22" };
        });
    });
    await invalidates("changed non-media dependency", () => {
        editLock((lock) => {
            lock.packages["node_modules/other"] = { version: "2.0.0" };
        });
    });
    await invalidates("changed top-level lock metadata", () => {
        editLock((lock) => {
            lock.requires = true;
        });
    });
    await invalidates("added dependency array metadata", () => {
        editLock((lock) => {
            lock.packages["node_modules/other"].os = ["darwin", "linux"];
        });
    });
    await invalidates("changed dependency array ordering", () => {
        editLock((lock) => {
            lock.packages["node_modules/other"].os.reverse();
        });
    });
    await invalidates("removed root version field", () => {
        editLock((lock) => {
            delete lock.packages[""].version;
        });
    });
    await invalidates("changed builder input", () => {
        write(
            "scripts/media-runtime.cjs",
            Buffer.concat([
                read("scripts/media-runtime.cjs"),
                Buffer.from("\n// Fixture input changed.\n"),
            ])
        );
    });
    await invalidates("corrupted runtime bytes", () => {
        write("js/runtime-polyfills.js", "var corrupted = true;\n");
    });
    await invalidates("corrupted optional Video.js asset", () => {
        write("js/video.min.js", "var staleVideo = true;\n");
    });
    await invalidates("changed upstream Video.js bytes", () => {
        write(
            "node_modules/video.js/dist/video.min.js",
            "var videojs = function updatedVideo() {};\n"
        );
    });
    await invalidates("missing worker", () => {
        fs.unlinkSync(path.join(root, "js/hls.worker.js"));
    });
    function rewriteWorker(rewrite) {
        const worker = rewrite(read("js/hls.worker.js").toString());
        write("js/hls.worker.js", worker);
        const manifest = JSON.parse(read("js/media-runtime.json"));
        manifest.assets["hls.worker.js"] = sha(worker);
        write("js/media-runtime.json", JSON.stringify(manifest));
    }
    // Even a matching asset hash cannot authorize a different loader or upstream
    // suffix. The auditor reconstructs the entire versioned worker recipe.
    await invalidates(
        "worker imports stale runtime despite matching hash",
        () => {
            rewriteWorker((worker) =>
                worker.replace(
                    /runtime-polyfills\.js\?v=[a-f0-9]+/,
                    "runtime-polyfills.js?v=old"
                )
            );
        }
    );
    await invalidates(
        "worker readiness guard removed despite matching hash",
        () => {
            rewriteWorker((worker) =>
                worker.replace(
                    /^if \(self\.__ottRuntimePolyfillsReady[^\n]*\n/m,
                    ""
                )
            );
        }
    );
    await invalidates("worker upstream modified despite matching hash", () => {
        rewriteWorker(
            (worker) => worker + "\nself.extraWorkerBehavior = true;\n"
        );
    });
    await invalidates("changed upstream worker bytes", () => {
        write(
            "node_modules/hls.js/dist/hls.worker.js",
            "self.onmessage = function changedWorker() {};\n"
        );
    });
    await invalidates("changed upstream HLS bytes", () => {
        write(
            "node_modules/hls.js/dist/hls.min.js",
            "var Hls = function ChangedHls() {};\n"
        );
    });
    await invalidates("stale bootstrap version", () => {
        write(
            "index.html",
            '<script src="/js/runtime-polyfills.js?v=old"></script>'
        );
    });
    for (const file of ["index.html", "src-tauri/pip/pip.html"]) {
        await invalidates("missing source entry point " + file, () => {
            fs.unlinkSync(path.join(root, file));
        });
    }
    await invalidates("commented bootstrap is not an executable script", () => {
        write("index.html", "<!--" + read("index.html") + "-->");
    });
    await invalidates(
        "inert template bootstrap cannot satisfy the audit",
        () => {
            write(
                "index.html",
                "<template>" + read("index.html") + "</template>"
            );
        }
    );
    await invalidates("bootstrap must precede other scripts", () => {
        write(
            "index.html",
            "<script>beforeRuntime();</script>" + read("index.html")
        );
    });
    for (const attribute of [
        "async",
        "defer",
        "nomodule",
        'type="module"',
        'type="text/plain"',
    ]) {
        await invalidates("bootstrap must be blocking: " + attribute, () => {
            write(
                "index.html",
                read("index.html")
                    .toString()
                    .replace("<script ", "<script " + attribute + " ")
            );
        });
    }
    await invalidates("missing license", () => {
        fs.unlinkSync(path.join(root, "js/licenses/hls.js-LICENSE.txt"));
    });
    await invalidates("missing manifest", () => {
        fs.unlinkSync(path.join(root, "js/media-runtime.json"));
    });
    await invalidates("legacy manifest schema", () => {
        const manifest = JSON.parse(read("js/media-runtime.json"));
        manifest.schema = 1;
        write("js/media-runtime.json", JSON.stringify(manifest));
    });

    write("js/runtime-polyfills.js", "var broken = true;\n");
    const buildError = new Error("Fixture compiler failed");
    await assert.rejects(
        ensureMediaRuntime(root, {
            auditMediaRuntime,
            async buildMediaRuntime() {
                throw buildError;
            },
        }),
        (error) => error === buildError
    );
    await assert.rejects(
        ensureMediaRuntime(root, {
            auditMediaRuntime,
            async buildMediaRuntime() {},
        }),
        /Stale media runtime asset/
    );
    for (const file of ["index.html", "src-tauri/pip/pip.html"]) {
        fixtureBuild();
        fs.unlinkSync(path.join(root, file));
        await assert.rejects(
            ensureMediaRuntime(root, {
                auditMediaRuntime,
                async buildMediaRuntime() {},
            }),
            (error) =>
                error.code === "ENOENT" && error.path === path.join(root, file),
            "A rebuild that leaves " + file + " absent must fail"
        );
    }
    fixtureBuild();
    write("index.html", "<!--" + read("index.html") + "-->");
    await assert.rejects(
        ensureMediaRuntime(root, {
            auditMediaRuntime,
            async buildMediaRuntime() {},
        }),
        /Missing or non-blocking media bootstrap/,
        "A rebuild that leaves an inert bootstrap must fail"
    );
    fixtureBuild();
    fs.unlinkSync(path.join(root, "src/polyfills/runtime.ts"));
    await assert.rejects(ensureMediaRuntime(root, dependencies), /ENOENT/);
    console.log(
        "PASS media cache: build, repaired-audit and missing-input failures propagate"
    );
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        fs.rmSync(root, { force: true, recursive: true });
    });
