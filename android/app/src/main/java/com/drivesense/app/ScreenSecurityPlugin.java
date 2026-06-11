package com.drivesense.app;

import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ScreenSecurity")
public class ScreenSecurityPlugin extends Plugin {
    @PluginMethod
    public void setSecure(PluginCall call) {
        boolean secure = Boolean.TRUE.equals(call.getBoolean("secure", true));

        getActivity().runOnUiThread(() -> {
            try {
                if (secure) {
                    getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                } else {
                    getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                }

                JSObject result = new JSObject();
                result.put("secure", secure);
                call.resolve(result);
            } catch (RuntimeException error) {
                call.reject("Could not update screen capture protection.", error);
            }
        });
    }
}
