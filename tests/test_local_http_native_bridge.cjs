const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");
const ast = ts.createSourceFile(
    "index.ts",
    source,
    ts.ScriptTarget.Latest,
    true
);
const bridges = ast.statements.filter(
    (node) =>
        ts.isIfStatement(node) &&
        /_queuePollTimer|_capPollTimer/.test(node.getText(ast))
);
assert.equal(
    bridges.length,
    2,
    "exercise the two production native queue bridges"
);
const javascript = ts.transpileModule(
    bridges.map((node) => node.getText(ast)).join("\n"),
    {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES2018,
        },
    }
).outputText;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function check(mode, device) {
    const commands = new Map([["", [{ command: "broadcast" }]]]);
    if (device) commands.set(device, [{ command: "targeted" }]);
    const delivered = [];
    const requests = [];
    const starts = [];
    const errors = [];
    const timers = new Map();
    const outstanding = [];
    let generation = 0;
    let ready = false;
    let delayed = false;
    let timerId = 0;
    function get(args) {
        assert.deepEqual(
            Object.keys(args),
            ["deviceId"],
            `${mode}: native bridge uses camelCase arguments`
        );
        requests.push(args.deviceId);
        const pendingCommands = commands.get(args.deviceId) || [];
        commands.delete(args.deviceId);
        const result =
            mode === "tauri" ? pendingCommands : { commands: pendingCommands };
        return delayed
            ? new Promise((resolve) => outstanding.push(() => resolve(result)))
            : Promise.resolve(result);
    }
    const w = {
        __ottLocalHttpRemote: {
            status: () => ({ enabled: false, generation, ready }),
        },
        clearInterval: (id) => timers.delete(id),
        console: { warn: (...args) => errors.push(args) },
        deviceUUID: device,
        handleCommand: (command) => delivered.push(command.command),
        setInterval: (callback) => {
            timers.set(++timerId, callback);
            return timerId;
        },
        tauriInvoke(name, args) {
            assert.equal(name, "queue_poll");
            return get(args);
        },
    };
    if (mode === "tauri") w.__TAURI__ = {};
    else
        w.Capacitor = {
            Plugins: {
                MobileCommandQueue: {
                    get,
                    start: (args) => {
                        starts.push(args);
                        return Promise.resolve();
                    },
                    stop() {},
                },
            },
        };
    w.window = w;
    vm.createContext(w);
    vm.runInContext(javascript, w);
    await tick();
    assert.equal(
        requests.length,
        0,
        "a reloaded page cannot drain a surviving listener before consent restoration/revocation"
    );
    assert.equal(delivered.length, 0);
    const bridge = mode === "tauri" ? w.__ottQueuePoll : w.__ottCapQueue;
    ready = true;
    bridge.poll();
    await tick();
    const expectedDevices = device ? ["", device] : [""];
    const expectedCommands = device ? ["broadcast", "targeted"] : ["broadcast"];
    assert.deepEqual(requests, expectedDevices);
    assert.deepEqual(
        delivered,
        expectedCommands,
        `${mode}: broadcast and UUID commands each reach the player once`
    );
    assert.equal(errors.length, 0);
    if (mode === "capacitor")
        assert.deepEqual(
            starts,
            [undefined],
            "internal polling does not opt in to HTTP listening"
        );
    assert.equal(timers.size, 1);
    bridge.poll();
    await tick();
    assert.deepEqual(
        delivered,
        expectedCommands,
        "drained commands cannot repeat on the next poll"
    );

    commands.set("", [{ command: "revoked-broadcast" }]);
    if (device) commands.set(device, [{ command: "revoked-targeted" }]);
    delayed = true;
    bridge.poll();
    assert.equal(outstanding.length, expectedDevices.length);
    generation++;
    outstanding.forEach((resolve) => resolve());
    await tick();
    assert.deepEqual(
        delivered,
        expectedCommands,
        `${mode}: disable/re-enable invalidates an in-flight drain`
    );
    assert.equal(errors.length, 0);
    const before = requests.length;
    ready = false;
    bridge.poll();
    await tick();
    assert.equal(
        requests.length,
        before,
        "a pending configuration transition cannot drain commands"
    );
    bridge.stop();
    assert.equal(timers.size, 0);
}

(async () => {
    for (const mode of ["tauri", "capacitor"])
        for (const device of ["player-uuid", ""]) await check(mode, device);
    console.log(
        "OK: Tauri/Capacitor queue bridges gate reload/transition readiness, use native argument names, deliver broadcast/UUID commands once, and discard revoked in-flight commands"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
