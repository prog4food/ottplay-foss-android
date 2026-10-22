"use strict";
const vm = require("node:vm");
const ts = require("typescript");
const { context, declarations } = require("./playlist-fixture.cjs");
const privateRuntime = require("./private-runtime.cjs");
const clone = (value) => JSON.parse(JSON.stringify(value));

module.exports = function fixture(options = {}) {
    const host = context();
    host.URL = URL;
    privateRuntime(host, "src/provider/runtime.ts");
    privateRuntime(host, "src/provider/channel-catalog.ts");
    privateRuntime(host, "src/provider/stalker-driver.ts");
    const names = [
        "emptyDriverCatalog",
        "driverCatalogSnapshot",
        "createDriverTransport",
    ];
    vm.runInContext(
        ts.transpileModule(
            declarations("src/provider/drivers.ts")
                .filter((row) => names.includes(row.name))
                .map((row) => row.text)
                .join("\n"),
            { compilerOptions: { target: ts.ScriptTarget.ES5 } }
        ).outputText,
        host
    );
    const requests = [],
        progress = [];
    const saved = new Map([
        [
            "stalker_data",
            JSON.stringify(
                options.config || {
                    mac: "00:1a:79:01:02:03",
                    portal: "https://portal.test/",
                }
            ),
        ],
    ]);
    const registry = host.__ottProviderRuntime.createRegistry();
    const owner = registry.activate("stalker");
    const ports = {
        channelCatalog: host.__ottChannelCatalog.project,
        core: host.OttPlayCore,
        createLifetime: host.__ottProviderRuntime.createRegistry,
        hash: (name) => host.xxHash32S(name, true),
        isDune: () => !!options.dune,
        language: options.language ? () => options.language : undefined,
        now: () => options.now ?? 1767225600.5,
        progress: (message) => progress.push(message),
        relay: "",
        request(settings, done, fail) {
            const request = {
                aborts: 0,
                done,
                fail,
                settings,
            };
            requests.push(request);
            if (options.synchronous)
                done(options.synchronous[requests.length - 1]);
            return () => {
                request.aborts++;
                fail();
                if (request.onAbort) request.onAbort();
            };
        },
        storage: {
            get: (key) => saved.get(key) ?? null,
            remove: (key) => saved.delete(key),
            set: (key, value) => saved.set(key, value),
        },
        translate: (message) => message,
        validateUrl: () => true,
    };
    if (options.catalog) {
        ports.core = {
            ...host.OttPlayCore,
            LegacyStalkerClient: function (...args) {
                const source = new host.OttPlayCore.LegacyStalkerClient(
                    ...args
                );
                source.channelCatalog = () => [];
                ports.channelCatalog = () => clone(options.catalog);
                return source;
            },
        };
    }
    const helpers = {
        emptyCatalog: host.emptyDriverCatalog,
        snapshot: host.driverCatalogSnapshot,
        transport: host.createDriverTransport,
    };
    const driver = host.__ottStalkerDriver.create(ports, owner, helpers);
    return {
        driver,
        helpers,
        host,
        owner,
        ports,
        progress,
        registry,
        requests,
        saved,
    };
};
