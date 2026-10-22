// Execute the real MainActivity against small Android/Capacitor test doubles,
// then run its emitted scripts against the real TS controls and device maps.
const assert = require("node:assert/strict");
require("./test_android_home_setup.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ott-activity-"));
const javaHome =
    process.env.JAVA_HOME ||
    (process.platform === "darwin"
        ? cp
              .execFileSync("/usr/libexec/java_home", ["-v", "21"], {
                  encoding: "utf8",
              })
              .trim()
        : "");
const executable = (name) =>
    javaHome ? path.join(javaHome, "bin", name) : name;
const sources = [];
function write(name, source) {
    const file = path.join(temp, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    sources.push(file);
}
function functions(file, names) {
    const ast = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    const nodes = ast.statements.filter(
        (node) =>
            ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
    );
    assert.equal(nodes.length, names.length);
    return ts.transpileModule(
        nodes
            .map((node) => node.getText(ast).replace(/^export /, ""))
            .join("\n"),
        {
            compilerOptions: { target: ts.ScriptTarget.ES2015 },
        }
    ).outputText;
}

try {
    const keys = [
        "DPAD_UP",
        "DPAD_DOWN",
        "DPAD_LEFT",
        "DPAD_RIGHT",
        "DPAD_CENTER",
        "ENTER",
        "BACK",
        "MEDIA_PLAY_PAUSE",
        "MEDIA_PLAY",
        "MEDIA_PAUSE",
        "MEDIA_STOP",
        "VOLUME_UP",
        "VOLUME_DOWN",
        "MEDIA_NEXT",
        "MEDIA_PREVIOUS",
        "BUTTON_A",
        "BUTTON_SELECT",
        "BUTTON_B",
    ];
    write(
        "android/os/Bundle.java",
        "package android.os; public class Bundle {}"
    );
    write(
        "android/content/SharedPreferences.java",
        `package android.content; public class SharedPreferences {
        public boolean standby;
        public boolean getBoolean(String key,boolean fallback){
            if(!"standby".equals(key) || fallback)throw new AssertionError();
            return standby;
        }
    }`
    );
    write(
        "play/ott/foss/NativeWork.java",
        `package play.ott.foss; public class NativeWork {
        public static final NativeWork INSTANCE=new NativeWork();
        public boolean standby; public int calls;
        public boolean isStandby(){return standby;}
        public void setStandby(boolean value){standby=value;calls++;}
    }`
    );
    write(
        "android/view/KeyEvent.java",
        `package android.view; public class KeyEvent {
        public static final int ACTION_DOWN=0, ACTION_UP=1;
        ${keys.map((key, index) => `public static final int KEYCODE_${key}=${index + 10};`).join("\n")}
        private int action, code, repeat;
        public KeyEvent(int action,int code,int repeat){this.action=action;this.code=code;this.repeat=repeat;}
        public int getAction(){return action;} public int getKeyCode(){return code;} public int getRepeatCount(){return repeat;}
    }`
    );
    write(
        "android/webkit/WebView.java",
        `package android.webkit; public class WebView {
        public java.util.List<String> scripts=new java.util.ArrayList<>();
        public void evaluateJavascript(String script,Object callback){scripts.add(script);}
    }`
    );
    write(
        "com/getcapacitor/Bridge.java",
        "package com.getcapacitor; public class Bridge {public android.webkit.WebView view=new android.webkit.WebView(); public android.webkit.WebView getWebView(){return view;}}"
    );
    write(
        "com/getcapacitor/BridgeActivity.java",
        `package com.getcapacitor; public class BridgeActivity {
        public Bridge bridge; public int fallback; public java.util.List<String> plugins=new java.util.ArrayList<>();
        public android.content.SharedPreferences preferences=new android.content.SharedPreferences();
        public android.content.SharedPreferences getSharedPreferences(String name,int mode){
            if(!"ott-background".equals(name) || mode!=0)throw new AssertionError();
            return preferences;
        }
        public static final String AUDIO_SERVICE="audio";
        public android.media.AudioManager audio=new android.media.AudioManager();
        public Object getSystemService(String name){if(!AUDIO_SERVICE.equals(name))throw new AssertionError();return audio;}
        public void registerPlugin(Class<?> plugin){
            if(bridge!=null)throw new AssertionError("late plugin registration");
            if(play.ott.foss.NativeWork.INSTANCE.calls!=1 || play.ott.foss.NativeWork.INSTANCE.standby!=preferences.standby)
                throw new AssertionError("standby persistence must be restored before plugin registration");
            plugins.add(plugin.getName());
        }
        protected void onCreate(android.os.Bundle state){bridge=new Bridge();}
        public android.view.Window window=new android.view.Window(); public boolean focus=true,pip=false;
        public android.view.Window getWindow(){return window;}
        public boolean hasWindowFocus(){return focus;} public boolean isInPictureInPictureMode(){return pip;}
        public void onResume(){} public void onDestroy(){}
        public void onWindowFocusChanged(boolean value){focus=value;}
        public void onConfigurationChanged(android.content.res.Configuration value){}
        public Bridge getBridge(){return bridge;}
        public boolean dispatchKeyEvent(android.view.KeyEvent event){fallback++;return false;}
    }`
    );
    const uiStubs = {
        "android/content/res/Configuration.java":
            "package android.content.res; public class Configuration {}",
        "android/graphics/Color.java":
            "package android.graphics; public class Color { public static final int BLACK=0xff000000; }",
        "android/media/AudioManager.java": `package android.media; public class AudioManager {
            public static final int STREAM_MUSIC=3, ADJUST_RAISE=1, ADJUST_LOWER=-1, FLAG_SHOW_UI=1;
            public int volume=5, calls;
            public void adjustStreamVolume(int stream,int direction,int flags){
                if(stream!=STREAM_MUSIC || flags!=FLAG_SHOW_UI)throw new AssertionError();
                volume+=direction;calls++;
            }
        }`,
        "android/os/Build.java":
            "package android.os; public class Build { public static class VERSION { public static int SDK_INT=29; } }",
        "android/view/View.java": `package android.view; public class View {
            public ViewTreeObserver observer=new ViewTreeObserver();
            public ViewTreeObserver getViewTreeObserver(){return observer;}
            public void post(Runnable task){task.run();}
        }`,
        "android/view/ViewTreeObserver.java": `package android.view; public class ViewTreeObserver {
            public interface OnGlobalLayoutListener {void onGlobalLayout();}
            public OnGlobalLayoutListener listener;
            public boolean isAlive(){return true;}
            public void addOnGlobalLayoutListener(OnGlobalLayoutListener value){listener=value;}
            public void removeOnGlobalLayoutListener(OnGlobalLayoutListener value){if(listener!=value)throw new AssertionError();listener=null;}
        }`,
        "android/view/Window.java": `package android.view; public class Window {
            public View decor=new View(); public int cleared;
            public View getDecorView(){return decor;}
            public void setStatusBarColor(int value){} public void setNavigationBarColor(int value){}
            public void setStatusBarContrastEnforced(boolean value){} public void setNavigationBarContrastEnforced(boolean value){}
            public void clearFlags(int value){cleared=value;}
        }`,
        "android/view/WindowManager.java":
            "package android.view; public class WindowManager { public static class LayoutParams { public static final int FLAG_FORCE_NOT_FULLSCREEN=2048; } }",
        "androidx/core/view/ViewCompat.java": `package androidx.core.view; public class ViewCompat {
            public static WindowInsetsCompat getRootWindowInsets(android.view.View view){return new WindowInsetsCompat();}
        }`,
        "androidx/core/view/WindowCompat.java": `package androidx.core.view; public class WindowCompat {
            public static void setDecorFitsSystemWindows(android.view.Window window,boolean value){if(value)throw new AssertionError();}
            public static WindowInsetsControllerCompat getInsetsController(android.view.Window window,android.view.View view){return new WindowInsetsControllerCompat();}
        }`,
        "androidx/core/view/WindowInsetsCompat.java": `package androidx.core.view; public class WindowInsetsCompat {
            public static boolean imeVisible;
            public boolean isVisible(int type){return imeVisible;}
            public static class Type { public static int ime(){return 1;} public static int systemBars(){return 2;} }
        }`,
        "androidx/core/view/WindowInsetsControllerCompat.java": `package androidx.core.view; public class WindowInsetsControllerCompat {
            public static final int BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE=2;
            public static int hides;
            public void setAppearanceLightStatusBars(boolean value){} public void setAppearanceLightNavigationBars(boolean value){}
            public void setSystemBarsBehavior(int value){}
            public void hide(int type){if(type!=2)throw new AssertionError();hides++;}
        }`,
    };
    for (const [name, source] of Object.entries(uiStubs)) write(name, source);
    const pluginDir = "android/app/src/main/java/play/ott/foss";
    const plugins = [];
    const pluginSources = [pluginDir, "mobile-xmltv-epg/src/android"];
    const pluginFiles = pluginSources.flatMap((directory) =>
        fs
            .readdirSync(path.join(root, directory), { recursive: true })
            .filter((relative) => relative.endsWith(".kt"))
            .map((relative) => directory + "/" + relative)
    );
    for (const file of pluginFiles) {
        const source = read(file);
        if (!source.includes("@CapacitorPlugin")) continue;
        const packageName = /^package (.+)$/m.exec(source)[1];
        const className = /class (\w+)\s*:\s*Plugin/.exec(source)[1];
        plugins.push(packageName + "." + className);
        write(
            packageName.replace(/\./g, "/") + "/" + className + ".java",
            `package ${packageName}; public class ${className} {}`
        );
    }
    write(
        "play/ott/foss/MainActivity.java",
        read(pluginDir + "/MainActivity.java")
    );
    write(
        "play/ott/foss/ActivityTest.java",
        `package play.ott.foss;
        import android.view.KeyEvent; public class ActivityTest {
        static void check(boolean value){if(!value)throw new AssertionError();}
        public static void main(String[] args){
            MainActivity app=new MainActivity();
            check(!app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_DPAD_UP,0)));
            check(app.fallback==1);
            check(app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_VOLUME_UP,0)));
            check(app.audio.volume==6 && app.audio.calls==1);
            check(app.dispatchKeyEvent(new KeyEvent(1,KeyEvent.KEYCODE_VOLUME_UP,0)));
            check(app.audio.calls==1);
            app.preferences.standby=true;
            app.onCreate(new android.os.Bundle());
            check(NativeWork.INSTANCE.standby && NativeWork.INSTANCE.calls==1);
            int sleepingVolume=app.audio.volume, sleepingCalls=app.audio.calls;
            int sleepingScripts=app.bridge.view.scripts.size();
            check(app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_VOLUME_DOWN,0)));
            check(app.audio.volume==sleepingVolume && app.audio.calls==sleepingCalls);
            check(app.bridge.view.scripts.size()==sleepingScripts+1);
            System.out.println("VOLUME_WAKE_DOWN "+java.util.Base64.getEncoder().encodeToString(app.bridge.view.scripts.get(sleepingScripts).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            NativeWork.INSTANCE.standby=false;
            check(app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_VOLUME_DOWN,1)));
            check(app.audio.calls==sleepingCalls && app.bridge.view.scripts.size()==sleepingScripts+1);
            check(app.dispatchKeyEvent(new KeyEvent(1,KeyEvent.KEYCODE_VOLUME_DOWN,0)));
            check(app.audio.calls==sleepingCalls);
            System.out.println("VOLUME_WAKE_UP "+java.util.Base64.getEncoder().encodeToString(app.bridge.view.scripts.get(sleepingScripts+1).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            check(androidx.core.view.WindowInsetsControllerCompat.hides==1);
            check(app.window.cleared==2048);
            androidx.core.view.WindowInsetsCompat.imeVisible=true;
            app.window.decor.observer.listener.onGlobalLayout();
            app.onResume();
            check(androidx.core.view.WindowInsetsControllerCompat.hides==1);
            androidx.core.view.WindowInsetsCompat.imeVisible=false;
            app.window.decor.observer.listener.onGlobalLayout();
            check(androidx.core.view.WindowInsetsControllerCompat.hides==2);
            app.onWindowFocusChanged(false); app.onResume();
            check(androidx.core.view.WindowInsetsControllerCompat.hides==2);
            app.onWindowFocusChanged(true);
            check(androidx.core.view.WindowInsetsControllerCompat.hides==3);
            app.pip=true; app.onResume();
            check(androidx.core.view.WindowInsetsControllerCompat.hides==3);
            app.pip=false; app.onConfigurationChanged(new android.content.res.Configuration());
            check(androidx.core.view.WindowInsetsControllerCompat.hides==4);
            check(new java.util.HashSet<>(app.plugins).size()==app.plugins.size());
            for(String plugin:app.plugins)System.out.println("PLUGIN "+plugin);
            int[] codes={${keys.map((key) => "KeyEvent.KEYCODE_" + key).join(",")}};
            String[] names={${keys.map((key) => '"' + key + '"').join(",")}};
            for(int i=0;i<codes.length;i++){
                int previous=app.bridge.view.scripts.size();
                if(codes[i]==KeyEvent.KEYCODE_VOLUME_UP || codes[i]==KeyEvent.KEYCODE_VOLUME_DOWN){
                    int volume=app.audio.volume, calls=app.audio.calls;
                    int direction=codes[i]==KeyEvent.KEYCODE_VOLUME_UP?1:-1;
                    check(app.dispatchKeyEvent(new KeyEvent(0,codes[i],0)));
                    check(app.audio.volume==volume+direction && app.audio.calls==calls+1);
                    check(app.dispatchKeyEvent(new KeyEvent(0,codes[i],1)));
                    check(app.audio.volume==volume+direction*2 && app.audio.calls==calls+2);
                    check(app.dispatchKeyEvent(new KeyEvent(1,codes[i],0)));
                    check(app.audio.calls==calls+2);
                    check(app.bridge.view.scripts.size()==previous);
                    continue;
                }
                check(app.dispatchKeyEvent(new KeyEvent(0,codes[i],0)));
                check(app.bridge.view.scripts.size()==previous+1);
                System.out.println(names[i]+" "+java.util.Base64.getEncoder().encodeToString(app.bridge.view.scripts.get(previous).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
                check(app.dispatchKeyEvent(new KeyEvent(0,codes[i],1)));
                check(app.bridge.view.scripts.size()==previous+(names[i].startsWith("MEDIA_")?1:2));
            }
            check(!app.dispatchKeyEvent(new KeyEvent(0,999,0)));
            check(app.dispatchKeyEvent(new KeyEvent(1,KeyEvent.KEYCODE_DPAD_UP,0)));
            app.onDestroy();
            check(app.window.decor.observer.listener==null);
            app.bridge.view=null;
            int calls=app.audio.calls;
            check(app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_VOLUME_DOWN,0)));
            check(app.audio.calls==calls+1);
            app.audio=null;
            check(!app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_VOLUME_UP,0)));
            check(!app.dispatchKeyEvent(new KeyEvent(0,KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,0)));
            NativeWork.INSTANCE.calls=0;
            MainActivity awake=new MainActivity();
            awake.onCreate(new android.os.Bundle());
            check(!NativeWork.INSTANCE.standby && NativeWork.INSTANCE.calls==1);
            awake.onDestroy();
        }
    }`
    );
    cp.execFileSync(
        executable("javac"),
        ["-d", path.join(temp, "classes"), ...sources],
        { stdio: "pipe" }
    );
    const output = cp.execFileSync(
        executable("java"),
        ["-cp", path.join(temp, "classes"), "play.ott.foss.ActivityTest"],
        { encoding: "utf8" }
    );
    const registered = [],
        scripts = {};
    for (const line of output.trim().split("\n")) {
        const [name, value] = line.split(" ");
        if (name === "PLUGIN") registered.push(value);
        else scripts[name] = Buffer.from(value, "base64").toString();
    }
    assert.deepEqual(
        registered.sort(),
        plugins.sort(),
        "every shipped local plugin must reach bridge construction"
    );
    const wakeHost = { clearTimeout, setTimeout };
    wakeHost.window = wakeHost;
    vm.createContext(wakeHost);
    vm.runInContext(
        functions("src/core/standby.ts", ["installStandby"]),
        wakeHost
    );
    let wakes = 0;
    const gate = wakeHost.installStandby(
        wakeHost,
        () => "1",
        () => {}
    );
    wakeHost.stbSetStandby = (value) => gate.set(value, () => wakes++);
    vm.runInContext(scripts.VOLUME_WAKE_DOWN, wakeHost);
    assert.equal(
        wakes,
        1,
        "native volume first wakes without a volume adjustment"
    );
    assert.equal(gate.blocked(), false);
    vm.runInContext(scripts.VOLUME_WAKE_UP, wakeHost);
    assert.equal(wakes, 1);
    for (const name of ["DPAD_DOWN", "BACK", "MEDIA_PLAY_PAUSE"]) {
        let actions = 0;
        wakeHost.keys = { DOWN: 40, RETURN: 27 };
        wakeHost._doKey = () => actions++;
        wakeHost.stbIsPlaying = () => true;
        wakeHost.stbPause = () => actions++;
        gate.set(true);
        const before = wakes;
        vm.runInContext(scripts[name], wakeHost);
        assert.equal(wakes, before + 1, name + " first wakes");
        assert.equal(
            actions,
            0,
            name + " wake does not leak into the player action"
        );
        gate.localKey({ type: "keyup" });
        vm.runInContext(scripts[name], wakeHost);
        assert.equal(actions, 1, name + " works normally after wake");
        gate.localKey({ type: "keyup" });
    }
    const mapping = {
        BACK: "RETURN",
        BUTTON_A: "ENTER",
        BUTTON_B: "EXIT",
        BUTTON_SELECT: "ENTER",
        DPAD_CENTER: "ENTER",
        DPAD_DOWN: "DOWN",
        DPAD_LEFT: "LEFT",
        DPAD_RIGHT: "RIGHT",
        DPAD_UP: "UP",
        ENTER: "ENTER",
        MEDIA_NEXT: "NEXT",
        MEDIA_PREVIOUS: "PREV",
    };
    for (const adapter of ["pc", "android"]) {
        const source = read(`src/devices/${adapter}/device.ts`);
        const keyMap = vm.runInNewContext(
            "(" + /var \w*Keys = (\{[\s\S]*?\});/.exec(source)[1] + ")"
        );
        const received = [];
        const w = { _doKey: (key) => received.push(key), keys: keyMap };
        w.window = w;
        vm.createContext(w);
        for (const [nativeKey, appKey] of Object.entries(mapping)) {
            vm.runInContext(scripts[nativeKey], w);
            assert.equal(
                received.pop(),
                keyMap[appKey],
                adapter + " " + nativeKey
            );
        }
    }
    const controls = functions("src/core/index.ts", [
        "isCoreThenable",
        "setCoreDemoMute",
        "playCoreMedia",
        "cancelCoreSeek",
        "cancelCoreAutoPlayback",
        "cancelCoreStreamAttempt",
        "cancelCoreSourcePreparation",
        "cancelCoreNativeHls",
        "destroyCoreShaka",
        "resetCoreNativeBitrate",
        "stbContinue",
        "stbPause",
        "stbResume",
        "stbIsPlaying",
        "stbStop",
        "getCoreMediaBackend",
        "openCoreEngineLease",
        "stopCoreEngine",
    ]);
    const video = {
        pause() {
            this.paused = true;
        },
        paused: true,
        play() {
            this.paused = false;
            return Promise.resolve();
        },
        readyState: 0,
        removeAttribute() {},
    };
    let destroyed = 0;
    const w = {
        _coreAutoCancel: null,
        _coreDemoMute: null,
        _coreNativeAttempt: 0,
        _coreNativeHls: null,
        _coreNativeHlsCleanup: null,
        _corePendingSeek: null,
        _corePipSession: 0,
        _coreShakaTeardown: null,
        _inLiveRestart: false,
        _playSession: 0,
        cancelLiveRestart() {},
        clearInterval() {},
        clearPlayTimeInterval() {},
        console,
        coreAvTest: null,
        coreDeviceEffects: {},
        coreMediaBackend: null,
        coreSourcePreparationCancel: null,
        coreStreamAttempt: null,
        hlsInstance: {
            destroy() {
                destroyed++;
            },
        },
        setInterval() {
            return 1;
        },
        stbIsStandby: () => false,
        video,
    };
    w.window = w;
    vm.createContext(w);
    require("./helpers/private-runtime.cjs")(w, "src/device/media-backend.ts");
    w.startCoreEngine = () => {
        w._playSession++;
    };
    vm.runInContext(controls, w);
    w.stbResume(); // No current source is also a safe explicit Play.
    w.getCoreMediaBackend().open({ url: "fixture.mp4" });
    for (const readyState of [0, 1, 2]) {
        video.readyState = readyState;
        w.stbPause();
        for (let i = 0; i < 2; i++) {
            vm.runInContext(scripts.MEDIA_PLAY, w);
            assert.equal(
                video.paused,
                false,
                `Play at readyState ${readyState}`
            );
            assert.equal(w.stbIsPlaying(), readyState >= 2);
        }
    }
    for (let i = 0; i < 2; i++) {
        vm.runInContext(scripts.MEDIA_PAUSE, w);
        assert.equal(video.paused, true);
    }
    vm.runInContext(scripts.MEDIA_PLAY_PAUSE, w);
    assert.equal(video.paused, false);
    vm.runInContext(scripts.MEDIA_PLAY_PAUSE, w);
    assert.equal(video.paused, true);
    const resume = w.stbResume;
    delete w.stbResume;
    for (let i = 0; i < 2; i++) {
        vm.runInContext(scripts.MEDIA_PLAY, w);
        assert.equal(
            video.paused,
            false,
            "older bundles retain the Play fallback"
        );
    }
    w.stbResume = resume;
    const recovery = [];
    let pendingRecovery = true;
    w.coreStreamAttempt = {
        dispose() {
            recovery.push("dispose");
        },
        pause() {
            recovery.push("pause");
        },
        resume() {
            recovery.push("resume");
            return pendingRecovery;
        },
    };
    vm.runInContext(scripts.MEDIA_PAUSE, w);
    assert.equal(video.paused, true);
    vm.runInContext(scripts.MEDIA_PLAY, w);
    assert.equal(
        video.paused,
        true,
        "pending recovery must not resume a retired decoder"
    );
    assert.equal(w.forcePlay, true, "Play releases the user's pause intent");
    assert.deepEqual(recovery, ["pause", "resume"]);
    pendingRecovery = false;
    vm.runInContext(scripts.MEDIA_PLAY, w);
    assert.equal(
        video.paused,
        false,
        "ordinary resume is restored when recovery does not own it"
    );
    vm.runInContext(scripts.MEDIA_STOP, w);
    assert.deepEqual(recovery, ["pause", "resume", "resume", "dispose"]);
    assert.equal(
        w.coreStreamAttempt,
        null,
        "Stop retires the current recovery owner"
    );
    assert.equal(w._playSession, 2);
    assert.equal(w._coreNativeAttempt, 1);
    assert.equal(destroyed, 1);
    assert.equal(video.paused, true);
    console.log(
        "PASS Android activity: native hardware volume independent of WebView, persisted standby before plugin registration and bridge, boot fallback, media repeat suppression, actual PC/Android keymaps, idempotent Play/Pause and toggle lifecycle"
    );
} finally {
    fs.rmSync(temp, { force: true, recursive: true });
}
