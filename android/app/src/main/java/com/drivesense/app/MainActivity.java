package com.drivesense.app;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.appcompat.app.AppCompatDelegate;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int APP_SURFACE_COLOR = Color.rgb(15, 17, 23);

    @Override
    public void onCreate(Bundle savedInstanceState) {
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM);
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
        useLightSystemBarIcons();
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setBackgroundColor(APP_SURFACE_COLOR);
            WebSettings settings = webView.getSettings();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                settings.setAlgorithmicDarkeningAllowed(false);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                settings.setForceDark(WebSettings.FORCE_DARK_OFF);
            }
        }
    }

    private void useLightSystemBarIcons() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(
                        0,
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                );
            }
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            int flags = getWindow().getDecorView().getSystemUiVisibility();
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
    }
}
