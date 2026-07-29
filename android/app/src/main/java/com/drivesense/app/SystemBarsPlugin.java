package com.drivesense.app;

import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SystemBars")
public class SystemBarsPlugin extends Plugin {
    private static final int LIGHT_SURFACE = Color.WHITE;
    private static final int DARK_SURFACE = Color.rgb(15, 17, 23);

    @PluginMethod
    public void setStyle(PluginCall call) {
        String resolvedTheme = call.getString("resolvedTheme", "light");

        getActivity().runOnUiThread(() -> {
            try {
                int surfaceColor = getSurfaceColor(resolvedTheme);
                boolean darkIcons = "light".equals(resolvedTheme);
                Window window = getActivity().getWindow();

                window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                window.clearFlags(
                        WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
                                | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION
                );
                window.getDecorView().setBackgroundColor(surfaceColor);
                window.setStatusBarColor(surfaceColor);
                window.setNavigationBarColor(surfaceColor);
                setDarkSystemBarIcons(window, darkIcons);

                JSObject result = new JSObject();
                result.put("resolvedTheme", resolvedTheme);
                result.put("darkIcons", darkIcons);
                call.resolve(result);
            } catch (RuntimeException error) {
                call.reject("Could not update system bars.", error);
            }
        });
    }

    private int getSurfaceColor(String resolvedTheme) {
        if ("dark".equals(resolvedTheme)) return DARK_SURFACE;
        return LIGHT_SURFACE;
    }

    private void setDarkSystemBarIcons(Window window, boolean darkIcons) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(darkIcons ? mask : 0, mask);
            }
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            int flags = window.getDecorView().getSystemUiVisibility();
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
            window.getDecorView().setSystemUiVisibility(flags);
        }
    }
}
