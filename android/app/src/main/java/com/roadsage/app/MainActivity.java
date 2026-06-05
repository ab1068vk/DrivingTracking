package com.roadsage.app;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.util.HashMap;
import java.util.Map;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );
        registerPlugin(DriveSenseActivityRecognitionPlugin.class);
        PrivacyZoneStore.migratePlaintextPrefsIfNeeded(this);
        DriveSenseNativeTripStore.migratePlaintextPrefsIfNeeded(this);
        super.onCreate(savedInstanceState);
        installSecurityHeaderWebViewClient();
    }

    private void installSecurityHeaderWebViewClient() {
        if (getBridge() == null) return;

        getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse response = super.shouldInterceptRequest(view, request);
                if (response != null) {
                    response.setResponseHeaders(securityHeaders(response.getResponseHeaders()));
                }
                return response;
            }
        });
    }

    private Map<String, String> securityHeaders(Map<String, String> existingHeaders) {
        Map<String, String> headers = existingHeaders == null
            ? new HashMap<>()
            : new HashMap<>(existingHeaders);

        headers.put("Content-Security-Policy", buildCsp());
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("X-Frame-Options", "DENY");
        headers.put("Referrer-Policy", "no-referrer");
        return headers;
    }

    private String buildCsp() {
        return "default-src 'self'; " +
            "script-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob: " +
                "https://*.tile.openstreetmap.org " +
                "https://*.tile.openstreetmap.fr " +
                "https://staticmap.openstreetmap.de; " +
            "font-src 'self' data:; " +
            "connect-src 'self' " +
                "https://nominatim.openstreetmap.org " +
                "https://overpass-api.de " +
                "https://overpass.kumi.systems " +
                "https://overpass.openstreetmap.ru " +
                "https://api.open-meteo.com " +
                "https://archive-api.open-meteo.com " +
                "https://staticmap.openstreetmap.de; " +
            "object-src 'none'; " +
            "frame-ancestors 'none'; " +
            "base-uri 'self'; " +
            "form-action 'self'; " +
            "report-uri /csp-report";
    }
}
