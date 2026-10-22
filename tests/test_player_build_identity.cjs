const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function testReleaseOverlay() {
    const repository = path.resolve(__dirname, "..");
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "ott-release-identity-")
    );
    try {
        const git = (...args) =>
            execFileSync("git", ["--no-optional-locks", ...args], {
                cwd: root,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            }).trim();
        const python = (code, ...args) =>
            execFileSync("python3", ["-I", "-B", "-c", code, root, ...args], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            }).trim();
        const policy = JSON.parse(
            fs.readFileSync(path.join(repository, ".release-policy.json"))
        );
        const files = Array.from(
            new Set([
                ".release-policy.json",
                "scripts/version_plan.py",
                "scripts/release_control.py",
                "scripts/verify-player-build-source.py",
                "scripts/player-build-identity.cjs",
                ...policy.versioning.files.map((item) => item.path),
            ])
        );
        for (const file of files) {
            fs.mkdirSync(path.dirname(path.join(root, file)), {
                recursive: true,
            });
            fs.copyFileSync(path.join(repository, file), path.join(root, file));
        }
        fs.writeFileSync(
            path.join(root, ".gitignore"),
            ".release-plan.json\n.release-inputs.json\nbuild/\n"
        );
        fs.writeFileSync(
            path.join(root, "source.txt"),
            "unchanged application source\n"
        );
        git("init", "-q");
        git("add", ".");
        const commit = () =>
            git(
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "Fixture"
            );
        commit();
        const head = git("rev-parse", "HEAD");
        const { createPlayerBuildIdentity, embedPlayerBuildIdentity } = require(
            path.join(root, "scripts/player-build-identity.cjs")
        );
        const identity = () =>
            createPlayerBuildIdentity("compiled fixture", root).sourceRevision;
        const releaseIdentity = () =>
            createPlayerBuildIdentity("compiled fixture", root, {
                requireReleaseSource: true,
            }).sourceRevision;
        assert.equal(identity(), head);
        assert.throws(
            releaseIdentity,
            /Release player source identity could not be verified/,
            "A release build needs a frozen plan even in a clean checkout"
        );
        git("update-index", "--assume-unchanged", "source.txt");
        fs.appendFileSync(
            path.join(root, "source.txt"),
            "hidden clean-path edit\n"
        );
        assert.equal(
            identity(),
            "",
            "A hidden clean-path edit cannot inherit HEAD without a release overlay"
        );
        git("update-index", "--no-assume-unchanged", "source.txt");
        git("checkout", "--", "source.txt");
        if (process.platform !== "win32") {
            git("config", "core.filemode", "false");
            fs.chmodSync(path.join(root, "package.json"), 0o755);
            assert.equal(
                identity(),
                "",
                "A clean-path executable-bit change is detected despite core.filemode=false"
            );
            fs.chmodSync(path.join(root, "package.json"), 0o644);
            git("config", "core.filemode", "true");
        }
        assert.equal(identity(), head);
        const plan = JSON.parse(
            python(
                `import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / "scripts"))
import version_plan
root = pathlib.Path(sys.argv[1])
policy = json.loads((root / ".release-policy.json").read_bytes())
print(json.dumps(version_plan.create_plan(version_plan.read_base_version(root, policy), "beta", 43, sys.argv[2], policy, build_number=15000)))`,
                head
            )
        );
        const planPath = path.join(root, ".release-plan.json");
        const writePlan = (value) =>
            fs.writeFileSync(planPath, JSON.stringify(value));
        writePlan(plan);
        // Run the real sync CLI, including its normal receipt generation.
        python(`import pathlib, sys
sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / "scripts"))
import version_plan
raise SystemExit(version_plan.main(["sync", "--root", sys.argv[1], "--plan", ".release-plan.json"]))`);
        assert.notEqual(git("status", "--porcelain"), "");
        const overlay = new Map(
            files.map((file) => [file, fs.readFileSync(path.join(root, file))])
        );
        const receiptPath = path.join(root, ".release-inputs.json");
        const receipt = fs.readFileSync(receiptPath);
        const index = fs.readFileSync(path.join(root, ".git/index"));
        assert.equal(
            identity(),
            head,
            "An exact release overlay preserves source identity"
        );
        assert.equal(releaseIdentity(), head);
        assert.equal(
            embedPlayerBuildIdentity("source=__OTTP_SOURCE_REVISION__", root, {
                requireReleaseSource: true,
            }),
            "source=" + head,
            "The emitted release frontend contains the verified source revision"
        );
        assert.deepEqual(
            fs.readFileSync(path.join(root, ".git/index")),
            index,
            "Verification does not rewrite the index"
        );
        for (const [file, bytes] of overlay)
            assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
        assert.deepEqual(fs.readFileSync(receiptPath), receipt);
        assert.equal(
            fs.existsSync(path.join(root, "scripts/__pycache__")),
            false
        );

        writePlan({ ...plan, source_sha: "f".repeat(40) });
        assert.throws(releaseIdentity, /Release player source identity/);
        assert.equal(
            identity(),
            "",
            "A plan for another commit cannot authorize the overlay"
        );
        writePlan({ ...plan, policy_sha256: "e".repeat(64) });
        assert.equal(
            identity(),
            "",
            "A mismatched policy cannot authorize the overlay"
        );
        writePlan(plan);
        fs.appendFileSync(path.join(root, "source.txt"), "unexpected edit\n");
        assert.throws(
            releaseIdentity,
            /Release player source identity/,
            "A release cannot silently lose provenance after a generated source edit"
        );
        assert.equal(
            identity(),
            "",
            "An otherwise valid release receipt does not authorize unrelated source edits"
        );
        git("checkout", "--", "source.txt");
        fs.writeFileSync(path.join(root, "untracked.txt"), "untracked input");
        assert.equal(identity(), "", "Untracked inputs prevent a source claim");
        fs.unlinkSync(path.join(root, "untracked.txt"));

        const packagePath = path.join(root, "package.json");
        const originalPackage = overlay.get("package.json");
        fs.writeFileSync(
            packagePath,
            originalPackage.toString().replace(plan.version, "1.2.3-beta.1")
        );
        assert.equal(
            identity(),
            "",
            "Replaying a valid receipt does not authorize tampered version bytes"
        );
        fs.writeFileSync(packagePath, originalPackage);
        git("checkout", "--", "src-tauri/Cargo.toml");
        assert.equal(
            identity(),
            "",
            "A partially applied overlay is not a release build"
        );
        fs.writeFileSync(
            path.join(root, "src-tauri/Cargo.toml"),
            overlay.get("src-tauri/Cargo.toml")
        );
        git("add", "package.json");
        assert.equal(
            identity(),
            "",
            "Staged changes are not produced by release sync"
        );
        git("reset", "-q", "HEAD", "--", "package.json");
        if (process.platform !== "win32") {
            git("config", "core.filemode", "false");
            fs.chmodSync(packagePath, 0o755);
            assert.equal(
                identity(),
                "",
                "Version sync does not change executable bits"
            );
            fs.chmodSync(packagePath, 0o644);
            git("config", "core.filemode", "true");
        }
        git("update-index", "--assume-unchanged", "source.txt");
        fs.appendFileSync(path.join(root, "source.txt"), "hidden edit\n");
        assert.equal(
            identity(),
            "",
            "Hidden index entries cannot conceal unrelated source edits"
        );
        git("update-index", "--no-assume-unchanged", "source.txt");
        git("checkout", "--", "source.txt");
        fs.appendFileSync(
            path.join(root, "scripts/version_plan.py"),
            "\n# modified tooling\n"
        );
        assert.equal(
            identity(),
            "",
            "Modified release tooling cannot approve itself"
        );
        fs.writeFileSync(
            path.join(root, "scripts/version_plan.py"),
            overlay.get("scripts/version_plan.py")
        );
        assert.equal(identity(), head);

        git("reset", "--hard", "HEAD");
        fs.appendFileSync(
            path.join(root, "source.txt"),
            "next source revision\n"
        );
        git("add", "source.txt");
        commit();
        for (const item of policy.versioning.files)
            fs.writeFileSync(
                path.join(root, item.path),
                overlay.get(item.path)
            );
        assert.equal(
            identity(),
            "",
            "Replayed plan and receipt cannot authorize an overlay on a new HEAD"
        );
        console.log(
            "Player build identity: exact frozen overlay, read-only validation and tamper/replay rejection PASS"
        );
    } finally {
        fs.rmSync(root, { force: true, recursive: true });
    }
}

module.exports = { testReleaseOverlay };
if (require.main === module) testReleaseOverlay();
