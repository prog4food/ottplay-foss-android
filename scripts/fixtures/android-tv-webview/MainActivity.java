package play.ott.simulator.web;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;

// Local simulator UI host only. It provides no Capacitor or native media bridge.
public class MainActivity extends Activity {
    private static final String USER_AGENT_MARKER = "OttplayTestWebView/1.0";
    private WebView webView;
    private final HashMap<Integer, KeyPress> keyPresses = new HashMap<>();

    private static class KeyPress {
        final String name;
        final boolean repeat;
        final ArrayList<KeyEvent> pending = new ArrayList<>();
        Boolean nativeInput;

        KeyPress(String name, boolean repeat) {
            this.name = name;
            this.repeat = repeat;
        }
    }

    private static boolean isPlayerUrl(String value) {
        try {
            URI url = new URI(value);
            return ("http".equalsIgnoreCase(url.getScheme())
                    || "https".equalsIgnoreCase(url.getScheme()))
                    && url.getHost() != null && url.getRawUserInfo() == null;
        } catch (Exception invalidUrl) {
            return false;
        }
    }

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        String userAgent = settings.getUserAgentString();
        if (!userAgent.contains(USER_AGENT_MARKER)) {
            settings.setUserAgentString(userAgent + " " + USER_AGENT_MARKER);
        }
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isPlayerUrl(request.getUrl().toString());
            }
        });
        setContentView(webView);
        webView.requestFocus();
        openPlayer(getIntent());
    }

    private void openPlayer(Intent intent) {
        String url = intent.getDataString();
        if (url == null) url = "http://127.0.0.1:8443/";
        if (isPlayerUrl(url)) {
            webView.loadUrl(url);
        } else {
            Toast.makeText(this, "Use an HTTP(S) player URL without credentials", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openPlayer(intent);
    }

    private String playerKeyScript(String name) {
        return "var k=window.keys,f=window._doKey;"
                + "if(k&&typeof f==='function'&&typeof k." + name + "==='number')"
                + "f.call(window,k." + name + ");";
    }

    private void deliverKey(KeyPress press, KeyEvent event) {
        if (press.nativeInput) {
            // Dispatch directly to the view, without re-entering Activity routing.
            webView.dispatchKeyEvent(event);
        } else if (event.getAction() == KeyEvent.ACTION_DOWN
                && (press.repeat || event.getRepeatCount() == 0)) {
            webView.evaluateJavascript("(function(){" + playerKeyScript(press.name) + "})();", null);
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        String name;
        boolean repeat = false;
        switch (event.getKeyCode()) {
            case KeyEvent.KEYCODE_DPAD_UP: name = "UP"; repeat = true; break;
            case KeyEvent.KEYCODE_DPAD_DOWN: name = "DOWN"; repeat = true; break;
            case KeyEvent.KEYCODE_DPAD_LEFT: name = "LEFT"; repeat = true; break;
            case KeyEvent.KEYCODE_DPAD_RIGHT: name = "RIGHT"; repeat = true; break;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER: name = "ENTER"; break;
            case KeyEvent.KEYCODE_BACK: name = "RETURN"; break;
            case KeyEvent.KEYCODE_MENU: name = "TOOLS"; break;
            case KeyEvent.KEYCODE_0: name = "N0"; break;
            case KeyEvent.KEYCODE_1: name = "N1"; break;
            case KeyEvent.KEYCODE_2: name = "N2"; break;
            case KeyEvent.KEYCODE_3: name = "N3"; break;
            case KeyEvent.KEYCODE_4: name = "N4"; break;
            case KeyEvent.KEYCODE_5: name = "N5"; break;
            case KeyEvent.KEYCODE_6: name = "N6"; break;
            case KeyEvent.KEYCODE_7: name = "N7"; break;
            case KeyEvent.KEYCODE_8: name = "N8"; break;
            case KeyEvent.KEYCODE_9: name = "N9"; break;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY: name = "PLAY"; break;
            case KeyEvent.KEYCODE_MEDIA_PAUSE: name = "PAUSE"; break;
            case KeyEvent.KEYCODE_MEDIA_STOP: name = "STOP"; break;
            case KeyEvent.KEYCODE_MEDIA_REWIND: name = "RW"; break;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: name = "FF"; break;
            case KeyEvent.KEYCODE_MEDIA_NEXT: name = "NEXT"; break;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS: name = "PREV"; break;
            default: return super.dispatchKeyEvent(event);
        }
        if (webView == null) return super.dispatchKeyEvent(event);
        int action = event.getAction();
        if (action != KeyEvent.ACTION_DOWN && action != KeyEvent.ACTION_UP)
            return super.dispatchKeyEvent(event);
        KeyPress press = keyPresses.get(event.getKeyCode());
        if (action == KeyEvent.ACTION_DOWN && (event.getRepeatCount() == 0 || press == null)) {
            final KeyPress started = new KeyPress(name, repeat);
            keyPresses.put(event.getKeyCode(), started);
            final KeyEvent first = new KeyEvent(event);
            final WebView target = webView;
            boolean editableKey = repeat || (name.length() == 2 && name.charAt(0) == 'N');
            String editable = editableKey
                    ? "var a=document.activeElement;if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.isContentEditable))return true;"
                    : "";
            String dispatch = repeat || event.getRepeatCount() == 0
                    ? "f.call(window,k." + name + ");" : "";
            target.evaluateJavascript("(function(){" + editable
                    + "var k=window.keys,f=window._doKey;"
                    + "if(!k||typeof f!=='function'||typeof k." + name + "!=='number')return true;"
                    + dispatch + "return false;})();", new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if (webView != target) return;
                    started.nativeInput = !"false".equals(value);
                    if (started.nativeInput) target.dispatchKeyEvent(first);
                    for (KeyEvent pending : started.pending) deliverKey(started, pending);
                    started.pending.clear();
                }
            });
        } else if (press != null) {
            // Preserve both phases and their order while the DOM focus query is pending.
            KeyEvent copy = new KeyEvent(event);
            if (press.nativeInput == null) press.pending.add(copy);
            else deliverKey(press, copy);
        } else {
            return super.dispatchKeyEvent(event);
        }
        if (action == KeyEvent.ACTION_UP) keyPresses.remove(event.getKeyCode());
        // A press keeps its initial route even if its first DOWN changes DOM focus.
        return true;
    }

    @Override
    protected void onDestroy() {
        keyPresses.clear();
        webView.destroy();
        webView = null;
        super.onDestroy();
    }
}
