package com.drivesense.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int APP_SURFACE_COLOR = Color.rgb(15, 17, 23);

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DriveSenseActivityRecognitionPlugin.class);
        registerPlugin(ScreenSecurityPlugin.class);
        registerPlugin(BiometricAuthPlugin.class);
        registerPlugin(RaspPlugin.class);
        registerPlugin(SecureBridgePlugin.class);
        registerPlugin(RoadDataQueuePlugin.class);
        registerPlugin(AuditAnchorPlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        getWindow().getDecorView().setBackgroundColor(APP_SURFACE_COLOR);
        getWindow().setNavigationBarColor(APP_SURFACE_COLOR);
        getWindow().setStatusBarColor(APP_SURFACE_COLOR);
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setBackgroundColor(APP_SURFACE_COLOR);
        }
    }
}
