package com.roadsage.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.util.Arrays;
import java.util.HashSet;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "RoadSage";
    private static final String APP_SCHEME = "roadsage";
    private static final String LEGACY_APP_SCHEME = "drivesense";
    private static final String APP_HOST = "app";
    private static final String EXTRA_DEEPLINK = "deeplink";
    private static final Pattern SAFE_QUERY_VALUE = Pattern.compile("[a-zA-Z0-9_-]{1,50}");
    private static final Pattern SAFE_ID_VALUE = Pattern.compile("[a-zA-Z0-9_-]{1,80}");
    private static final Set<String> SAFE_QUERY_KEYS = new HashSet<>(Arrays.asList("action", "tab", "filter"));
    private static final Set<String> ALLOWED_DEEP_LINK_PATHS = new HashSet<>(Arrays.asList(
        "/",
        "/trips",
        "/map",
        "/settings",
        "/coach",
        "/insights",
        "/achievements",
        "/reports",
        "/vehicles"
    ));

    @Override
    public void onCreate(Bundle savedInstanceState) {
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );
        registerPlugin(DriveSenseActivityRecognitionPlugin.class);
        registerPlugin(ClipboardPlugin.class);
        registerPlugin(SecureKeyPlugin.class);
        registerPlugin(EncryptedCapacitorPlugin.class);
        registerPlugin(BiometricGatePlugin.class);
        registerPlugin(PlayIntegrityPlugin.class);
        PrivacyZoneStore.migratePlaintextPrefsIfNeeded(this);
        DriveSenseNativeTripStore.migratePlaintextPrefsIfNeeded(this);
        suspendTrackingOnCompromisedRuntime();
        sanitizeLaunchIntent(getIntent());
        super.onCreate(savedInstanceState);
        hardenWebView();
        disableWebViewAutofill();
        installSecurityHeaderWebViewClient();
    }

    private void suspendTrackingOnCompromisedRuntime() {
        String status = RuntimeIntegrityCheck.status(this);
        if ("ok".equals(status)) return;
        Log.w(TAG, "Runtime integrity warning: " + status);
        DriveSenseNativeTripStore.setServiceEnabled(this, false);
    }

    @Override
    public void onStop() {
        super.onStop();
        clearWebViewCache();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        if (!sanitizeIncomingIntent(intent, false)) {
            return;
        }
        super.onNewIntent(intent);
    }

    private void sanitizeLaunchIntent(Intent intent) {
        if (!sanitizeIncomingIntent(intent, true) && intent != null) {
            intent.setAction(Intent.ACTION_MAIN);
            intent.setData(null);
            intent.removeExtra(EXTRA_DEEPLINK);
        }
    }

    private boolean sanitizeIncomingIntent(Intent intent, boolean launchIntent) {
        if (intent == null) return true;

        if (Intent.ACTION_VIEW.equals(intent.getAction())) {
            Uri uri = intent.getData();
            Uri sanitized = sanitizeExternalDeepLink(uri);
            if (sanitized == null) {
                Log.w(TAG, "Rejected unsafe deep link intent.");
                return false;
            }
            intent.setData(sanitized);
        }

        if (intent.hasExtra(EXTRA_DEEPLINK)) {
            String sanitizedExtra = sanitizeAppDeepLinkExtra(intent.getStringExtra(EXTRA_DEEPLINK));
            if (sanitizedExtra == null) {
                Log.w(TAG, "Removed unsafe deeplink extra.");
                intent.removeExtra(EXTRA_DEEPLINK);
                return launchIntent;
            }
            intent.putExtra(EXTRA_DEEPLINK, sanitizedExtra);
        }

        return true;
    }

    private static Uri sanitizeExternalDeepLink(Uri uri) {
        if (uri == null || !APP_SCHEME.equals(uri.getScheme()) || !APP_HOST.equals(uri.getHost())) {
            return null;
        }

        String path = normalizedPath(uri);
        if (!ALLOWED_DEEP_LINK_PATHS.contains(path)) {
            Log.w(TAG, "Rejected deep link with unexpected path: " + path);
            return null;
        }

        return sanitizeUri(uri, APP_SCHEME, APP_HOST, path);
    }

    private static String sanitizeAppDeepLinkExtra(String raw) {
        if (raw == null || raw.trim().isEmpty()) return null;

        Uri uri;
        try {
            uri = Uri.parse(raw.trim());
        } catch (Exception ignored) {
            return null;
        }

        String scheme = uri.getScheme();
        if (!APP_SCHEME.equals(scheme) && !LEGACY_APP_SCHEME.equals(scheme)) return null;

        String path = normalizedAppPath(uri);
        if ("/dashboard".equals(path)) path = "/";
        if (!isAllowedAppPath(path)) {
            Log.w(TAG, "Rejected deeplink extra with unexpected path: " + path);
            return null;
        }

        return sanitizeUri(uri, APP_SCHEME, APP_HOST, path).toString();
    }

    private static Uri sanitizeUri(Uri uri, String scheme, String host, String path) {
        Uri.Builder builder = new Uri.Builder().scheme(scheme);
        if (host != null && !host.trim().isEmpty()) {
            builder.authority(host);
        }
        builder.encodedPath(path);

        for (String key : SAFE_QUERY_KEYS) {
            String val = uri.getQueryParameter(key);
            if (val != null && SAFE_QUERY_VALUE.matcher(val).matches()) {
                builder.appendQueryParameter(key, val);
            }
        }

        return builder.build();
    }

    private static String normalizedPath(Uri uri) {
        String path = uri.getPath();
        if (path == null || path.trim().isEmpty()) return "/";
        return path.replaceAll("/{2,}", "/");
    }

    private static String normalizedAppPath(Uri uri) {
        if (APP_SCHEME.equals(uri.getScheme()) && APP_HOST.equals(uri.getHost())) {
            return normalizedPath(uri);
        }

        String host = uri.getHost();
        String path = normalizedPath(uri);
        if (host == null || host.trim().isEmpty()) return path;
        if ("/".equals(path)) return "/" + host;
        return "/" + host + path;
    }

    private static boolean isAllowedAppPath(String path) {
        if (ALLOWED_DEEP_LINK_PATHS.contains(path)) return true;
        if (path.startsWith("/trips/")) return SAFE_ID_VALUE.matcher(path.substring("/trips/".length())).matches();
        if (path.startsWith("/survey/")) return SAFE_ID_VALUE.matcher(path.substring("/survey/".length())).matches();
        if ("/dashboard".equals(path)) return true;
        return false;
    }

    @SuppressWarnings("deprecation")
    private void hardenWebView() {
        if (getBridge() == null || getBridge().getWebView() == null) return;

        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setGeolocationEnabled(false);
        settings.setSaveFormData(false);
        settings.setSavePassword(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        }

        clearWebViewCache();
    }

    private void clearWebViewCache() {
        if (getBridge() == null || getBridge().getWebView() == null) return;

        WebView webView = getBridge().getWebView();
        webView.clearCache(true);
        webView.clearHistory();
        webView.clearFormData();
    }

    private void disableWebViewAutofill() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getBridge() == null || getBridge().getWebView() == null) {
            return;
        }
        getBridge().getWebView().setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
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
                "https://*.tile.openstreetmap.fr; " +
            "font-src 'self' data:; " +
            "connect-src 'self' " +
                "https://nominatim.openstreetmap.org " +
                "https://overpass-api.de " +
                "https://overpass.kumi.systems " +
                "https://api.open-meteo.com " +
                "https://archive-api.open-meteo.com; " +
            "object-src 'none'; " +
            "frame-ancestors 'none'; " +
            "base-uri 'self'; " +
            "form-action 'self'; " +
            "report-uri /csp-report";
    }
}
