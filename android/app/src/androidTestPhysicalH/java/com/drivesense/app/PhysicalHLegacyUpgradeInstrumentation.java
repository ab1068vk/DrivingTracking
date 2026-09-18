package com.drivesense.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.content.Context;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Guarded instrumentation-only legacy source seeder; the legacy app driver remains unavailable. */
@RunWith(AndroidJUnit4.class)
public final class PhysicalHLegacyUpgradeInstrumentation {
    @Test public void seedLegacyUpgradeFixtures() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        requireQualifiedLegacyTarget(context);

        String tripId = "physical-h-legacy-upgrade-trip";
        JSONObject trip = new JSONObject().put("id", tripId)
            .put("start_time", 1_825_000_000_000L).put("end_time", 1_825_000_060_000L)
            .put("status", "completed").put("distance_km", 1.25d).put("duration_seconds", 60)
            .put("route_points", new org.json.JSONArray()
                .put(new JSONObject().put("lat", 43.65d).put("lng", -79.38d).put("timestamp", 1_825_000_000_000L))
                .put(new JSONObject().put("lat", 43.651d).put("lng", -79.379d).put("timestamp", 1_825_000_001_000L)));
        JSONObject speed = new JSONObject().put("schemaVersion", 2).put("knowledgeRevision", 9)
            .put("knowledgeUpdatedAt", "2026-08-23T00:00:00Z")
            .put("cells", new JSONObject().put("dpz8aa", new JSONObject()
                .put("limitKmh", 50).put("samples", new org.json.JSONArray().put(48).put(50))))
            .put("corrections", new org.json.JSONArray()).put("excludedSections", new org.json.JSONArray())
            .put("roadMemory", new JSONObject()).put("history", new JSONObject()
                .put("undo", new org.json.JSONArray()).put("redo", new org.json.JSONArray()));
        String encrypted = DriveSensePayloadCrypto.encrypt(speed.toString(),
            "indexeddb:drivesense_speed_knowledge/knowledge:speed_knowledge_v1", 3);
        JSONObject wrapper = new JSONObject().put("encrypted", true).put("version", 1)
            .put("key_version", 3).put("algorithm", "AES-256-GCM")
            .put("key_provider", "android-keystore").put("ciphertext", encrypted);

        final boolean[] seeded = {false};
        final String[] lastResult = {"PHYSICAL_H_LEGACY_SEED_NOT_ATTEMPTED"};
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitAppOrigin(scenario);
            scenario.onActivity(activity -> {
                WebView webView = findWebView(activity.getWindow().getDecorView());
                if (webView == null) throw new AssertionError("Physical H legacy WebView unavailable");
                // WebView.evaluateJavascript does NOT await a promise: it JSON-serializes the
                // Promise object itself, which arrives as "{}". PH-10 saw exactly that, so the
                // resolved value has to be stashed on window and polled - the same shape
                // PhysicalHInstrumentation#deleteProjectionAndRecreate already uses.
                String script = "window.__physicalHLegacySeedResult='PHYSICAL_H_LEGACY_SEED_PENDING';"
                    + "(async()=>{try{"
                    + "const open=(n,v,u)=>new Promise((ok,no)=>{const r=indexedDB.open(n,v);r.onupgradeneeded=()=>u(r.result,r.transaction);r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});"
                    + "const done=t=>new Promise((ok,no)=>{t.oncomplete=ok;t.onerror=()=>no(t.error);t.onabort=()=>no(t.error);});"
                    + "const db=await open('drivesense_mobile',3,(d)=>{if(!d.objectStoreNames.contains('trips'))d.createObjectStore('trips',{keyPath:'id'});if(!d.objectStoreNames.contains('trip_projections'))d.createObjectStore('trip_projections',{keyPath:'id'});});"
                    + "const t=db.transaction(['trips','trip_projections'],'readwrite');const trip=" + JSONObject.quote(trip.toString()) + ";const value=JSON.parse(trip);t.objectStore('trips').put(value);t.objectStore('trip_projections').put({id:value.id,start_time:value.start_time,status:value.status,source_revision:'physical-h-legacy'});await done(t);db.close();"
                    + "const sd=await open('drivesense_speed_knowledge',1,(d)=>{if(!d.objectStoreNames.contains('knowledge'))d.createObjectStore('knowledge',{keyPath:'key'});});"
                    + "const st=sd.transaction('knowledge','readwrite');st.objectStore('knowledge').put({key:'speed_knowledge_v1',value:JSON.parse(" + JSONObject.quote(wrapper.toString()) + "),updatedAt:'2026-08-23T00:00:00Z'});await done(st);sd.close();"
                    + "return 'PHYSICAL_H_LEGACY_FIXTURES_SEEDED';}catch(e){return 'PHYSICAL_H_LEGACY_SEED_FAILED:'+String(e&&e.message||e);}})()"
                    + ".then(v=>window.__physicalHLegacySeedResult=v)"
                    + ".catch(e=>window.__physicalHLegacySeedResult='PHYSICAL_H_LEGACY_SEED_FAILED:'+String(e&&e.message||e));";
                webView.evaluateJavascript(script, ignored -> { });
            });
            long deadline = SystemClock.elapsedRealtime() + 60_000L;
            while (!seeded[0] && SystemClock.elapsedRealtime() < deadline) {
                scenario.onActivity(activity -> {
                    WebView webView = findWebView(activity.getWindow().getDecorView());
                    if (webView == null) return;
                    webView.evaluateJavascript(
                        "window.__physicalHLegacySeedResult || 'PHYSICAL_H_LEGACY_SEED_PENDING'",
                        value -> {
                            lastResult[0] = value == null ? "PHYSICAL_H_LEGACY_SEED_NULL_RESULT" : value;
                            seeded[0] = value != null && value.contains("PHYSICAL_H_LEGACY_FIXTURES_SEEDED");
                        });
                });
                SystemClock.sleep(200L);
            }
        }
        assertTrue("Legacy upgrade fixtures were not seeded: " + lastResult[0], seeded[0]);
        Bundle receipt = new Bundle();
        receipt.putString("physicalHReceipt", new JSONObject().put("caseId", "seedLegacyUpgradeFixtures")
            .put("status", "PASS").put("guarded", true).put("mutatesState", true)
            .put("tripCount", 1).put("speedPredecessorCount", 1).toString());
        instrumentation.sendStatus(1, receipt);
    }

    /**
     * The Activity's WebView is not on the app origin the instant it is created, and IndexedDB on
     * an opaque origin throws, so a one-shot evaluate right after launch can fail for a reason
     * that has nothing to do with the fixture. PH-10 hit exactly that and the callback discarded
     * the reason, leaving only "fixtures were not seeded". Wait for the real origin first.
     */
    private static void awaitAppOrigin(ActivityScenario<MainActivity> scenario) {
        final boolean[] ready = {false};
        long deadline = SystemClock.elapsedRealtime() + 60_000L;
        while (!ready[0] && SystemClock.elapsedRealtime() < deadline) {
            scenario.onActivity(activity -> {
                WebView webView = findWebView(activity.getWindow().getDecorView());
                if (webView == null) return;
                webView.evaluateJavascript(
                    "(location.origin==='https://localhost'&&typeof indexedDB!=='undefined')?'PH_ORIGIN_READY':'PH_ORIGIN_WAIT'",
                    value -> { if (value != null && value.contains("PH_ORIGIN_READY")) ready[0] = true; });
            });
            SystemClock.sleep(250L);
        }
        assertTrue("Physical H legacy WebView never reached the app origin", ready[0]);
    }

    /**
     * The Physical H BuildConfig flags are AGP-generated {@code public static final} fields, i.e.
     * Java compile-time constants, so referencing them here would inline THIS source set's flavor
     * (androidTestPhysicalH -> physicalH -> PHYSICAL_H_LEGACY_BUILD false) into the class file and
     * the guard could never pass whichever app APK was installed. PH-10 hit exactly that: the
     * legacy APK was installed correctly and the case still refused with
     * PHYSICAL_H_LEGACY_TARGET_REFUSED, and the test APK's dex held no reference to
     * com.drivesense.app.BuildConfig at all. One instrumentation APK deliberately serves both
     * flavors, so the flags have to be read off the app actually under test.
     *
     * Reading them through the target classloader also makes the guard strictly stronger: it can
     * no longer be satisfied by the test APK's own constants, and the installed package's
     * versionName must independently agree that this is the legacy build.
     */
    private static void requireQualifiedLegacyTarget(Context context) throws Exception {
        if (!"com.drivesense.app.p35h".equals(context.getPackageName())) {
            throw new SecurityException("PHYSICAL_H_LEGACY_TARGET_REFUSED");
        }
        Class<?> appBuildConfig = context.getClassLoader().loadClass("com.drivesense.app.BuildConfig");
        boolean physicalHBuild = appBuildConfig.getField("PHYSICAL_H_BUILD").getBoolean(null);
        boolean legacyBuild = appBuildConfig.getField("PHYSICAL_H_LEGACY_BUILD").getBoolean(null);
        String versionName = String.valueOf(context.getPackageManager()
            .getPackageInfo(context.getPackageName(), 0).versionName);
        if (!physicalHBuild || !legacyBuild || !versionName.endsWith("-physical-h-legacy")) {
            throw new SecurityException("PHYSICAL_H_LEGACY_TARGET_REFUSED");
        }
        String observed = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
        Object approvedValue = appBuildConfig.getField("PHYSICAL_H_APPROVED_ANDROID_IDS").get(null);
        String approved = approvedValue == null ? "" : String.valueOf(approvedValue).trim();
        if (observed == null || observed.trim().isEmpty() || approved.isEmpty()) {
            throw new SecurityException("PHYSICAL_H_LEGACY_IDENTITY_UNAVAILABLE");
        }
        String[] entries = approved.split("[,;\\r\\n]+");
        assertFalse("Legacy allowlist may not be empty", entries.length == 0);
        if (entries.length != 1 || !observed.trim().equals(entries[0].trim())) {
            throw new SecurityException("PHYSICAL_H_LEGACY_IDENTITY_REFUSED");
        }
    }

    private static WebView findWebView(android.view.View view) {
        if (view instanceof WebView) return (WebView) view;
        if (!(view instanceof android.view.ViewGroup)) return null;
        android.view.ViewGroup group = (android.view.ViewGroup) view;
        for (int index = 0; index < group.getChildCount(); index++) {
            WebView found = findWebView(group.getChildAt(index)); if (found != null) return found;
        }
        return null;
    }
}
