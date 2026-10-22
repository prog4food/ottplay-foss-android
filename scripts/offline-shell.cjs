// Generate a finite, public app-shell cache. Never cache playlists, API responses or media.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const roots = [
    "dist",
    "js",
    "devices",
    "fonts",
    "styles",
    "images",
    "locales",
    "providers",
    "hosted",
];
const extensions =
    /\.(?:js|css|woff2?|ttf|otf|png|jpe?g|svg|gif|ico|webmanifest)$/i;
function stageOfflineShell(directory) {
    const assets = ["index.html"];
    function visit(relative) {
        const absolute = path.join(directory, relative);
        if (!fs.existsSync(absolute)) return;
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) return;
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(absolute).sort()) {
                if (
                    !name.startsWith(".") &&
                    !["logs", "node_modules", "__pycache__", "target"].includes(
                        name
                    )
                )
                    visit(relative + "/" + name);
            }
        } else if (extensions.test(relative)) assets.push(relative);
    }
    roots.forEach(visit);
    for (const file of ["player.js", "favicon.ico"]) visit(file);
    const unique = [...new Set(assets)]
        .filter((p) => fs.existsSync(path.join(directory, p)))
        .sort();
    const hash = crypto.createHash("sha256");
    unique.forEach((p) => {
        hash.update(p);
        hash.update(fs.readFileSync(path.join(directory, p)));
    });
    const version = hash.digest("hex").slice(0, 24);
    const worker =
        `/* Generated public app shell; no dynamic response caching. */\n` +
        `var FILES = ${JSON.stringify(unique)};\n` +
        `var BASE = new URL('./', self.location.href).href;\n` +
        `var PREFIX = 'ott-shell-' + encodeURIComponent(BASE) + '-';\n` +
        `var CACHE = PREFIX + '${version}';\n` +
        `var URLS = FILES.map(function (p) { return new URL(p, BASE).href; });\n` +
        `self.addEventListener('install', function (event) {\n` +
        `  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(URLS.map(function (url) { return new Request(url, { credentials: 'omit', cache: 'reload' }); })); }));\n` +
        `});\n` +
        `self.addEventListener('activate', function (event) {\n` +
        `  event.waitUntil(caches.keys().then(function (names) { return Promise.all(names.filter(function (name) { return name.indexOf(PREFIX) === 0 && name !== CACHE; }).map(function (name) { return caches.delete(name); })); }).then(function () { return self.clients.claim(); }));\n` +
        `});\n` +
        `self.addEventListener('fetch', function (event) {\n` +
        `  var request = event.request, url = new URL(request.url), index = new URL('index.html', BASE).href;\n` +
        `  if (request.method !== 'GET' || url.origin !== self.location.origin) return;\n` +
        `  if (request.mode === 'navigate' && (url.pathname === new URL(BASE).pathname || url.pathname === new URL(index).pathname || url.pathname.indexOf(new URL(BASE).pathname + 'f/') === 0)) {\n` +
        `    event.respondWith(fetch(new Request(request, { cache: 'no-cache' })).catch(function () { return caches.open(CACHE).then(function (cache) { return cache.match(index); }); })); return;\n` +
        `  }\n` +
        `  url.search = ''; url.hash = '';\n` +
        `  if (URLS.indexOf(url.href) === -1) return;\n` +
        `  event.respondWith(fetch(new Request(request, { cache: 'no-cache' })).catch(function () { return caches.open(CACHE).then(function (cache) { return cache.match(url.href); }); }));\n` +
        `});\n`;
    fs.writeFileSync(path.join(directory, "offline-worker.js"), worker);
    return { assets: unique, version };
}
module.exports = { stageOfflineShell };
if (require.main === module)
    console.log(
        JSON.stringify(
            stageOfflineShell(path.resolve(process.argv[2] || "dist"))
        )
    );
