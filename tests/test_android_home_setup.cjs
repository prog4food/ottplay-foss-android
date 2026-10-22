// Run the production Activity against Android boundary doubles. No emulator,
// role ownership, component state, or user preferences are changed by this test.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ott-home-setup-"));
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
try {
    const stubs = {
        "android/app/Activity.java": `package android.app; public class Activity {
            public android.content.pm.PackageManager pm=new android.content.pm.PackageManager();
            public android.app.role.RoleManager roles=new android.app.role.RoleManager();
            public java.util.List<String> starts=new java.util.ArrayList<>();
            public android.view.View content;
            public boolean rejectHomeSettings,rejectSettings,rejectRole;
            protected void onCreate(android.os.Bundle state){}
            protected void onResume(){}
            public void setTitle(int title){}
            public void setContentView(android.view.View value){content=value;}
            public android.content.res.Resources getResources(){return new android.content.res.Resources();}
            public android.content.pm.PackageManager getPackageManager(){return pm;}
            public String getPackageName(){return "play.ott.foss";}
            public <T> T getSystemService(Class<T> type){return type.cast(roles);}
            public android.content.Intent getIntent(){throw new AssertionError("Intent input must not control setup");}
            public void startActivity(android.content.Intent i){
                if((rejectHomeSettings && i.action.equals("home-settings")) || (rejectSettings && i.action.equals("settings")))
                    throw new SecurityException();
                starts.add(i.action);
            }
            public void startActivityForResult(android.content.Intent i,int request){
                if(rejectRole)throw new SecurityException(); startActivity(i);
            }
            public void finish(){}
        }`,
        "android/app/AlertDialog.java": `package android.app; public class AlertDialog implements android.content.DialogInterface {
            public static final int BUTTON_POSITIVE=-1;
            public static AlertDialog last;
            public android.content.DialogInterface.OnClickListener positive,negative;
            public android.widget.Button button=new android.widget.Button(null);
            public void show(){last=this;}
            public android.widget.Button getButton(int which){return button;}
            public void yes(){if(!button.filter)throw new AssertionError("Confirmation must filter obscured touches");positive.onClick(this,-1);}
            public void cancel(){if(negative!=null)negative.onClick(this,-2);}
            public static class Builder {
                private AlertDialog dialog=new AlertDialog();
                public Builder(Activity activity){}
                public Builder setTitle(int value){return this;}
                public Builder setMessage(int value){return this;}
                public Builder setNegativeButton(int value,android.content.DialogInterface.OnClickListener fn){dialog.negative=fn;return this;}
                public Builder setPositiveButton(int value,android.content.DialogInterface.OnClickListener fn){dialog.positive=fn;return this;}
                public AlertDialog create(){return dialog;}
            }
        }`,
        "android/app/role/RoleManager.java": `package android.app.role; public class RoleManager {
            public static final String ROLE_HOME="home";
            public boolean available=true,held,fail;
            public int requests;
            public boolean isRoleAvailable(String role){if(fail)throw new SecurityException();return available;}
            public boolean isRoleHeld(String role){if(fail)throw new SecurityException();return held;}
            public android.content.Intent createRequestRoleIntent(String role){
                if(!available || held)throw new AssertionError("Unexpected role request");
                requests++;return new android.content.Intent("request-home-role");
            }
        }`,
        "android/content/ComponentName.java": `package android.content; public class ComponentName {
            public final String pkg, name;
            public ComponentName(String p,String n){pkg=p;name=n;}
            public ComponentName(android.app.Activity a,String n){this(a.getPackageName(),n);}
            public String getPackageName(){return pkg;}
        }`,
        "android/content/DialogInterface.java": `package android.content; public interface DialogInterface {
            interface OnClickListener { void onClick(DialogInterface dialog,int which); }
        }`,
        "android/content/Intent.java": `package android.content; public class Intent {
            public static final String ACTION_MAIN="main", CATEGORY_HOME="home";
            public String action, category;
            public Intent(String value){action=value;}
            public Intent addCategory(String value){category=value;return this;}
        }`,
        "android/content/pm/ActivityInfo.java": `package android.content.pm; public class ActivityInfo {
            public boolean enabled=true, exported=true;
            public String packageName, name;
            public ApplicationInfo applicationInfo=new ApplicationInfo();
        }`,
        "android/content/pm/ApplicationInfo.java":
            "package android.content.pm; public class ApplicationInfo { public boolean enabled=true; }",
        "android/content/pm/PackageManager.java": `package android.content.pm;
        public class PackageManager {
            public static final int MATCH_DEFAULT_ONLY=1, COMPONENT_ENABLED_STATE_ENABLED=1,
                COMPONENT_ENABLED_STATE_DISABLED=2, DONT_KILL_APP=1;
            public int state, writes;
            public boolean failRead, failWrite;
            public ResolveInfo selected;
            public java.util.List<ResolveInfo> candidates=new java.util.ArrayList<>();
            public int getComponentEnabledSetting(android.content.ComponentName c){
                if(failRead)throw new SecurityException(); return state;
            }
            public void setComponentEnabledSetting(android.content.ComponentName c,int value,int flags){
                if(!c.pkg.equals("play.ott.foss") || !c.name.equals("play.ott.foss.HomeActivity") || flags!=DONT_KILL_APP)
                    throw new AssertionError("Only the own Home alias may change");
                if(failWrite)throw new SecurityException(); state=value;writes++;
            }
            void check(android.content.Intent i,int flags){
                if(!android.content.Intent.ACTION_MAIN.equals(i.action) ||
                    !android.content.Intent.CATEGORY_HOME.equals(i.category) || flags!=MATCH_DEFAULT_ONLY)
                    throw new AssertionError("Narrow HOME lookup required");
                if(failRead)throw new SecurityException();
            }
            public ResolveInfo resolveActivity(android.content.Intent i,int flags){check(i,flags);return selected;}
            public java.util.List<ResolveInfo> queryIntentActivities(android.content.Intent i,int flags){
                check(i,flags);
                java.util.List<ResolveInfo> result=new java.util.ArrayList<>();
                for(ResolveInfo candidate:candidates)if(candidate.runtimeEnabled)result.add(candidate);
                return result;
            }
        }`,
        "android/content/pm/ResolveInfo.java": `package android.content.pm; public class ResolveInfo {
            public ActivityInfo activityInfo=new ActivityInfo();
            public int priority;
            // Android resolves the runtime override before the manifest flag.
            public boolean runtimeEnabled=true;
            public ResolveInfo(String p,String n){activityInfo.packageName=p;activityInfo.name=n;}
        }`,
        "android/content/res/Resources.java": `package android.content.res; public class Resources {
            public android.util.DisplayMetrics getDisplayMetrics(){return new android.util.DisplayMetrics();}
        }`,
        "android/os/Build.java":
            "package android.os; public class Build { public static class VERSION { public static int SDK_INT=29; } }",
        "android/os/Bundle.java": "package android.os; public class Bundle {}",
        "android/provider/Settings.java": `package android.provider; public class Settings {
            public static final String ACTION_HOME_SETTINGS="home-settings", ACTION_SETTINGS="settings";
        }`,
        "android/R.java":
            "package android; public class R { public static class string { public static int cancel=1; } }",
        "android/util/DisplayMetrics.java":
            "package android.util; public class DisplayMetrics { public float density=1; }",
        "android/view/View.java": `package android.view; public class View {
            public interface OnClickListener {void onClick(View view);}
            public OnClickListener click;
            public boolean enabled=true, filter;
            public void setOnClickListener(OnClickListener value){click=value;}
            public void setFilterTouchesWhenObscured(boolean value){filter=value;}
            public void setEnabled(boolean value){enabled=value;}
            public void setPadding(int a,int b,int c,int d){}
            public void performClick(){if(enabled && click!=null)click.onClick(this);}
        }`,
        "android/widget/Button.java": `package android.widget; public class Button extends TextView {
            public Button(android.app.Activity a){super(a);}
        }`,
        "android/widget/LinearLayout.java": `package android.widget; public class LinearLayout extends android.view.View {
            public static final int VERTICAL=1;
            public java.util.List<android.view.View> children=new java.util.ArrayList<>();
            public LinearLayout(android.app.Activity a){}
            public void setOrientation(int value){}
            public void addView(android.view.View v){children.add(v);}
        }`,
        "android/widget/ScrollView.java": `package android.widget; public class ScrollView extends android.view.View {
            public android.view.View child;
            public ScrollView(android.app.Activity a){}
            public void addView(android.view.View value){child=value;}
        }`,
        "android/widget/TextView.java": `package android.widget; public class TextView extends android.view.View {
            public int text;
            public TextView(android.app.Activity a){}
            public void setText(int value){text=value;}
            public void setTextSize(int value){}
        }`,
        "android/widget/Toast.java": `package android.widget; public class Toast {
            public static final int LENGTH_LONG=1; public static int shown;
            public static Toast makeText(android.app.Activity a,int text,int duration){return new Toast();}
            public void show(){shown++;}
        }`,
    };
    for (const [name, source] of Object.entries(stubs)) write(name, source);
    const xml = fs.readFileSync(
        path.join(root, "android/app/src/main/res/values/strings.xml"),
        "utf8"
    );
    const labels = [...xml.matchAll(/<string name="(home_setup_\w+)"/g)].map(
        (m) => m[1]
    );
    assert.ok(labels.length > 10);
    write(
        "play/ott/foss/R.java",
        `package play.ott.foss; public class R { public static class string {
        ${labels.map((name, i) => `public static final int ${name}=${i + 10};`).join("\n")}
    } }`
    );
    write(
        "play/ott/foss/HomeSetupActivity.java",
        fs.readFileSync(
            path.join(
                root,
                "android/app/src/main/java/play/ott/foss/HomeSetupActivity.java"
            ),
            "utf8"
        )
    );
    write(
        "play/ott/foss/HomeSetupTest.java",
        `package play.ott.foss;
    import android.app.AlertDialog;
    import android.content.pm.ResolveInfo;
    import android.widget.*;
    public class HomeSetupTest {
        static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
        static HomeSetupActivity fresh(){
            HomeSetupActivity a=new HomeSetupActivity();a.onCreate(null);a.onResume();
            check(a.pm.writes==0 && a.starts.isEmpty(),"Opening/resuming must be read-only"); return a;
        }
        static void click(HomeSetupActivity a,int id){
            for(android.view.View v:((LinearLayout)((ScrollView)a.content).child).children){
                if(v instanceof Button && ((Button)v).text==id){
                    check(v.filter,"Setup buttons must filter obscured touches");v.performClick();return;
                }
            }
            throw new AssertionError("Button missing");
        }
        static boolean shows(HomeSetupActivity a,int text){
            for(android.view.View v:((LinearLayout)((ScrollView)a.content).child).children)
                if(v instanceof TextView && ((TextView)v).text==text)return true;
            return false;
        }
        static void otherHome(HomeSetupActivity a){
            a.pm.selected=new ResolveInfo("vendor.home","vendor.home.Launcher");
            a.pm.candidates.clear();a.pm.candidates.add(a.pm.selected);a.roles.held=false;
        }
        static HomeSetupActivity enabled(){
            HomeSetupActivity a=fresh();click(a,R.string.home_setup_enable);
            check(a.pm.writes==0,"Enable needs confirmation");AlertDialog.last.yes();return a;
        }
        static void blockedDisable(HomeSetupActivity a){
            int writes=a.pm.writes;click(a,R.string.home_setup_disable);AlertDialog.last.yes();
            check(a.pm.writes==writes,"Unconfirmed alternate Home must not disable");
            check(a.starts.get(a.starts.size()-1).equals("home-settings"),"Must offer Home settings");
        }
        public static void main(String[] args){
            HomeSetupActivity a=fresh();click(a,R.string.home_setup_enable);AlertDialog.last.cancel();a.onResume();
            check(a.pm.writes==0 && a.starts.isEmpty(),"Cancel must not enable or request Home");
            a=enabled();check(a.pm.state==1 && a.pm.writes==1 && a.roles.requests==1,"Confirmed enable/request");
            a.onResume();check(a.pm.state==1 && a.pm.writes==1,"Cancelled role selection must not silently change alias");
            a.pm.selected=new ResolveInfo("play.ott.foss","play.ott.foss.HomeActivity");
            a.pm.selected.activityInfo.enabled=false; // Manifest default remains false.
            a.pm.candidates.add(a.pm.selected);a.roles.held=true;a.onResume();
            check(shows(a,R.string.home_setup_selected),"Runtime-enabled manifest-disabled alias is selected Home");
            a.roles.held=false;a.pm.selected=null;a.pm.candidates.clear();
            click(a,R.string.home_setup_disable);AlertDialog.last.cancel();
            check(a.pm.writes==1,"Cancel disable must not mutate");
            blockedDisable(a); // No default.
            a.pm.selected=new ResolveInfo("android","ResolverActivity");blockedDisable(a);
            a.pm.selected=new ResolveInfo("com.android.settings","com.android.settings.FallbackHome");
            a.pm.candidates.add(a.pm.selected);blockedDisable(a); // Boot placeholder is not a usable launcher.
            otherHome(a);a.pm.candidates.clear();blockedDisable(a); // Hidden/not a HOME candidate.
            otherHome(a);a.pm.selected.activityInfo.exported=false;blockedDisable(a);
            otherHome(a);a.pm.selected.activityInfo.enabled=false;a.pm.selected.runtimeEnabled=false;blockedDisable(a);
            otherHome(a);a.pm.selected.runtimeEnabled=false;blockedDisable(a); // Runtime-disabled manifest-enabled.
            otherHome(a);a.pm.selected.activityInfo.applicationInfo.enabled=false;blockedDisable(a);
            otherHome(a);a.roles.held=true;blockedDisable(a); // Role/resolver disagreement.
            otherHome(a);a.roles.fail=true;blockedDisable(a);a.roles.fail=false;
            otherHome(a);click(a,R.string.home_setup_disable);
            a.pm.selected=new ResolveInfo("play.ott.foss","play.ott.foss.HomeActivity");
            a.pm.candidates.clear();a.pm.candidates.add(a.pm.selected);AlertDialog.last.yes();
            check(a.pm.writes==1,"Home changed while confirmation open");
            otherHome(a);a.pm.selected.activityInfo.enabled=false; // Alternate launcher explicitly enabled.
            a.pm.selected.priority=-1000; // Low priority alone does not invalidate a real launcher.
            click(a,R.string.home_setup_disable);AlertDialog.last.yes();
            check(a.pm.state==2 && a.pm.writes==2,"Confirmed alternate Home permits disable");
            a=fresh();a.roles.available=false;click(a,R.string.home_setup_enable);AlertDialog.last.yes();
            check(a.starts.contains("home-settings") && a.roles.requests==0,"Unavailable role fallback");
            a=fresh();a.roles.fail=true;click(a,R.string.home_setup_enable);AlertDialog.last.yes();
            check(a.starts.contains("home-settings"),"Role service failure fallback");
            a=fresh();a.rejectRole=true;a.rejectHomeSettings=true;
            click(a,R.string.home_setup_enable);AlertDialog.last.yes();
            check(a.starts.size()==1 && a.starts.contains("settings"),"Missing role UI and Home settings fallback");
            a=fresh();a.roles.available=false;a.rejectHomeSettings=true;a.rejectSettings=true;
            int shown=Toast.shown;click(a,R.string.home_setup_enable);AlertDialog.last.yes();
            check(a.pm.state==1 && Toast.shown>shown,"Missing settings must report without disabling alias");
            a=fresh();a.pm.failWrite=true;click(a,R.string.home_setup_enable);AlertDialog.last.yes();
            check(a.pm.writes==0 && a.starts.isEmpty(),"Failed enable must not request Home");
            a=fresh();otherHome(a);a.roles.held=true;
            click(a,R.string.home_setup_enable);AlertDialog.last.cancel();
            check(a.pm.writes==0 && a.starts.isEmpty(),"Role mismatch still requires confirmation");
            click(a,R.string.home_setup_enable);AlertDialog.last.yes();
            check(a.roles.requests==0 && a.starts.size()==1 && a.starts.contains("home-settings"),
                "Held role with another selected Home must offer the system selector");
            check(a.pm.state==1 && a.pm.writes==1 &&
                a.pm.selected.activityInfo.packageName.equals("vendor.home"),
                "Recovery must not disable the alias or silently replace another Home");
            a=fresh();a.roles.held=true;click(a,R.string.home_setup_enable);AlertDialog.last.yes();
            check(a.roles.requests==0 && a.starts.contains("home-settings"),
                "Held role without a resolved Home must offer the system selector");
            a=fresh();a.roles.held=true;
            a.pm.selected=new ResolveInfo("com.android.settings","com.android.settings.FallbackHome");
            a.pm.candidates.add(a.pm.selected);click(a,R.string.home_setup_enable);AlertDialog.last.yes();
            check(a.roles.requests==0 && a.starts.contains("home-settings"),
                "Boot placeholder must not satisfy held-role recovery");
            a=fresh();a.roles.held=true;
            a.pm.selected=new ResolveInfo("play.ott.foss","play.ott.foss.HomeActivity");
            a.pm.selected.activityInfo.enabled=false;a.pm.candidates.add(a.pm.selected);
            click(a,R.string.home_setup_enable);AlertDialog.last.yes();
            check(a.roles.requests==0 && a.starts.isEmpty(),
                "Confirmed own Home does not need another chooser or role request");
            android.os.Build.VERSION.SDK_INT=24;a=enabled();
            check(a.roles.requests==0 && a.starts.contains("home-settings"),"API24 has no RoleManager request");
            android.os.Build.VERSION.SDK_INT=29;
            System.out.println("PASS Home setup consent, role fallback, resolver ambiguity and safe disable");
        }
    }`
    );
    cp.execFileSync(executable("javac"), ["-d", temp, ...sources], {
        stdio: "pipe",
    });
    process.stdout.write(
        cp.execFileSync(
            executable("java"),
            ["-cp", temp, "play.ott.foss.HomeSetupTest"],
            { encoding: "utf8" }
        )
    );
} finally {
    fs.rmSync(temp, { force: true, recursive: true });
}
