const {
    attachSourceAliases,
    sourceNames,
} = require("./helpers/english-source-fixture.cjs");
// Compile the actual simulator Activity against minimal Android doubles, then
// execute its emitted JavaScript with the shipped PC and Android key maps.
// This verifies the local host contract; it does not emulate WebView or media.
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const fixture = "scripts/fixtures/android-tv-webview";
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const javaHome =
    process.env.JAVA_HOME ||
    (process.platform === "darwin"
        ? cp
              .execFileSync("/usr/libexec/java_home", [], {
                  encoding: "utf8",
              })
              .trim()
        : "");
const executable = (name) =>
    javaHome ? path.join(javaHome, "bin", name) : name;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ott-webview-host-"));
const sources = [];

function write(name, source) {
    const file = path.join(temp, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    sources.push(file);
}

function playerFunctions(file, names) {
    names = sourceNames(file, names);
    const ast = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    const selected = ast.statements.filter(
        (node) =>
            ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
    );
    assert.equal(
        selected.length,
        names.length,
        `${file}: production functions found`
    );
    return ts
        .transpileModule(selected.map((node) => node.getText(ast)).join("\n"), {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        })
        .outputText.replace(/^export /gm, "");
}

// Android framework constants, independent of the Activity's switch order.
const nativeCodes = {
    BACK: 4,
    ...Object.fromEntries(
        Array.from({ length: 10 }, (_, digit) => [String(digit), digit + 7])
    ),
    DPAD_CENTER: 23,
    DPAD_DOWN: 20,
    DPAD_LEFT: 21,
    DPAD_RIGHT: 22,
    DPAD_UP: 19,
    ENTER: 66,
    MEDIA_FAST_FORWARD: 90,
    MEDIA_NEXT: 87,
    MEDIA_PAUSE: 127,
    MEDIA_PLAY: 126,
    MEDIA_PLAY_PAUSE: 85,
    MEDIA_PREVIOUS: 88,
    MEDIA_REWIND: 89,
    MEDIA_STOP: 86,
    MENU: 82,
};
const mapping = {
    ...Object.fromEntries(
        Array.from({ length: 10 }, (_, digit) => [String(digit), `N${digit}`])
    ),
    BACK: "RETURN",
    DPAD_CENTER: "ENTER",
    DPAD_DOWN: "DOWN",
    DPAD_LEFT: "LEFT",
    DPAD_RIGHT: "RIGHT",
    DPAD_UP: "UP",
    ENTER: "ENTER",
    MEDIA_FAST_FORWARD: "FF",
    MEDIA_NEXT: "NEXT",
    MEDIA_PAUSE: "PAUSE",
    MEDIA_PLAY: "PLAY",
    MEDIA_PLAY_PAUSE: "PLAY",
    MEDIA_PREVIOUS: "PREV",
    MEDIA_REWIND: "RW",
    MEDIA_STOP: "STOP",
    MENU: "TOOLS",
};

try {
    write(
        "android/os/Bundle.java",
        "package android.os; public class Bundle {}"
    );
    write(
        "android/content/Context.java",
        "package android.content; public class Context {}"
    );
    write(
        "android/content/Intent.java",
        `package android.content; public class Intent {
            private final String data;
            public Intent(String value){data=value;}
            public String getDataString(){return data;}
        }`
    );
    write(
        "android/net/Uri.java",
        `package android.net; public class Uri {
            private final String value;
            public Uri(String value){this.value=value;}
            @Override public String toString(){return value;}
        }`
    );
    write(
        "android/view/View.java",
        `package android.view; public class View {
            public static final int SYSTEM_UI_FLAG_FULLSCREEN=4;
            public static final int SYSTEM_UI_FLAG_HIDE_NAVIGATION=2;
            public static final int SYSTEM_UI_FLAG_IMMERSIVE_STICKY=4096;
            public int visibilityFlags;
            public void setSystemUiVisibility(int flags){visibilityFlags=flags;}
        }`
    );
    write(
        "android/view/Window.java",
        `package android.view; public class Window {
            private final View decor=new View();
            public View getDecorView(){return decor;}
        }`
    );
    write(
        "android/view/KeyEvent.java",
        `package android.view; public class KeyEvent {
            public static final int ACTION_DOWN=0, ACTION_UP=1;
            ${Object.entries(nativeCodes)
                .map(
                    ([key, value]) =>
                        `public static final int KEYCODE_${key}=${value};`
                )
                .join("\n")}
            private int action, code, repeat;
            public KeyEvent(int action,int code,int repeat){this.action=action;this.code=code;this.repeat=repeat;}
            public KeyEvent(KeyEvent original){this(original.action,original.code,original.repeat);}
            public int getAction(){return action;}
            public int getKeyCode(){return code;}
            public int getRepeatCount(){return repeat;}
            public void invalidate(){action=99;code=999;repeat=99;}
        }`
    );
    write(
        "android/app/Activity.java",
        `package android.app; public class Activity extends android.content.Context {
            private android.content.Intent intent=new android.content.Intent(null);
            private final android.view.Window window=new android.view.Window();
            public android.view.View content;
            public int created, newIntents, destroyed, fallback;
            protected void onCreate(android.os.Bundle state){created++;}
            protected void onNewIntent(android.content.Intent intent){newIntents++;}
            protected void onDestroy(){destroyed++;}
            public android.content.Intent getIntent(){return intent;}
            public void setIntent(android.content.Intent intent){this.intent=intent;}
            public android.view.Window getWindow(){return window;}
            public void setContentView(android.view.View view){content=view;}
            public boolean dispatchKeyEvent(android.view.KeyEvent event){fallback++;return false;}
        }`
    );
    write(
        "android/webkit/WebSettings.java",
        `package android.webkit; public class WebSettings {
            public static String initialUserAgent="Mozilla/5.0 (Linux; Android 16; TV; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/139.0.0.0 Safari/537.36";
            private String userAgent=initialUserAgent;
            public int userAgentChanges;
            public String getUserAgentString(){return userAgent;}
            public void setUserAgentString(String value){userAgent=value;userAgentChanges++;}
            public final java.util.Map<String,Boolean> values=new java.util.HashMap<>();
            ${[
                "JavaScriptEnabled",
                "DomStorageEnabled",
                "AllowFileAccess",
                "AllowContentAccess",
                "AllowFileAccessFromFileURLs",
                "AllowUniversalAccessFromFileURLs",
                "MediaPlaybackRequiresUserGesture",
            ]
                .map(
                    (name) =>
                        `public void set${name}(boolean value){values.put("${name}",value);}`
                )
                .join("\n")}
        }`
    );
    write(
        "android/webkit/WebChromeClient.java",
        "package android.webkit; public class WebChromeClient {}"
    );
    write(
        "android/webkit/WebResourceRequest.java",
        "package android.webkit; public interface WebResourceRequest {android.net.Uri getUrl();}"
    );
    write(
        "android/webkit/WebViewClient.java",
        `package android.webkit; public class WebViewClient {
            public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){return false;}
        }`
    );
    // Deliberately provides no addJavascriptInterface/native bridge API.
    write(
        "android/webkit/ValueCallback.java",
        "package android.webkit; public interface ValueCallback<T> {void onReceiveValue(T value);}"
    );
    write(
        "android/webkit/WebView.java",
        `package android.webkit; public class WebView extends android.view.View {
            private final WebSettings settings=new WebSettings();
            public final java.util.List<String> urls=new java.util.ArrayList<>();
            public final java.util.List<String> scripts=new java.util.ArrayList<>();
            public final java.util.List<android.view.KeyEvent> nativeEvents=new java.util.ArrayList<>();
            public final java.util.List<ValueCallback<String>> callbacks=new java.util.ArrayList<>();
            public WebViewClient client;
            public WebChromeClient chromeClient;
            public boolean focused, destroyed, deferCallbacks;
            public String result="false";
            public WebView(android.content.Context context){}
            public WebSettings getSettings(){return settings;}
            public void setWebViewClient(WebViewClient value){client=value;}
            public void setWebChromeClient(WebChromeClient value){chromeClient=value;}
            public boolean requestFocus(){focused=true;return true;}
            public void loadUrl(String value){urls.add(value);}
            public void evaluateJavascript(String script,ValueCallback<String> callback){
                scripts.add(script);
                if(callback!=null){if(deferCallbacks)callbacks.add(callback);else callback.onReceiveValue(result);}
            }
            public void completeNext(String value){callbacks.remove(0).onReceiveValue(value);}
            public boolean dispatchKeyEvent(android.view.KeyEvent event){nativeEvents.add(event);return true;}
            public void destroy(){destroyed=true;}
        }`
    );
    write(
        "android/widget/Toast.java",
        `package android.widget; public class Toast {
            public static final int LENGTH_LONG=1;
            public static int shown;
            public static String lastText;
            public static Toast makeText(android.content.Context context,String text,int duration){lastText=text;return new Toast();}
            public void show(){shown++;}
        }`
    );
    write(
        "play/ott/simulator/web/MainActivity.java",
        read(`${fixture}/MainActivity.java`)
    );
    write(
        "play/ott/simulator/web/HostTest.java",
        `package play.ott.simulator.web;
        import android.content.Intent;
        import android.view.KeyEvent;
        import android.webkit.WebSettings;
        import android.webkit.WebView;
        import android.widget.Toast;
        public class HostTest {
            static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
            static void setting(WebView view,String key,boolean expected){
                check(Boolean.valueOf(expected).equals(view.getSettings().values.get(key)),"setting: "+key);
            }
            static boolean blocked(WebView view,String url){
                return view.client.shouldOverrideUrlLoading(view,()->new android.net.Uri(url));
            }
            static void printScript(String name,String script){
                System.out.println(name+" "+java.util.Base64.getEncoder().encodeToString(script.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            }
            static void nativeEvent(WebView view,int index,int action,int code,int repeat){
                KeyEvent event=view.nativeEvents.get(index);
                check(event.getAction()==action && event.getKeyCode()==code && event.getRepeatCount()==repeat,"native event order/content: "+index);
            }
            public static void main(String[] args){
                String standardUserAgent=WebSettings.initialUserAgent;
                String marker="OttplayTestWebView/1.0";
                MainActivity app=new MainActivity();
                check(!app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_DPAD_UP,0)),"pre-WebView fallback");
                check(app.fallback==1,"fallback count before create");
                app.onCreate(new android.os.Bundle());
                check(app.created==1,"base create called");
                check(app.content instanceof WebView,"WebView is the content");
                WebView view=(WebView)app.content;
                check(view.focused,"WebView focused");
                check(view.client!=null && view.chromeClient!=null,"clients attached");
                check(app.getWindow().getDecorView().visibilityFlags==(4|2|4096),"immersive fullscreen");
                check(view.urls.size()==1 && view.urls.get(0).equals("http://127.0.0.1:8443/"),"default local player");
                String markedUserAgent=view.getSettings().getUserAgentString();
                check(markedUserAgent.equals(standardUserAgent+" "+marker),"standard Android/Chromium UA preserved with only test-host suffix");
                check(markedUserAgent.indexOf(marker)==markedUserAgent.lastIndexOf(marker),"test-host marker appears once");
                check(view.getSettings().userAgentChanges==1,"standard UA changed once");
                WebSettings.initialUserAgent=markedUserAgent;
                MainActivity recreated=new MainActivity();
                recreated.onCreate(new android.os.Bundle());
                WebView recreatedView=(WebView)recreated.content;
                check(recreatedView.getSettings().getUserAgentString().equals(markedUserAgent),"existing marker is not duplicated");
                check(recreatedView.getSettings().userAgentChanges==0,"already marked UA is left unchanged");
                recreated.onDestroy();
                WebSettings.initialUserAgent=standardUserAgent;
                setting(view,"JavaScriptEnabled",true);
                setting(view,"DomStorageEnabled",true);
                setting(view,"AllowFileAccess",false);
                setting(view,"AllowContentAccess",false);
                setting(view,"AllowFileAccessFromFileURLs",false);
                setting(view,"AllowUniversalAccessFromFileURLs",false);
                setting(view,"MediaPlaybackRequiresUserGesture",false);

                String[] valid={
                    "http://127.0.0.1:8095/?config[provider]=demo&name=Living%20room#test",
                    "https://player.example.test/path%20name/?config[provider]=demo",
                    "HTTPS://player.example.test/",
                    "http://[::1]:8095/"
                };
                for(String url:valid){
                    int previous=view.urls.size(), previousIntents=app.newIntents;
                    Intent intent=new Intent(url);
                    app.onNewIntent(intent);
                    check(app.getIntent()==intent,"new intent retained");
                    check(app.newIntents==previousIntents+1,"base new intent called");
                    check(view.urls.size()==previous+1 && view.urls.get(previous).equals(url),"exact valid URL: "+url);
                    check(!blocked(view,url),"valid navigation allowed: "+url);
                    check(view.urls.size()==previous+1,"navigation callback does not load twice");
                }
                String[] invalid={"", "relative/path", "//player.example.test/", "http:///missing-host",
                    "http://:8095/", "http://player.example.test/a b", "javascript:alert(1)", "file:///tmp/player.html",
                    "content://player/", "data:text/html,player", "ftp://player.example.test/",
                    "http://user:password@player.example.test/", "https://user@player.example.test/",
                    "http://@player.example.test/", "https://user%40name@player.example.test/"};
                for(String url:invalid){
                    int previous=view.urls.size(), previousToasts=Toast.shown;
                    app.onNewIntent(new Intent(url));
                    check(view.urls.size()==previous,"invalid intent must preserve current page: "+url);
                    check(Toast.shown==previousToasts+1,"invalid intent explained");
                    check(Toast.lastText.contains("HTTP(S)"),"actionable error");
                    check(blocked(view,url),"invalid navigation blocked: "+url);
                }
                app.onNewIntent(new Intent(null));
                check(view.urls.get(view.urls.size()-1).equals("http://127.0.0.1:8443/"),"new intent default URL");

                int[] codes={${Object.keys(mapping)
                    .map((key) => `KeyEvent.KEYCODE_${key}`)
                    .join(",")}};
                String[] names={${Object.keys(mapping)
                    .map((key) => `"${key}"`)
                    .join(",")}};
                for(int i=0;i<codes.length;i++){
                    int previous=view.scripts.size();
                    check(app.dispatchKeyEvent(new KeyEvent(0,codes[i],0)),"handled DOWN: "+names[i]);
                    check(view.scripts.size()==previous+1,"one script per DOWN: "+names[i]);
                    printScript(names[i],view.scripts.get(previous));
                    check(app.dispatchKeyEvent(new KeyEvent(0,codes[i],1)),"handled repeat: "+names[i]);
                    boolean arrow=names[i].matches("DPAD_(UP|DOWN|LEFT|RIGHT)");
                    check(view.scripts.size()==previous+(arrow?2:1),"repeat policy: "+names[i]);
                    if(arrow)printScript(names[i]+"_REPEAT",view.scripts.get(previous+1));
                    check(app.dispatchKeyEvent(new KeyEvent(1,codes[i],1)),"handled repeated UP: "+names[i]);
                    check(view.scripts.size()==previous+(arrow?2:1),"repeated UP must not duplicate: "+names[i]);
                }
                check(view.nativeEvents.isEmpty(),"player key presses do not also reach native WebView");

                // Hold callback completion until after DOWN/repeat/UP have arrived.
                // Invalidate the caller's objects to expose retaining a borrowed event.
                view.deferCallbacks=true;
                int beforeNative=view.nativeEvents.size(), beforeScripts=view.scripts.size();
                KeyEvent down=new KeyEvent(0,KeyEvent.KEYCODE_5,0);
                KeyEvent held=new KeyEvent(0,KeyEvent.KEYCODE_5,1);
                KeyEvent up=new KeyEvent(1,KeyEvent.KEYCODE_5,1);
                app.dispatchKeyEvent(down);app.dispatchKeyEvent(held);app.dispatchKeyEvent(up);
                down.invalidate();held.invalidate();up.invalidate();
                check(view.nativeEvents.size()==beforeNative && view.scripts.size()==beforeScripts+1,"native events await one focus decision");
                view.completeNext("true");
                check(view.nativeEvents.size()==beforeNative+3,"native input keeps down/repeat/up");
                nativeEvent(view,beforeNative,0,KeyEvent.KEYCODE_5,0);
                nativeEvent(view,beforeNative+1,0,KeyEvent.KEYCODE_5,1);
                nativeEvent(view,beforeNative+2,1,KeyEvent.KEYCODE_5,1);
                check(view.nativeEvents.get(beforeNative)!=down,"native delivery uses copied event");
                check(view.scripts.size()==beforeScripts+1,"native repeats never re-enter player JS");

                beforeNative=view.nativeEvents.size();beforeScripts=view.scripts.size();
                app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_DPAD_LEFT,0));
                view.completeNext("true");
                app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_DPAD_LEFT,2));
                app.dispatchKeyEvent(new KeyEvent(1,KeyEvent.KEYCODE_DPAD_LEFT,2));
                check(view.nativeEvents.size()==beforeNative+3 && view.scripts.size()==beforeScripts+1,"native caret route survives later focus changes");
                nativeEvent(view,beforeNative,0,KeyEvent.KEYCODE_DPAD_LEFT,0);
                nativeEvent(view,beforeNative+1,0,KeyEvent.KEYCODE_DPAD_LEFT,2);
                nativeEvent(view,beforeNative+2,1,KeyEvent.KEYCODE_DPAD_LEFT,2);

                beforeNative=view.nativeEvents.size();beforeScripts=view.scripts.size();
                app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_DPAD_DOWN,0));
                app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_DPAD_DOWN,1));
                app.dispatchKeyEvent(new KeyEvent(1,KeyEvent.KEYCODE_DPAD_DOWN,1));
                view.completeNext("false");
                check(view.scripts.size()==beforeScripts+2,"queued menu repeat dispatches once");
                check(view.nativeEvents.size()==beforeNative,"queued menu UP never escapes to WebView");

                // An absent renderer result is a native fallback, not a swallowed key.
                app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_ENTER,0));
                app.dispatchKeyEvent(new KeyEvent(1,KeyEvent.KEYCODE_ENTER,0));
                view.completeNext("null");
                check(view.nativeEvents.size()==beforeNative+2,"unavailable page gets a complete native press");

                // A new press of the same code is independent while earlier callbacks wait.
                beforeNative=view.nativeEvents.size();
                app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_1,0));
                app.dispatchKeyEvent(new KeyEvent(1,KeyEvent.KEYCODE_1,0));
                app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_1,0));
                app.dispatchKeyEvent(new KeyEvent(1,KeyEvent.KEYCODE_1,0));
                view.completeNext("true");view.completeNext("false");
                check(view.nativeEvents.size()==beforeNative+2,"consecutive presses retain independent routes");
                int previous=view.scripts.size(), previousFallback=app.fallback;
                check(!app.dispatchKeyEvent(new KeyEvent(0,999,0)),"unknown DOWN fallback");
                check(!app.dispatchKeyEvent(new KeyEvent(1,999,0)),"unknown UP fallback");
                check(app.fallback==previousFallback+2 && view.scripts.size()==previous,"unknown keys do not dispatch JS");
                app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_DPAD_UP,0));
                beforeNative=view.nativeEvents.size();
                app.onDestroy();
                view.completeNext("true");
                check(view.nativeEvents.size()==beforeNative,"late callback does not use destroyed WebView");
                check(view.destroyed && app.destroyed==1,"WebView and base lifecycle destroyed");
            }
        }`
    );
    cp.execFileSync(
        executable("javac"),
        ["--release", "17", "-d", path.join(temp, "classes"), ...sources],
        { stdio: "pipe", timeout: 30000 }
    );
    const output = cp.execFileSync(
        executable("java"),
        ["-cp", path.join(temp, "classes"), "play.ott.simulator.web.HostTest"],
        { encoding: "utf8", timeout: 30000 }
    );
    const scripts = Object.fromEntries(
        output
            .trim()
            .split("\n")
            .map((line) => {
                const [name, encoded] = line.split(" ");
                return [name, Buffer.from(encoded, "base64").toString()];
            })
    );
    assert.deepEqual(
        Object.keys(scripts).sort(),
        [
            ...Object.keys(mapping),
            ...Object.keys(mapping)
                .filter((name) => /^DPAD_(UP|DOWN|LEFT|RIGHT)$/.test(name))
                .map((name) => name + "_REPEAT"),
        ].sort()
    );

    for (const adapter of ["pc", "pc2", "android"]) {
        const source = read(`src/devices/${adapter}/device.ts`);
        const object = /var \w*Keys = (\{[\s\S]*?\});/.exec(source);
        assert.ok(object, `${adapter}: real adapter key map exists`);
        const keyMap = vm.runInNewContext(`(${object[1]})`);
        if (/^pc/.test(adapter)) {
            assert.equal(
                keyMap.RANDOM,
                82,
                `${adapter}: physical R selects randomly`
            );
            assert.equal(
                keyMap.RW,
                33,
                `${adapter}: Page Up retains semantic rewind`
            );
            assert.notEqual(
                keyMap.RW,
                keyMap.RANDOM,
                `${adapter}: native rewind cannot trigger random playback`
            );
        }
        const w = {
            document: { activeElement: null },
            keys: keyMap,
            received: [],
            receivers: [],
        };
        w.window = w;
        vm.createContext(w);
        vm.runInContext(
            "window._doKey=function(key){received.push(key);receivers.push(this===window);};",
            w
        );
        attachSourceAliases(w);
        for (const [nativeKey, playerKey] of Object.entries(mapping)) {
            assert.equal(
                typeof keyMap[playerKey],
                "number",
                `${adapter}: ${playerKey} exists`
            );
            assert.notEqual(
                keyMap[playerKey],
                0,
                `${adapter}: ${playerKey} is supported`
            );
            const count = w.received.length;
            assert.equal(
                vm.runInContext(scripts[nativeKey], w),
                false,
                "ready player owns its press"
            );
            assert.equal(
                w.received.length,
                count + 1,
                `${adapter}: ${nativeKey} dispatches once`
            );
            assert.equal(
                w.received.at(-1),
                keyMap[playerKey],
                `${adapter}: ${nativeKey} mapping`
            );
            assert.equal(
                w.receivers.at(-1),
                true,
                `${adapter}: window receiver`
            );
            for (const element of [
                { tagName: "INPUT" },
                { tagName: "TEXTAREA" },
                { isContentEditable: true, tagName: "DIV" },
            ]) {
                w.document.activeElement = element;
                const before = w.received.length;
                const nativeEditing = /^\d$|^DPAD_(UP|DOWN|LEFT|RIGHT)$/.test(
                    nativeKey
                );
                assert.equal(
                    vm.runInContext(scripts[nativeKey], w),
                    nativeEditing,
                    `${adapter}: ${nativeKey} editable route`
                );
                assert.equal(
                    w.received.length,
                    before + (nativeEditing ? 0 : 1),
                    `${adapter}: editable typing must not also control player`
                );
            }
            w.document.activeElement = null;
        }
        // A prebuilt Java script must resolve both globals at event execution,
        // after the device adapter or key dispatcher has been replaced.
        vm.runInContext(
            "window.keys={UP:9123};window._doKey=function(key){received.push(key*2);receivers.push(this===window);};",
            w
        );
        attachSourceAliases(w);
        vm.runInContext(scripts.DPAD_UP, w);
        attachSourceAliases(w);
        assert.equal(
            w.received.at(-1),
            18246,
            `${adapter}: reads current globals`
        );
        assert.equal(w.receivers.at(-1), true);

        const count = w.received.length;
        for (const incomplete of [
            "window.keys=undefined;",
            "window.keys={};",
            "window.keys={UP:'19'};",
            "window.keys={UP:19};window._doKey=undefined;",
            "window._doKey={};",
        ]) {
            vm.runInContext(incomplete, w);
            attachSourceAliases(w);
            assert.equal(vm.runInContext(scripts.DPAD_UP, w), true);
            assert.equal(
                w.received.length,
                count,
                `${adapter}: incomplete boot returns native fallback`
            );
        }

        // Run the emitted bridge against the production key router and native
        // editor, not a replacement dispatcher that only records key numbers.
        const editor = {
            value: "http://127.0.0.1:8090/playlist123.m3u",
            visible: true,
        };
        const input = { tagName: "INPUT" };
        const saved = [];
        const moved = [];
        let restored = 0;
        const player = {
            $: (selector) => ({
                hide: () => {
                    editor.visible = false;
                },
                is: () => selector === "#listEdit" && editor.visible,
                val: () => editor.value,
            }),
            changeSelect: (delta) => moved.push(delta),
            console: { log() {} },
            document: {
                activeElement: input,
                getElementById: (id) => (id === "editvar" ? input : null),
            },
            isEditMode: false,
            isListVisible: true,
            isSelectBox: false,
            keys: keyMap,
            listKeyHandlerFn: undefined,
            listPageSize: 10,
            nativeListInertia: null,
            restoreCPD: () => {
                restored++;
            },
            setEdit: () => saved.push(player.editvar),
            settings: { volumeStep: 5 },
        };
        player.window = player;
        vm.createContext(player);
        require("./helpers/screen-runtime.cjs")(player);
        vm.runInContext(
            playerFunctions("src/core/index.ts", ["stbEventToKeyCode"]) +
                playerFunctions("src/key-handler/index.ts", [
                    "cancelNativeListInertia",
                    "dispatchKey",
                    "keyHandler",
                ]) +
                playerFunctions("src/ui/index.ts", ["editKey2"]) +
                "window._doKey=dispatchKey;window.editKey=editKey2;",
            player
        );
        attachSourceAliases(player);
        for (const nativeKey of [
            "0",
            "1",
            "9",
            "DPAD_LEFT",
            "DPAD_RIGHT",
            "DPAD_UP",
            "DPAD_DOWN",
        ]) {
            assert.equal(
                vm.runInContext(scripts[nativeKey], player),
                true,
                `${adapter}: native editor receives ${nativeKey}`
            );
            assert.equal(editor.visible, true);
            assert.equal(saved.length, 0);
            assert.equal(moved.length, 0);
        }
        for (const [key, keyCode] of [
            ["1", 49],
            ["ArrowLeft", 37],
            ["ArrowRight", 39],
        ]) {
            let prevented = 0;
            player.keyHandler({
                key,
                keyCode,
                preventDefault() {
                    prevented++;
                },
                stopPropagation() {},
                target: input,
            });
            assert.equal(
                prevented,
                0,
                `${adapter}: forwarded DOM ${key} retains native editing default`
            );
        }
        assert.equal(vm.runInContext(scripts.ENTER, player), false);
        assert.deepEqual(
            saved,
            [editor.value],
            `${adapter}: Enter still saves native editor exactly once`
        );
        assert.equal(editor.visible, false);
        assert.equal(restored, 1);
        editor.visible = true;
        editor.value = "discard this edit";
        assert.equal(vm.runInContext(scripts.BACK, player), false);
        assert.equal(
            saved.length,
            1,
            `${adapter}: Back cancels without a second save`
        );
        assert.equal(editor.visible, false);
        assert.equal(restored, 2);

        player.document.activeElement = null;
        for (const name of [
            "DPAD_DOWN",
            "DPAD_DOWN_REPEAT",
            "DPAD_UP",
            "DPAD_LEFT",
            "DPAD_RIGHT",
        ])
            vm.runInContext(scripts[name], player);
        assert.deepEqual(
            moved,
            [1, 1, -1, -10, 10],
            `${adapter}: real menu navigation and held-key repeat stay unchanged`
        );
    }

    const manifest = read(`${fixture}/AndroidManifest.xml`);
    const application = /<application\b[^>]*>/.exec(manifest)?.[0];
    assert.ok(application, "application manifest exists");
    assert.match(
        application,
        /android:enableOnBackInvokedCallback="false"/,
        "target 36 must retain KEYCODE_BACK dispatch for this Activity"
    );
    assert.match(application, /android:usesCleartextTraffic="true"/);
    assert.match(manifest, /android:targetSdkVersion="36"/);
    assert.match(manifest, /android.intent.category.LEANBACK_LAUNCHER/);
    console.log(
        "PASS Android TV WebView host: actual Java lifecycle/URL/settings, asynchronous key phases, native editing, and emitted JS with real PC/Android key routers"
    );
} finally {
    fs.rmSync(temp, { force: true, recursive: true });
}
