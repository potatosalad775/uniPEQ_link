package kr.potatosalad775.unipeq;

import android.app.Activity;
import android.app.Application;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import java.lang.ref.WeakReference;

/**
 * Phase 0 freeze experiment, debug builds only. Chromium freezes a hidden page 60 s after uniPEQ
 * goes to the background, foreground service or not. While keepVisible is on, this tells
 * the WebView its window is still visible after the activity stops, so the page never counts as
 * hidden. Public API only (View.dispatchWindowVisibilityChanged).
 *
 * A ContentProvider because providers are created at process start, before any activity, which is
 * the only way an overlay can see the activity that owns the WebView without touching MainActivity.
 */
public class LinkProbeVisibility extends ContentProvider implements Application.ActivityLifecycleCallbacks {

    private static final String TAG = "LinkProbe";
    /** The framework re-dispatches GONE on later relayouts; re-asserting is cheap. */
    private static final long REASSERT_MS = 5000;
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static WeakReference<Activity> current = new WeakReference<>(null);
    private static boolean keepVisible = false;

    private static final Runnable reassert = new Runnable() {
        @Override
        public void run() {
            apply();
            if (keepVisible) main.postDelayed(this, REASSERT_MS);
        }
    };

    /** Called by LinkProbeService on start (from its extra) and on destroy. */
    static void setKeepVisible(boolean on) {
        main.post(() -> {
            keepVisible = on;
            main.removeCallbacks(reassert);
            if (on) reassert.run();
            else restore();
            Log.i(TAG, "keepVisible " + on);
        });
    }

    private static void apply() {
        WebView webView = findWebView();
        if (webView == null) {
            Log.w(TAG, "keepVisible: no WebView found");
            return;
        }
        webView.dispatchWindowVisibilityChanged(View.VISIBLE);
    }

    /** Hands the WebView the window's real visibility again. */
    private static void restore() {
        Activity activity = current.get();
        WebView webView = findWebView();
        if (activity == null || webView == null) return;
        webView.dispatchWindowVisibilityChanged(activity.getWindow().getDecorView().getWindowVisibility());
    }

    private static WebView findWebView() {
        Activity activity = current.get();
        return activity == null ? null : find(activity.getWindow().getDecorView());
    }

    private static WebView find(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                WebView found = find(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    @Override
    public boolean onCreate() {
        ((Application) getContext().getApplicationContext()).registerActivityLifecycleCallbacks(this);
        return true;
    }

    @Override
    public void onActivityCreated(Activity activity, Bundle savedInstanceState) {
        current = new WeakReference<>(activity);
    }

    @Override
    public void onActivityStarted(Activity activity) {
        current = new WeakReference<>(activity);
    }

    @Override
    public void onActivityResumed(Activity activity) {
        current = new WeakReference<>(activity);
    }

    @Override
    public void onActivityStopped(Activity activity) {
        // The window goes GONE in the traversal after onStop; undo it right after.
        if (keepVisible) main.postDelayed(LinkProbeVisibility::apply, 300);
    }

    @Override
    public void onActivityPaused(Activity activity) {}

    @Override
    public void onActivitySaveInstanceState(Activity activity, Bundle outState) {}

    @Override
    public void onActivityDestroyed(Activity activity) {}

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) {
        return null;
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return 0;
    }
}
