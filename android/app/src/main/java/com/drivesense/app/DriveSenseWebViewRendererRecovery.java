package com.drivesense.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;

/** Owns the bounded UI-only recovery transition after the WebView renderer is lost. */
final class DriveSenseWebViewRendererRecovery {
    private static final String TAG = "RoadSageRenderer";

    private DriveSenseWebViewRendererRecovery() {}

    static boolean handle(View rendererView, Runnable destroyRenderer, Runnable recreateActivity) {
        if (rendererView == null || destroyRenderer == null || recreateActivity == null) return false;
        dispose(rendererView, destroyRenderer);
        new Handler(Looper.getMainLooper()).post(recreateActivity);
        return true;
    }

    static void dispose(View rendererView, Runnable destroyRenderer) {
        if (rendererView == null || destroyRenderer == null) return;
        ViewParent parent = rendererView.getParent();
        if (parent instanceof ViewGroup) {
            ((ViewGroup) parent).removeView(rendererView);
        }
        try {
            destroyRenderer.run();
        } catch (RuntimeException destroyFailure) {
            // The renderer is already gone. Returning handled is still required to keep native state alive.
            Log.w(TAG, "Dead WebView cleanup reported an error", destroyFailure);
        }
    }
}
