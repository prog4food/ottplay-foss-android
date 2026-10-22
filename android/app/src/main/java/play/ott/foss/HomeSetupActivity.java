package play.ott.foss;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.role.RoleManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/** Explicit operator entry point. Opening it never changes the Home app. */
public final class HomeSetupActivity extends Activity {
    private TextView status;
    private Button disable;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setTitle(R.string.home_setup_title);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(24 * getResources().getDisplayMetrics().density);
        content.setPadding(padding, padding, padding, padding);
        TextView explanation = new TextView(this);
        explanation.setText(R.string.home_setup_explanation);
        explanation.setTextSize(18);
        content.addView(explanation);
        status = new TextView(this);
        status.setPadding(0, padding, 0, padding);
        content.addView(status);
        addButton(content, R.string.home_setup_enable, this::confirmEnable);
        disable = addButton(content, R.string.home_setup_disable, this::confirmDisable);
        addButton(content, R.string.home_setup_settings, this::openHomeSettings);
        addButton(content, R.string.home_setup_close, this::finish);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    private Button addButton(LinearLayout content, int label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setFilterTouchesWhenObscured(true);
        button.setOnClickListener(view -> action.run());
        content.addView(button);
        return button;
    }

    private ComponentName homeAlias() {
        return new ComponentName(this, getPackageName() + ".HomeActivity");
    }

    private boolean aliasEnabled() {
        // The manifest default is disabled. Only an explicit enable opts in.
        return getPackageManager().getComponentEnabledSetting(homeAlias())
            == PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
    }

    private ComponentName selectedHome() {
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        PackageManager pm = getPackageManager();
        ResolveInfo selected = pm.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY);
        if (selected == null || selected.activityInfo == null) return null;
        // AOSP's boot placeholder only waits for a real launcher to become
        // available. Some firmware exposes it in the Home chooser as "Settings".
        if ("com.android.settings".equals(selected.activityInfo.packageName)
                && "com.android.settings.FallbackHome".equals(selected.activityInfo.name)) return null;
        // A system resolver/chooser is not a selected Home. Require a real,
        // enabled HOME candidate, visible through the narrow manifest query.
        // The query excludes runtime-disabled components. ActivityInfo.enabled
        // retains the manifest default even after an explicit runtime enable.
        for (ResolveInfo candidate : pm.queryIntentActivities(home, PackageManager.MATCH_DEFAULT_ONLY)) {
            ActivityInfo info = candidate.activityInfo;
            if (info != null && info.exported
                    && info.applicationInfo != null && info.applicationInfo.enabled
                    && info.packageName.equals(selected.activityInfo.packageName)
                    && info.name.equals(selected.activityInfo.name)) {
                return new ComponentName(info.packageName, info.name);
            }
        }
        return null;
    }

    private boolean anotherHomeSelected() {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                RoleManager roles = getSystemService(RoleManager.class);
                if (roles != null && roles.isRoleAvailable(RoleManager.ROLE_HOME)
                        && roles.isRoleHeld(RoleManager.ROLE_HOME)) return false;
            }
            ComponentName home = selectedHome();
            return home != null && !home.getPackageName().equals(getPackageName());
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    private void refresh() {
        try {
            boolean enabled = aliasEnabled();
            ComponentName home = selectedHome();
            status.setText(!enabled ? R.string.home_setup_disabled
                : home != null && home.getPackageName().equals(getPackageName())
                    ? R.string.home_setup_selected : R.string.home_setup_available);
            disable.setEnabled(enabled);
        } catch (RuntimeException unavailable) {
            status.setText(R.string.home_setup_unavailable);
            disable.setEnabled(false);
        }
    }

    private void confirm(int message, int button, Runnable action) {
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle(R.string.home_setup_title)
            .setMessage(message)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(button, (which, value) -> action.run())
            .create();
        dialog.show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setFilterTouchesWhenObscured(true);
    }

    private void confirmEnable() {
        confirm(R.string.home_setup_enable_confirmation, R.string.home_setup_enable, () -> {
            try {
                getPackageManager().setComponentEnabledSetting(homeAlias(),
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP);
                refresh();
                requestHome();
            } catch (RuntimeException unavailable) {
                showUnavailable();
            }
        });
    }

    private void requestHome() {
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                RoleManager roles = getSystemService(RoleManager.class);
                if (roles != null && roles.isRoleAvailable(RoleManager.ROLE_HOME)) {
                    if (roles.isRoleHeld(RoleManager.ROLE_HOME)) {
                        // The role and effective Home can disagree on vendor firmware.
                        ComponentName home = selectedHome();
                        if (home == null || !home.getPackageName().equals(getPackageName())) {
                            openHomeSettings();
                        }
                        return;
                    }
                    startActivityForResult(roles.createRequestRoleIntent(RoleManager.ROLE_HOME), 1);
                    return;
                }
            } catch (RuntimeException unavailable) {
                // Some TV firmware omits the role UI; try its Home settings.
            }
        }
        openHomeSettings();
    }

    private void confirmDisable() {
        if (!anotherHomeSelected()) {
            confirm(R.string.home_setup_choose_other, R.string.home_setup_settings, this::openHomeSettings);
            return;
        }
        confirm(R.string.home_setup_disable_confirmation, R.string.home_setup_disable, () -> {
            // Recheck after the dialog: another actor may have changed Home.
            if (!anotherHomeSelected()) {
                openHomeSettings();
                return;
            }
            try {
                getPackageManager().setComponentEnabledSetting(homeAlias(),
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
                refresh();
            } catch (RuntimeException unavailable) {
                showUnavailable();
            }
        });
    }

    private void openHomeSettings() {
        try {
            startActivity(new Intent(Settings.ACTION_HOME_SETTINGS));
        } catch (RuntimeException noHomeSettings) {
            try {
                startActivity(new Intent(Settings.ACTION_SETTINGS));
            } catch (RuntimeException noSettings) {
                showUnavailable();
            }
        }
    }

    private void showUnavailable() {
        Toast.makeText(this, R.string.home_setup_unavailable, Toast.LENGTH_LONG).show();
    }
}
