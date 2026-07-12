package com.drivesense.app;

import android.view.Window;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ScreenAwake")
public class ScreenAwakePlugin extends Plugin {
    @PluginMethod
    public void setKeepScreenOn(PluginCall call) {
        boolean keepScreenOn = Boolean.TRUE.equals(call.getBoolean("keepScreenOn", false));

        getActivity().runOnUiThread(() -> {
            try {
                Window window = getActivity().getWindow();
                if (keepScreenOn) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }

                JSObject result = new JSObject();
                result.put("keepScreenOn", keepScreenOn);
                call.resolve(result);
            } catch (RuntimeException error) {
                call.reject("Could not update the screen-awake state.", error);
            }
        });
    }
}
