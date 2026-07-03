package ai.procurecopilot.app;

import android.content.Intent;
import android.provider.Settings;
import android.text.TextUtils;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

/**
 * V2 bridge: lets the JS app query the native Hyperpure app for prices via {@link HyperpureReaderService}
 * (Accessibility). Methods: check/enable the service, and run a native search.
 */
@CapacitorPlugin(name = "HyperpureNative")
public class HyperpureNativePlugin extends Plugin {

    @PluginMethod
    public void isEnabled(PluginCall call) {
        JSObject ret = new JSObject();
        // Report whether the service is ACTUALLY connected (INSTANCE != null), not merely toggled on in
        // Settings. The setting can flip on a beat before the service binds; during that window a search
        // would throw `accessibility_disabled`. Gating on the live instance keeps detection honest so the
        // caller only takes the native path when it will really work (else it falls back to the WebView).
        boolean usable = HyperpureReaderService.INSTANCE != null && isServiceEnabled();
        ret.put("enabled", usable);
        call.resolve(ret);
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void search(PluginCall call) {
        String query = call.getString("query", "");
        if (query == null || query.trim().isEmpty()) {
            call.reject("query is required");
            return;
        }
        HyperpureReaderService svc = HyperpureReaderService.INSTANCE;
        if (svc == null) {
            call.reject("accessibility_disabled");
            return;
        }
        svc.search(query, (products, error) -> {
            if ((products == null || products.length() == 0)) {
                call.reject(error != null ? error : "no products read");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("products", products != null ? products : new JSONArray());
            if (error != null) ret.put("warning", error);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void addToCart(PluginCall call) {
        String query = call.getString("query", "");
        String title = call.getString("title", "");
        Integer qty = call.getInt("qty", 1);
        if (query == null || query.trim().isEmpty()) {
            call.reject("query is required");
            return;
        }
        HyperpureReaderService svc = HyperpureReaderService.INSTANCE;
        if (svc == null) {
            call.reject("accessibility_disabled");
            return;
        }
        svc.addToCart(query, title == null ? "" : title, qty == null ? 1 : qty, (result, error) -> {
            if (result == null || result.length() == 0) {
                call.reject(error != null ? error : "add-to-cart failed");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("added", result.optJSONObject(0).optInt("added", 0));
            ret.put("title", result.optJSONObject(0).optString("title", ""));
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void bringToFront(PluginCall call) {
        // After native sourcing the Hyperpure app is left in front; pull our own app back so the user
        // lands on the comparison instead of being stranded in Hyperpure.
        Intent i = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
        if (i != null) {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    @PluginMethod
    public void openCart(PluginCall call) {
        HyperpureReaderService svc = HyperpureReaderService.INSTANCE;
        if (svc == null) {
            call.reject("accessibility_disabled");
            return;
        }
        svc.openCart((result, error) -> {
            if (error != null) {
                call.reject(error);
                return;
            }
            call.resolve();
        });
    }

    private boolean isServiceEnabled() {
        String flat = Settings.Secure.getString(getContext().getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(flat)) return false;
        String pkg = getContext().getPackageName();
        return flat.contains(pkg + "/" + HyperpureReaderService.class.getName())
                || flat.contains(pkg + "/.HyperpureReaderService");
    }
}
