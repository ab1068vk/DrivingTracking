package com.drivesense.app;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
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
    }
}
