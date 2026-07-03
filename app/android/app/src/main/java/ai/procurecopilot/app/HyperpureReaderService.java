package ai.procurecopilot.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * V2 native-source reader: drives the installed Hyperpure app (com.wotu.app) via the Android
 * Accessibility API to search a query and read product titles + prices straight from the native UI —
 * no WebView, no vision model (the native app exposes prices as plain text). This is the only way one
 * app can read/act on another's screens; the user must enable it once in Settings ▸ Accessibility.
 */
public class HyperpureReaderService extends AccessibilityService {

    public static HyperpureReaderService INSTANCE;

    public interface Callback {
        void onResult(JSONArray products, String error);
    }

    private static final String HP_PKG = "com.wotu.app";
    // A "main" price like ₹628 (not a per-unit ₹314/kg).
    private static final Pattern MAIN_PRICE = Pattern.compile("^\\s*₹\\s?([0-9,]+(?:\\.[0-9]+)?)\\s*$");
    private static final Pattern PER_UNIT = Pattern.compile("₹\\s?[0-9,]+(?:\\.[0-9]+)?\\s*/\\s*(?:kg|g|l|ml|pc|piece)", Pattern.CASE_INSENSITIVE);

    @Override
    public void onServiceConnected() {
        INSTANCE = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Passive; work is driven imperatively from search().
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public boolean onUnbind(Intent intent) {
        if (INSTANCE == this) INSTANCE = null;
        return super.onUnbind(intent);
    }

    /** Launch Hyperpure, type {@code query} into its search, and read the resulting products. */
    public void search(final String query, final Callback cb) {
        new Thread(() -> {
            try {
                JSONArray products = loadResults(query);
                cb.onResult(products, products.length() == 0 ? "no products read from the Hyperpure screen" : null);
            } catch (Exception e) {
                cb.onResult(null, e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }).start();
    }

    /**
     * Search {@code query} in the Hyperpure app, then add the product best matching {@code wantedTitle}
     * to the cart {@code qty} times (best-effort +/− stepper). Leaves the grid on screen. Returns a
     * one-element array {added, title} so the JS side can confirm what landed in the cart.
     */
    public void addToCart(final String query, final String wantedTitle, final int qty, final Callback cb) {
        new Thread(() -> {
            try {
                loadResults(query); // drives the app + leaves the product grid on screen
                AccessibilityNodeInfo title = findBestTitleNode(wantedTitle, query);
                if (title == null) {
                    cb.onResult(null, "could not find \"" + wantedTitle + "\" on the Hyperpure screen");
                    return;
                }
                Rect tb = new Rect();
                title.getBoundsInScreen(tb);
                AccessibilityNodeInfo add = findClickableNear(tb, "ADD");
                if (add == null) {
                    cb.onResult(null, "no ADD button next to \"" + wantedTitle + "\"");
                    return;
                }
                add.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                sleep(1400);
                int added = 1;
                // Bulk products (sugar/atta/…) don't add on the first tap — they pop a "Select quantity"
                // pack-size sheet. Detect it, tap ITS Add button (the base pack), bump quantity via the
                // sheet's + stepper, then close the sheet so the flow can continue (otherwise it hangs
                // on the open modal — the bug the user hit on the 2nd item).
                AccessibilityNodeInfo sheet = find(getRootInActiveWindow(),
                        n -> textOf(n).toLowerCase().contains("select quantity"));
                if (sheet != null) {
                    AccessibilityNodeInfo sheetAdd = findLowestClickable("ADD");
                    if (sheetAdd == null) sheetAdd = findLowestClickable("Add");
                    if (sheetAdd != null) {
                        sheetAdd.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                        sleep(1200);
                    }
                    for (int i = 1; i < Math.max(1, qty); i++) {
                        AccessibilityNodeInfo plus = findLowestClickable("+");
                        if (plus == null) break;
                        plus.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                        sleep(700);
                        added++;
                    }
                    performGlobalAction(GLOBAL_ACTION_BACK); // dismiss the sheet, back to the results grid
                    sleep(900);
                } else {
                    // Direct-add product: bump quantity with the card's own + stepper.
                    for (int i = 1; i < Math.max(1, qty); i++) {
                        AccessibilityNodeInfo plus = findClickableNear(tb, "+");
                        if (plus == null) break;
                        plus.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                        sleep(700);
                        added++;
                    }
                }
                JSONArray res = new JSONArray();
                JSONObject o = new JSONObject();
                o.put("added", added);
                o.put("title", textOf(title));
                res.put(o);
                cb.onResult(res, null);
            } catch (Exception e) {
                cb.onResult(null, e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }).start();
    }

    /** Bring the Hyperpure cart to the foreground so the user can review + check out in the app. */
    public void openCart(final Callback cb) {
        new Thread(() -> {
            try {
                // After adding, the soft keyboard is the "active window", so getRootInActiveWindow() no
                // longer contains the toolbar. Search ALL windows for Hyperpure's cart button (`cart_mcv`)
                // — it sits in the toolbar above the suggestions dropdown, always on-screen — and tap it.
                // Match the TOOLBAR cart (`cart_mcv` / `cart_icon_hpiv`), NOT product "add_to_cart" buttons
                // — those also contain "cart" and would open a product's quantity sheet instead.
                // Bring Hyperpure to the foreground first — the user taps "Open Hyperpure to check out"
                // from OUR summary screen, so Hyperpure may be backgrounded (or cold) on any screen.
                Intent launch = getPackageManager().getLaunchIntentForPackage(HP_PKG);
                if (launch != null) {
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                    startActivity(launch);
                }
                // A cold start goes through the Splash screen — wait until Hyperpure's UI is actually the
                // active window (up to ~10s) before hunting for the cart, then let the toolbar settle.
                long bootEnd = System.currentTimeMillis() + 10000;
                while (System.currentTimeMillis() < bootEnd) {
                    AccessibilityNodeInfo r = getRootInActiveWindow();
                    if (r != null && r.getPackageName() != null
                            && r.getPackageName().toString().contains("wotu")) {
                        break;
                    }
                    sleep(400);
                }
                sleep(1500);
                // Hyperpure marks its toolbar cart (`cart_mcv`) not-important-for-accessibility; the
                // service runs with flagIncludeNotImportantViews (config XML) so it IS in our node tree.
                // Exclude the "cart"-named look-alikes (product `add_to_cart` buttons, the `cart_offers`
                // banner) by name + clickability + toolbar position.
                AccessibilityNodeInfo cart = waitFor(n -> {
                    String id = viewId(n).toLowerCase();
                    boolean idHit = (id.contains("cart") || id.contains("basket"))
                            && !id.contains("add") && !id.contains("offer") && n.isClickable();
                    if (!idHit) return false;
                    Rect rb = new Rect();
                    n.getBoundsInScreen(rb);
                    return rb.top >= 0 && rb.top < 500; // toolbar only
                }, 7000);
                if (cart != null) {
                    cart.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                } else {
                    // Fallback: tap the cart's usual top-right toolbar spot. On the home screen (where the
                    // launch intent lands) the cart icon centers around 13% of the window height.
                    AccessibilityNodeInfo root = getRootInActiveWindow();
                    if (root != null) {
                        Rect rb = new Rect();
                        root.getBoundsInScreen(rb);
                        tap(rb.left + (int) (rb.width() * 0.90f), rb.top + (int) (rb.height() * 0.13f));
                    }
                }
                sleep(2000);
                cb.onResult(new JSONArray(), null);
            } catch (Exception e) {
                cb.onResult(null, e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }).start();
    }

    /** Nav to Hyperpure search, type {@code query}, load the grid (tapping a suggestion if needed). */
    private JSONArray loadResults(final String query) {
        Intent launch = getPackageManager().getLaunchIntentForPackage(HP_PKG);
        if (launch == null) return new JSONArray();
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        startActivity(launch);
        sleep(2800);

        // Tap the search box on the home screen (a node whose text/desc mentions "Search").
        AccessibilityNodeInfo searchEntry = waitFor(n -> textOf(n).toLowerCase().contains("search"), 6000);
        AccessibilityNodeInfo clickable = nearestClickable(searchEntry);
        if (clickable != null) {
            clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            sleep(1500);
        }

        // Set the query into the EditText.
        AccessibilityNodeInfo edit = waitFor(n -> "android.widget.EditText".contentEquals(cs(n.getClassName())), 5000);
        if (edit == null) return new JSONArray();
        edit.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, query);
        edit.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        sleep(1800);

        // Prefer the live product grid; if only suggestions are showing, tap the top suggestion.
        JSONArray products = readProducts();
        if (products.length() == 0) {
            AccessibilityNodeInfo sugg = waitFor(n -> {
                String t = textOf(n).toLowerCase().trim();
                return t.length() > 2 && t.contains(query.toLowerCase().split(" ")[0]) && nearestClickable(n) != null;
            }, 3000);
            AccessibilityNodeInfo sc = nearestClickable(sugg);
            if (sc != null) {
                sc.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                sleep(3200);
            }
            products = readProducts();
        }
        return products;
    }

    /** Walk the current window and pair each product title with the main price that follows it. */
    private JSONArray readProducts() {
        JSONArray out = new JSONArray();
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return out;
        List<String> texts = new ArrayList<>();
        collectTexts(root, texts);

        String title = null;
        String perUnit = null;
        for (String raw : texts) {
            String t = raw.trim();
            if (t.isEmpty()) continue;
            Matcher m = MAIN_PRICE.matcher(t);
            if (PER_UNIT.matcher(t).find() && m.matches() == false) {
                perUnit = t;
                continue;
            }
            if (m.matches()) {
                if (title != null) {
                    try {
                        long paise = Math.round(Double.parseDouble(m.group(1).replace(",", "")) * 100);
                        JSONObject p = new JSONObject();
                        p.put("title", title);
                        p.put("pricePaise", paise);
                        if (perUnit != null) p.put("perUnit", perUnit);
                        out.put(p);
                    } catch (Exception ignore) {
                    }
                    title = null;
                    perUnit = null;
                }
                continue;
            }
            // Candidate product title: has letters, reasonably long, not chrome.
            if (t.length() >= 5 && t.matches(".*[A-Za-z].*")
                    && !t.equalsIgnoreCase("ADD") && !t.toLowerCase().contains("best rate")
                    && !t.toLowerCase().contains("add-on") && !t.toLowerCase().startsWith("shop by")) {
                title = t;
                perUnit = null;
            }
        }
        return out;
    }

    private void collectTexts(AccessibilityNodeInfo node, List<String> acc) {
        if (node == null) return;
        String t = textOf(node);
        if (!t.isEmpty() && node.getChildCount() == 0) acc.add(t);
        for (int i = 0; i < node.getChildCount(); i++) {
            collectTexts(node.getChild(i), acc);
        }
    }

    // --- node helpers --------------------------------------------------------

    private interface NodePred {
        boolean test(AccessibilityNodeInfo n);
    }

    private AccessibilityNodeInfo waitFor(NodePred pred, long timeoutMs) {
        long end = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < end) {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            AccessibilityNodeInfo found = find(root, pred);
            if (found != null) return found;
            sleep(300);
        }
        return null;
    }

    private AccessibilityNodeInfo find(AccessibilityNodeInfo node, NodePred pred) {
        if (node == null) return null;
        try {
            if (pred.test(node)) return node;
        } catch (Exception ignore) {
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo r = find(node.getChild(i), pred);
            if (r != null) return r;
        }
        return null;
    }

    /** The on-screen product title node whose words overlap {@code wanted} most (falls back to query). */
    private AccessibilityNodeInfo findBestTitleNode(String wanted, String query) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        List<AccessibilityNodeInfo> nodes = new ArrayList<>();
        collectNodes(root, nodes);
        Set<String> want = tokens(wanted);
        AccessibilityNodeInfo best = null;
        int bestScore = 0;
        for (AccessibilityNodeInfo n : nodes) {
            String t = textOf(n).trim();
            if (t.length() < 5 || !t.matches(".*[A-Za-z].*")) continue;
            if (t.equalsIgnoreCase("ADD") || MAIN_PRICE.matcher(t).matches()) continue;
            int score = overlap(want, tokens(t));
            if (score > bestScore) {
                bestScore = score;
                best = n;
            }
        }
        if (best != null) return best;
        // Fallback: first title-ish node that contains the query's leading word.
        String head = query.toLowerCase().split(" ")[0];
        for (AccessibilityNodeInfo n : nodes) {
            String t = textOf(n).trim();
            if (t.length() >= 5 && t.toLowerCase().contains(head) && !t.equalsIgnoreCase("ADD")
                    && !MAIN_PRICE.matcher(t).matches()) {
                return n;
            }
        }
        return null;
    }

    /** The clickable node with the given label whose bounds sit closest to {@code anchor} (same card). */
    private AccessibilityNodeInfo findClickableNear(Rect anchor, String label) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        List<AccessibilityNodeInfo> nodes = new ArrayList<>();
        collectNodes(root, nodes);
        AccessibilityNodeInfo best = null;
        double bestDist = Double.MAX_VALUE;
        int ax = anchor.centerX();
        int ay = anchor.centerY();
        for (AccessibilityNodeInfo n : nodes) {
            if (!label.equalsIgnoreCase(textOf(n).trim())) continue;
            AccessibilityNodeInfo click = nearestClickable(n);
            if (click == null) continue;
            Rect b = new Rect();
            n.getBoundsInScreen(b);
            double dx = b.centerX() - ax;
            double dy = b.centerY() - ay;
            double dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < bestDist) {
                bestDist = dist;
                best = click;
            }
        }
        return best;
    }

    /** The clickable node with the given label that sits LOWEST on screen — i.e. inside the bottom sheet. */
    private AccessibilityNodeInfo findLowestClickable(String label) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        List<AccessibilityNodeInfo> nodes = new ArrayList<>();
        collectNodes(root, nodes);
        AccessibilityNodeInfo best = null;
        int maxTop = -1;
        for (AccessibilityNodeInfo n : nodes) {
            if (!label.equalsIgnoreCase(textOf(n).trim())) continue;
            AccessibilityNodeInfo c = nearestClickable(n);
            if (c == null) continue;
            Rect b = new Rect();
            n.getBoundsInScreen(b);
            if (b.top > maxTop) {
                maxTop = b.top;
                best = c;
            }
        }
        return best;
    }

    private void collectNodes(AccessibilityNodeInfo node, List<AccessibilityNodeInfo> acc) {
        if (node == null) return;
        if (!textOf(node).isEmpty()) acc.add(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            collectNodes(node.getChild(i), acc);
        }
    }

    private static Set<String> tokens(String s) {
        Set<String> out = new HashSet<>();
        if (s == null) return out;
        for (String w : s.toLowerCase().split("[^a-z0-9]+")) {
            if (w.length() >= 3) out.add(w);
        }
        return out;
    }

    private static int overlap(Set<String> a, Set<String> b) {
        int n = 0;
        for (String w : a) if (b.contains(w)) n++;
        return n;
    }

    private AccessibilityNodeInfo nearestClickable(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo n = node;
        for (int i = 0; i < 6 && n != null; i++) {
            if (n.isClickable()) return n;
            n = n.getParent();
        }
        return node;
    }

    private static String textOf(AccessibilityNodeInfo n) {
        if (n == null) return "";
        CharSequence t = n.getText();
        if (t == null || t.length() == 0) t = n.getContentDescription();
        return t == null ? "" : t.toString();
    }

    /** Best-effort tap at absolute screen coordinates (for icons not exposed as clickable nodes). */
    private void tap(float x, float y) {
        try {
            Path p = new Path();
            p.moveTo(x, y);
            GestureDescription gd = new GestureDescription.Builder()
                    .addStroke(new GestureDescription.StrokeDescription(p, 0, 150))
                    .build();
            dispatchGesture(gd, null, null);
        } catch (Exception ignore) {
        }
    }

    private static String viewId(AccessibilityNodeInfo n) {
        if (n == null) return "";
        String id = n.getViewIdResourceName();
        return id == null ? "" : id;
    }

    private static CharSequence cs(CharSequence c) {
        return c == null ? "" : c;
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignore) {
        }
    }
}
