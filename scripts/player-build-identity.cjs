const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

// The identifier belongs to these compiled bytes, not a later manifest fetch.
// Ordinary dirty checkouts retain a content identity without a source claim.
// A frozen release overlay is accepted only after independent byte validation.
function createPlayerBuildIdentity(source, root, options = {}) {
    const buildId =
        "bundle-" + createHash("sha256").update(source).digest("hex");
    let sourceHead = "";
    let sourceRevision = "";
    try {
        const config = [
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
        ];
        if (process.platform !== "win32")
            config.push("-c", "core.filemode=true");
        const git = (args) =>
            execFileSync("git", [...config, ...args], {
                cwd: root,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
        const head = git(["rev-parse", "HEAD"]);
        if (/^[0-9a-f]{40}$/.test(head)) sourceHead = head;
        // Assume-unchanged and skip-worktree entries can conceal edits even
        // when status claims a clean checkout. They cannot attest its source.
        const visible = !git(["ls-files", "-v", "-z"])
            .split("\0")
            .some((entry) => entry && entry.slice(0, 2) !== "H ");
        const dirty = git([
            "status",
            "--porcelain",
            "--untracked-files=normal",
        ]);
        if (visible && !dirty && !options.requireReleaseSource)
            sourceRevision = sourceHead;
        else if (
            visible &&
            sourceHead &&
            existsSync(path.join(root, ".release-plan.json"))
        ) {
            const verified = execFileSync(
                "python3",
                [
                    "-I",
                    "-B",
                    path.join(__dirname, "verify-player-build-source.py"),
                    "--root",
                    root,
                ],
                {
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "ignore"],
                    timeout: 15000,
                }
            ).trim();
            if (verified === sourceHead) sourceRevision = sourceHead;
        }
    } catch (_) {
        /* Source archives have no Git metadata. */
    }
    if (options.requireReleaseSource && !sourceRevision)
        throw new Error(
            "Release player source identity could not be verified. " +
                "Commit generated media assets and apply the exact frozen release plan."
        );
    return { buildId, sourceHead, sourceRevision };
}

function applyPlayerBuildIdentity(source, identity) {
    return source
        .replace(/__OTTP_SOURCE_REVISION__/g, identity.sourceRevision)
        .replace(/__OTTP_BUILD_ID__/g, identity.buildId);
}

function embedPlayerBuildIdentity(source, root, options) {
    return applyPlayerBuildIdentity(
        source,
        createPlayerBuildIdentity(source, root, options)
    );
}

module.exports = {
    applyPlayerBuildIdentity,
    createPlayerBuildIdentity,
    embedPlayerBuildIdentity,
};
