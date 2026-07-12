package com.drivesense.app;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.appcompat.app.AppCompatDelegate;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM);
        registerPlugin(DriveSenseActivityRecognitionPlugin.class);
        registerPlugin(ScreenSecurityPlugin.class);
        registerPlugin(ScreenAwakePlugin.class);
        registerPlugin(BiometricAuthPlugin.class);
        registerPlugin(SystemBarsPlugin.class);
        registerPlugin(RaspPlugin.class);
        registerPlugin(SecureBridgePlugin.class);
        registerPlugin(RoadDataQueuePlugin.class);
        registerPlugin(AuditAnchorPlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        applyInitialSystemBars();
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setBackgroundColor(getInitialSurfaceColor());
            WebSettings settings = webView.getSettings();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                settings.setAlgorithmicDarkeningAllowed(false);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                settings.setForceDark(WebSettings.FORCE_DARK_OFF);
            }
        }
    }

    private void applyInitialSystemBars() {
        Window window = getWindow();
        int surfaceColor = getInitialSurfaceColor();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.clearFlags(
                WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
                        | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION
        );
        window.getDecorView().setBackgroundColor(surfaceColor);
        window.setNavigationBarColor(surfaceColor);
        window.setStatusBarColor(surfaceColor);
        setDarkSystemBarIcons(getResources().getBoolean(R.bool.roadsage_light_system_bars));
    }

    private int getInitialSurfaceColor() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return getResources().getColor(R.color.roadsage_native_surface, getTheme());
        }
        return getResources().getColor(R.color.roadsage_native_surface);
    }

    private void setDarkSystemBarIcons(boolean darkIcons) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(
                        darkIcons ? mask : 0,
                        mask
                );
            }
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            int flags = getWindow().getDecorView().getSystemUiVisibility();
            if (darkIcons) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
            } else {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
            }
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
    }
}
