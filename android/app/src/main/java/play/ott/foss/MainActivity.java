package play.ott.foss;

import android.content.res.Configuration;
import android.graphics.Color;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import play.ott.foss.plugin.MobileXmltvEpgPlugin;

public class MainActivity extends BridgeActivity {
    private View playerDecor;
    private boolean keyboardWasVisible;
    private final java.util.Set<Integer> playerKeys = new java.util.HashSet<>();
    private final java.util.Set<Integer> standbyVolumeKeys = new java.util.HashSet<>();
    private final ViewTreeObserver.OnGlobalLayoutListener keyboardLayoutListener = () -> {
        if (playerDecor == null) return;
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(playerDecor);
        if (insets == null) return;
        boolean visible = insets.isVisible(WindowInsetsCompat.Type.ime());
        boolean keyboardClosed = keyboardWasVisible && !visible;
        keyboardWasVisible = visible;
        if (keyboardClosed) restoreImmersiveMode();
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        NativeWork.INSTANCE.setStandby(getSharedPreferences("ott-background", 0).getBoolean("standby", false));
        // These local Kotlin plugins are not in Capacitor's generated npm plugin list.
        // BridgeActivity creates the bridge in super.onCreate(), so add them first.
        registerPlugin(MobileNativeMediaPlugin.class);
        registerPlugin(NativeBackgroundPlugin.class);
        registerPlugin(MobileXmltvEpgPlugin.class);
        registerPlugin(M3UProxyPlugin.class);
        registerPlugin(LocalMediaPlugin.class);
        registerPlugin(StalkerPortalPlugin.class);
        registerPlugin(MobileCommandQueuePlugin.class);
        registerPlugin(DashExoPlayerPlugin.class);
        registerPlugin(RemoteScreenshotPlugin.class);
        registerPlugin(RuntimeDiagnosticsPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        super.onCreate(savedInstanceState);
        playerDecor = getWindow().getDecorView();
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        // Keep transient system bars dark while entering text or opening a dialog.
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        if (Build.VERSION.SDK_INT >= 29) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
        playerDecor.getViewTreeObserver().addOnGlobalLayoutListener(keyboardLayoutListener);
        restoreImmersiveMode();
    }

    void restoreImmersiveMode() {
        if (playerDecor == null || !hasWindowFocus() || (Build.VERSION.SDK_INT >= 24 && isInPictureInPictureMode())) return;
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(playerDecor);
        // Do not interfere with the IME's navigation controls. Restore when it closes.
        if (insets != null && insets.isVisible(WindowInsetsCompat.Type.ime())) return;
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FORCE_NOT_FULLSCREEN);
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), playerDecor);
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }

    @Override
    public void onResume() {
        super.onResume();
        if (playerDecor != null) playerDecor.post(this::restoreImmersiveMode);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && playerDecor != null) playerDecor.post(this::restoreImmersiveMode);
    }

    @Override
    public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (playerDecor != null) playerDecor.post(this::restoreImmersiveMode);
    }

    @Override
    public void onDestroy() {
        if (playerDecor != null && playerDecor.getViewTreeObserver().isAlive()) {
            playerDecor.getViewTreeObserver().removeOnGlobalLayoutListener(keyboardLayoutListener);
        }
        playerDecor = null;
        super.onDestroy();
    }

    private static String dispatchKey(String name) {
        return "(function(){if(window._doKey&&window.keys&&typeof window.keys."
                + name + "==='number')window._doKey(window.keys." + name + ");})();";
    }

    private static String localKeyScript(KeyEvent event) {
        return "window.__ottStandby&&window.__ottStandby.localKey&&window.__ottStandby.localKey({type:'"
                + (event.getAction() == KeyEvent.ACTION_UP ? "keyup" : "keydown")
                + "',repeat:" + (event.getRepeatCount() > 0) + "})";
    }

    private WebView playerWebView() {
        return getBridge() == null ? null : getBridge().getWebView();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN) {
            WebView view = playerWebView();
            if (standbyVolumeKeys.contains(code) || (view != null && NativeWork.INSTANCE.isStandby())) {
                if (event.getAction() == KeyEvent.ACTION_DOWN) {
                    boolean first = standbyVolumeKeys.add(code);
                    if (first && event.getRepeatCount() == 0 && view != null)
                        view.evaluateJavascript(localKeyScript(event), null);
                } else if (event.getAction() == KeyEvent.ACTION_UP) {
                    standbyVolumeKeys.remove(code);
                    if (view != null) view.evaluateJavascript(localKeyScript(event), null);
                }
                return true;
            }
            // Hardware volume must work while the WebView is locked, loading or stalled.
            // Consume key-up too, so the page cannot receive half of this native gesture.
            AudioManager audio = (AudioManager) getSystemService(AUDIO_SERVICE);
            if (audio == null) return super.dispatchKeyEvent(event);
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                audio.adjustStreamVolume(AudioManager.STREAM_MUSIC,
                        code == KeyEvent.KEYCODE_VOLUME_UP
                                ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER,
                        AudioManager.FLAG_SHOW_UI);
            }
            return true;
        }
        if (event.getAction() == KeyEvent.ACTION_UP && playerKeys.remove(code)) {
            WebView view = playerWebView();
            if (view != null) view.evaluateJavascript(localKeyScript(event), null);
            return true;
        }
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            String script = null;
            boolean mediaAction = false;

            switch (code) {
                case KeyEvent.KEYCODE_DPAD_UP:
                    script = dispatchKey("UP");
                    break;
                case KeyEvent.KEYCODE_DPAD_DOWN:
                    script = dispatchKey("DOWN");
                    break;
                case KeyEvent.KEYCODE_DPAD_LEFT:
                    script = dispatchKey("LEFT");
                    break;
                case KeyEvent.KEYCODE_DPAD_RIGHT:
                    script = dispatchKey("RIGHT");
                    break;
                case KeyEvent.KEYCODE_DPAD_CENTER:
                case KeyEvent.KEYCODE_ENTER:
                    script = dispatchKey("ENTER");
                    break;
                case KeyEvent.KEYCODE_BACK:
                    script = dispatchKey("RETURN");
                    break;
                case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                    script = "if(window.stbIsPlaying&&window.stbIsPlaying()){if(window.stbPause)window.stbPause();}else if(window.stbContinue)window.stbContinue();";
                    mediaAction = true;
                    break;
                case KeyEvent.KEYCODE_MEDIA_PLAY:
                    script = "if(typeof window.stbResume==='function')window.stbResume();else if(window.stbContinue&&window.stbIsPlaying&&!window.stbIsPlaying())window.stbContinue();";
                    mediaAction = true;
                    break;
                case KeyEvent.KEYCODE_MEDIA_PAUSE:
                    script = "if(window.stbPause)window.stbPause();";
                    mediaAction = true;
                    break;
                case KeyEvent.KEYCODE_MEDIA_STOP:
                    script = "if(window.stbStop)window.stbStop();";
                    mediaAction = true;
                    break;
                case KeyEvent.KEYCODE_MEDIA_NEXT:
                    script = dispatchKey("NEXT");
                    mediaAction = true;
                    break;
                case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                    script = dispatchKey("PREV");
                    mediaAction = true;
                    break;
                case KeyEvent.KEYCODE_BUTTON_A:
                case KeyEvent.KEYCODE_BUTTON_SELECT:
                    script = dispatchKey("ENTER");
                    break;
                case KeyEvent.KEYCODE_BUTTON_B:
                    script = dispatchKey("EXIT");
                    break;
                default:
                    break;
            }

            if (script != null) {
                // Only consume when inject succeeded. If bridge/webview is null
                // during early boot, fall through so keys are not swallowed forever.
                if (getBridge() != null) {
                    WebView webView = getBridge().getWebView();
                    if (webView != null) {
                        // One media action per press; navigation still repeats.
                        if (!mediaAction || event.getRepeatCount() == 0) {
                            playerKeys.add(code);
                            webView.evaluateJavascript("(function(){if(" + localKeyScript(event)
                                    + ")return;" + script + "})();", null);
                        }
                        return true;
                    }
                }
                return super.dispatchKeyEvent(event);
            }
        }
        return super.dispatchKeyEvent(event);
    }
}
