package com.drivesense.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Rasp")
public class RaspPlugin extends Plugin {
    @PluginMethod
    public void check(PluginCall call) {
        try {
            RaspResult raspResult = RaspChecker.check(getContext());
            JSObject result = new JSObject();
            JSArray threats = new JSArray();

            for (String threat : raspResult.threats) {
                threats.put(threat);
            }

            result.put("secure", raspResult.secure);
            result.put("threats", threats);
            call.resolve(result);
        } catch (RuntimeException error) {
            call.reject("Could not check device integrity.", error);
        }
    }
}
