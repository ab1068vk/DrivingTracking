package com.drivesense.app;

import android.app.job.JobParameters;
import android.app.job.JobService;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;

public class RoadDataJobService extends JobService {
    static final String EXTRA_REQUEST_ID = "request_id";
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 35_000;
    private static final Map<String, Set<String>> CERTIFICATE_PINS = certificatePins();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @Override
    public boolean onStartJob(JobParameters params) {
        String requestId = params.getExtras().getString(EXTRA_REQUEST_ID, "");
        executor.execute(() -> {
            try {
                JSONObject request = RoadDataQueueStore.readRequest(this, requestId);
                RoadDataQueueStore.writeResult(this, requestId, executeRequest(request));
            } catch (Exception error) {
                try {
                    JSONObject result = new JSONObject();
                    result.put("status", "error");
                    result.put("error", error.getMessage() != null ? error.getMessage() : "Background road-data request failed");
                    RoadDataQueueStore.writeResult(this, requestId, result);
                } catch (Exception ignored) {
                    // The app will treat a missing result as pending and can reschedule it on launch.
                }
            } finally {
                jobFinished(params, false);
            }
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }

    @Override
    public void onDestroy() {
        // The system re-instantiates this JobService; without this each instance orphans its
        // worker thread for the lifetime of the process.
        executor.shutdownNow();
        super.onDestroy();
    }

    private JSONObject executeRequest(JSONObject request) throws Exception {
        URL url = new URL(request.getString("url"));
        if (!"https".equalsIgnoreCase(url.getProtocol())) {
            throw new SecurityException("Road-data background requests require HTTPS");
        }
        if (!CERTIFICATE_PINS.containsKey(url.getHost().toLowerCase())) {
            throw new SecurityException("No certificate pins configured for " + url.getHost());
        }

        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setUseCaches(false);
        connection.setRequestMethod(request.optString("method", "GET"));
        JSONObject headers = request.optJSONObject("headers");
        if (headers != null) {
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                connection.setRequestProperty(key, headers.optString(key));
            }
        }
        String body = request.optString("body", null);
        if (body != null && !body.isEmpty()) {
            connection.setDoOutput(true);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }

        int statusCode = connection.getResponseCode();
        assertPinnedCertificate(connection, url.getHost());
        InputStream stream = statusCode >= 200 && statusCode < 400
            ? connection.getInputStream()
            : connection.getErrorStream();
        String responseBody = stream != null ? readText(stream) : "";
        connection.disconnect();

        JSONObject result = new JSONObject();
        result.put("status", statusCode >= 200 && statusCode < 300 ? "success" : "error");
        result.put("statusCode", statusCode);
        result.put("body", responseBody);
        if (statusCode < 200 || statusCode >= 300) {
            result.put("error", "Road-data provider returned HTTP " + statusCode);
        }
        return result;
    }

    private static void assertPinnedCertificate(HttpsURLConnection connection, String host) throws Exception {
        Set<String> expected = CERTIFICATE_PINS.get(host.toLowerCase());
        for (Certificate certificate : connection.getServerCertificates()) {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getPublicKey().getEncoded());
            String pin = "sha256/" + android.util.Base64.encodeToString(digest, android.util.Base64.NO_WRAP);
            if (expected.contains(pin)) return;
        }
        throw new SecurityException("Certificate pin verification failed for " + host);
    }

    private static String readText(InputStream stream) throws Exception {
        StringBuilder value = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) value.append(line).append('\n');
        }
        return value.toString();
    }

    private static Map<String, Set<String>> certificatePins() {
        Map<String, Set<String>> pins = new HashMap<>();
        pins.put("api.open-meteo.com", setOf(
            "sha256/YAFPPxCwfYpnCvumZr5iRwQxdLb9dak90Qvb33ma0Fo=",
            "sha256/kZwN96eHtZftBWrOZUsd6cA4es80n3NzSk/XtYz2EqQ="));
        pins.put("archive-api.open-meteo.com", setOf(
            "sha256/Bhlw8LnAlZsTwkhXA0Qn5Kk7WmvoeEhHuk+juIQZaVQ=",
            "sha256/brzvtCELCIZUo4sD/qPX0ccRtPsd3DY6RfmxpOU9oB4="));
        pins.put("overpass-api.de", setOf(
            "sha256/uAD+342sjrC9Pc6amj8vUGZtGKiuGOTK5FVAKN9AzMg=",
            "sha256/iFvwVyJSxnQdyaUvUERIf+8qk7gRze3612JMwoO3zdU="));
        pins.put("overpass.kumi.systems", setOf(
            "sha256/Psda1h1uTCa01j78YJ7feYiyTyUstFDOhS9D8fDqfT0=",
            "sha256/LoMHBotttiDko50Gi13uXW71eIy7LAttI+rYT8wXF4w="));
        return pins;
    }

    private static Set<String> setOf(String... values) {
        return new HashSet<>(Arrays.asList(values));
    }
}
