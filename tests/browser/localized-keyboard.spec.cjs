const { test, expect } = require("@playwright/test");
const {
    declarations,
    initializeKeyboard,
    keyboardCode,
    read,
} = require("../helpers/localized-keyboard.cjs");
const fixtures = JSON.parse(read("tests/fixtures/locale-alphabets.json"));
const code = keyboardCode();

test("RTL dialog punctuation and mixed identifiers keep text flow without reversing remote keys", async ({
    page,
}) => {
    await page.setViewportSize({ height: 720, width: 1280 });
    await page.setContent(
        "<style>" +
            read("styles/player.css") +
            '</style><div id="listEdit"></div><div id="listPodval"></div><div id="dialogbox"></div>'
    );
    await page.addScriptTag({ content: read("js/jquery-1.11.1.min.js") });
    await page.evaluate(initializeKeyboard);
    await page.addScriptTag({
        content:
            code +
            declarations("src/ui/index.ts", ["localizedTextHtml", "infoBox"]),
    });
    await page.addScriptTag({ content: read("locales/arabic.js") });
    const result = await page.evaluate(() => {
        window.strENTER = "ENTER";
        window.__ottClassicScreenPort.setOwnedCallback = function () {};
        applyLanguageMetadata("_ara");
        infoBox(
            _(
                "ERROR: Category #%1 does not exist!<br>Please select another category.",
                12
            )
        );
        const body = document.querySelector("#dialogbox .localized-text");
        function position(node, at) {
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + 1);
            return range.getBoundingClientRect().x;
        }
        const first = body.firstChild;
        const beforeBreak = Array.from(body.childNodes).find(
            (n) => n.nodeType === 3 && n.textContent.includes("!")
        );
        const punctuationCorrect =
            position(beforeBreak, beforeBreak.textContent.indexOf("!")) <
            position(first, 0);
        const direction = getComputedStyle(body).direction;
        const number = body.querySelector("bdi");
        const token = {
            direction: getComputedStyle(number).direction,
            isolation: getComputedStyle(number).unicodeBidi,
            text: number.textContent,
        };
        infoBox(
            'افتح https://example.com/watch?id=12&amp;lang=ar ثم تابع!<img src=x onerror="window.bad=true"><script>window.bad=true</script>'
        );
        const url = Array.from(
            document.querySelectorAll("#dialogbox bdi")
        ).find((n) => n.textContent.startsWith("https://"));
        const urlText = url.textContent;
        const unsafe = !!document.querySelector(
            "#dialogbox script, #dialogbox [onerror]"
        );
        window.fixtureLocale = "_ara";
        window.editvar = "";
        showEditKey1();
        const before = _keyCur;
        editKey1(keys.RIGHT);
        const right = _keyCur;
        editKey1(keys.LEFT);
        const left = _keyCur;
        const rootDirection = getComputedStyle(document.body).direction;
        applyLanguageMetadata("_eng");
        infoBox("Ready!");
        return {
            before,
            direction,
            englishDirection: getComputedStyle(
                document.querySelector("#dialogbox .localized-text")
            ).direction,
            left,
            punctuationCorrect,
            right,
            rootDirection,
            token,
            unsafe,
            urlText,
        };
    });
    expect(result.direction).toBe("rtl");
    expect(result.punctuationCorrect).toBe(true);
    expect(result.token).toEqual({
        direction: "ltr",
        isolation: "isolate",
        text: "#12",
    });
    expect(result.urlText).toBe("https://example.com/watch?id=12&lang=ar");
    expect(result.unsafe).toBe(false);
    expect(result.right).toBe(
        result.before % 10 < 9 ? result.before + 1 : result.before - 9
    );
    expect(result.left).toBe(result.before);
    expect(result.rootDirection).toBe("ltr");
    expect(result.englishDirection).toBe("ltr");
});

test("remote keyboard keeps every alphabet page visible at supported densities and resolutions", async ({
    page,
}) => {
    await page.setContent(
        "<style>" +
            read("styles/player.css") +
            '</style><div id="listEdit"></div><div id="listPodval"></div>'
    );
    await page.addScriptTag({ content: read("js/jquery-1.11.1.min.js") });
    await page.evaluate(initializeKeyboard);
    await page.addScriptTag({ content: code });
    // Complete fixture alphabets isolate geometry from translation content;
    // test_localized_keyboard.cjs separately asserts every shipped pack matches.
    for (const [width, height] of [
        [640, 360],
        [900, 506],
        [1280, 720],
        [1920, 1080],
        [3840, 2160],
    ]) {
        await page.setViewportSize({ height, width });
        for (const density of [10, 25, 30]) {
            for (const theme of [0, 1, 2]) {
                const result = await page.evaluate(
                    ({ width, height, density, theme, locales }) => {
                        const x = width / 1280,
                            y = height / 720;
                        const inset = theme === 2 ? 40 : theme === 1 ? 60 : 0;
                        const top =
                            (theme === 2 ? 100 : theme === 1 ? 110 : 53) * y;
                        const bottom =
                            (theme === 2 ? 80 : theme === 1 ? 100 : 53) * y;
                        const split =
                            theme === 2 ? 520 : theme === 1 ? 530 : 522;
                        const panel = document.getElementById("listEdit");
                        Object.assign(panel.style, {
                            bottom: bottom + "px",
                            fontSize: (height - 130 * y) / density + "px",
                            left: split * x + "px",
                            padding: 14 * y + "px " + 16 * x + "px",
                            right: inset * x + "px",
                            top: top + "px",
                        });
                        const violations = [];
                        for (const [lang, locale] of Object.entries(locales)) {
                            window.fixtureLocale = lang;
                            window.keyStrings = {
                                alhabet: locale.alphabet,
                                "Next keyboard page": "Next keyboard page",
                            };
                            window.editCaption = "Search / Edit playlist URL";
                            window.editvar =
                                "https://example.com/playlist.m3u8?token=long-value&name=letters";
                            window.editPos = window.editvar.length;
                            _keyP = false;
                            _setLang(false);
                            for (let p = 0; p < _keyPages; p++) {
                                _keyPage = p;
                                _buildKeyboard();
                                _setCase(true);
                                showEdit();
                                const outer = panel.getBoundingClientRect();
                                for (const cell of panel.querySelectorAll(
                                    ".osk-key"
                                )) {
                                    const rect = cell.getBoundingClientRect();
                                    if (
                                        rect.left < outer.left - 1 ||
                                        rect.right > outer.right + 1 ||
                                        rect.bottom > outer.bottom + 1
                                    )
                                        violations.push({
                                            bottom: rect.bottom,
                                            cell: cell.textContent,
                                            lang,
                                            p,
                                            panelBottom: outer.bottom,
                                            panelRight: outer.right,
                                            right: rect.right,
                                        });
                                }
                            }
                        }
                        return violations.slice(0, 3);
                    },
                    {
                        density,
                        height,
                        locales: Object.fromEntries(
                            [
                                "_rus",
                                "_ger",
                                "_arm",
                                "_gre",
                                "_heb",
                                "_dut",
                                "_vie",
                                "_ara",
                                "_urd",
                                "_hin",
                                "_ben",
                                "_mal",
                                "_sin",
                                "_tha",
                                "_bur",
                                "_khm",
                                "_geo",
                                "_amh",
                                "_lao",
                                "_ori",
                                "_asm",
                                "_snd",
                                "_yor",
                                "_ibo",
                            ].map((name) => [name, fixtures.locales[name]])
                        ),
                        theme,
                        width,
                    }
                );
                expect(
                    result,
                    JSON.stringify({ density, height, theme, width })
                ).toEqual([]);
            }
        }
    }
});

test("remote and pointer input reach later pages and preserve expanded case text", async ({
    page,
}) => {
    await page.setContent(
        "<style>" +
            read("styles/player.css") +
            '</style><div id="listEdit"></div><div id="listPodval"></div>'
    );
    await page.addScriptTag({ content: read("js/jquery-1.11.1.min.js") });
    await page.evaluate(initializeKeyboard);
    await page.addScriptTag({ content: code });
    await page.evaluate((locale) => {
        window.fixtureLocale = "_vie";
        window.keyStrings = { alhabet: locale.alphabet };
        _keyP = false;
        _setLang(false);
        _setCase(false);
        showEdit();
    }, fixtures.locales._vie);
    await page.getByLabel("Next keyboard page").click();
    await expect(page.getByLabel("Next keyboard page")).toHaveText("2/3 ›");
    const value = await page.evaluate(() => {
        _keyCur = 10;
        const expected = _keys[_keyCur];
        editKey1(keys.ENTER);
        return { actual: editvar, expected };
    });
    expect(value.actual).toBe(value.expected);
    await page.evaluate(() => {
        _keyCur = _keys.length - 2;
        editKey1(keys.ENTER);
    });
    await expect(page.getByLabel("Next keyboard page")).toHaveText("3/3 ›");
});
