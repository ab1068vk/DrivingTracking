package com.drivesense.app.physicalh;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.webkit.WebViewRenderProcess;

import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.drivesense.app.MainActivity;
import com.drivesense.app.PhysicalHDriver;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.atomic.AtomicReference;

/** Physical-device case entry points. No case fabricates a physical PASS. */
@RunWith(AndroidJUnit4.class)
public final class PhysicalHInstrumentation {
    @Test public void readOnlyInstallationInventory() { run("readOnlyInstallationInventory"); }
    @Test public void enableTestAuthorityAndHealth() { run("enableTestAuthorityAndHealth"); }
    @Test public void measureBaselineZeroAndOne() { run("measureBaselineZeroAndOne"); }
    @Test public void seedPhysicalHFixtures() { run("seedPhysicalHFixtures"); }
    @Test public void activityAndRendererLifecycle() { runActivityAndRendererLifecycle(); }
    @Test public void killActiveProcessAfterNextSeal() { runExternallyOrchestrated("killActiveProcessAfterNextSeal"); }
    @Test public void doubleProcessDeathRecovery() { runExternallyOrchestrated("doubleProcessDeathRecovery"); }
    @Test public void ph4CanonicalFaultBoundary() { runExternallyOrchestrated("ph4CanonicalFaultBoundary"); }
    @Test public void remainingPhaseControl() { runRemainingPhaseControl(); }
    @Test public void recoverAndVerifyAfterReboot() { run("recoverAndVerifyAfterReboot"); }
    @Test public void streamSyntheticLongTrip() { run("streamSyntheticLongTrip"); }

    private static void run(String caseName) {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Bundle arguments = InstrumentationRegistry.getArguments();
        JSONObject receipt = PhysicalHDriver.execute(instrumentation.getTargetContext(), caseName, arguments);
        sendAndAssert(instrumentation, receipt);
    }

    private static void runActivityAndRendererLifecycle() {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Bundle arguments = new Bundle(InstrumentationRegistry.getArguments());
        if (booleanArgument(arguments, "receiptReplay", false)) {
            arguments.putString("phase", "RECEIPT_REPLAY");
            sendAndAssert(instrumentation, PhysicalHDriver.execute(
                instrumentation.getTargetContext(), "activityAndRendererLifecycle", arguments));
            return;
        }
        boolean resumePrepared = booleanArgument(arguments, "resumePrepared", false);
        if (!resumePrepared) {
            arguments.putString("phase", "PREPARE");
            JSONObject prepared = PhysicalHDriver.execute(
                instrumentation.getTargetContext(), "activityAndRendererLifecycle", arguments
            );
            sendAndAssert(instrumentation, prepared);
        } else {
            // A new instrumentation process does not inherit the in-memory test
            // authority override from the process that sealed the preserved case.
            // Re-establish it through the same guarded reviewed entry point before
            // the replacement WebView starts its native projection bootstrap.
            JSONObject authority = PhysicalHDriver.execute(
                instrumentation.getTargetContext(), "enableTestAuthorityAndHealth", arguments
            );
            sendAndAssert(instrumentation, authority);
        }

        final boolean[] rendererTerminated = {false};
        final boolean[] rendererActivityRecreated = {false};
        final boolean[] projectionRecovered = {false};
        final String[] lastProjectionProbe = {"PHYSICAL_H_PROJECTION_NOT_PROBED"};
        final int[] terminatedActivityIdentity = {0};
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.moveToState(Lifecycle.State.CREATED);
            scenario.moveToState(Lifecycle.State.RESUMED);
            scenario.recreate();
            scenario.onActivity(activity -> {
                terminatedActivityIdentity[0] = System.identityHashCode(activity);
                WebView webView = findWebView(activity.getWindow().getDecorView());
                assertNotNull("Physical H WebView missing before renderer termination", webView);
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    throw new AssertionError("WebViewRenderProcess termination requires API 29+");
                }
                WebViewRenderProcess process = webView.getWebViewRenderProcess();
                assertNotNull("WebView renderer process unavailable", process);
                rendererTerminated[0] = process.terminate();
                assertTrue("WebView renderer termination refused", rendererTerminated[0]);
            });
            // App bootstrap deliberately defers projection maintenance until a 12 s
            // quiet window.  Renderer recovery has to survive that real scheduling
            // boundary, but the probe must not create an empty version-1 database
            // while the replacement WebView is still loading.
            long deadline = SystemClock.elapsedRealtime() + 45_000L;
            while ((!rendererActivityRecreated[0] || !projectionRecovered[0])
                    && SystemClock.elapsedRealtime() < deadline) {
                try {
                    scenario.onActivity(activity -> {
                        rendererActivityRecreated[0] = terminatedActivityIdentity[0] != 0
                            && terminatedActivityIdentity[0] != System.identityHashCode(activity);
                        if (!rendererActivityRecreated[0]) return;
                        WebView webView = findWebView(activity.getWindow().getDecorView());
                        if (webView == null) return;
                        String script = "(()=>{if(document.readyState!=='complete')return 'PHYSICAL_H_PAGE_LOADING';"
                            + "if(typeof window.__physicalHProjectionProbe==='undefined'){"
                            + "window.__physicalHProjectionProbe='PHYSICAL_H_PROJECTION_PENDING';"
                            + "(async()=>{try{if(typeof indexedDB.databases!=='function')return 'PHYSICAL_H_DATABASE_ENUMERATION_UNAVAILABLE';"
                            + "const known=await indexedDB.databases();"
                            + "if(!known.some(x=>x&&x.name==='drivesense_mobile'))return 'PHYSICAL_H_PROJECTION_DATABASE_MISSING';"
                            + "const db=await new Promise((ok,no)=>{const r=indexedDB.open('drivesense_mobile');"
                            + "r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});"
                            + "const ready=db.objectStoreNames.contains('trip_projections');const version=db.version;"
                            + "const stores=Array.from(db.objectStoreNames).join(',');db.close();"
                            + "return ready?'PHYSICAL_H_PROJECTION_READY':"
                            + "('PHYSICAL_H_PROJECTION_STORE_MISSING_V'+version+'_STORES_'+stores);"
                            + "}catch(e){return 'PHYSICAL_H_PROJECTION_OPEN_FAILED';}})()"
                            + ".then(x=>{window.__physicalHProjectionProbe=x;},()=>{"
                            + "window.__physicalHProjectionProbe='PHYSICAL_H_PROJECTION_OPEN_FAILED';});}"
                            + "return window.__physicalHProjectionProbe;})()";
                        webView.evaluateJavascript(script, value -> {
                            lastProjectionProbe[0] = value == null ? "PHYSICAL_H_PROJECTION_NULL_RESULT" : value;
                            projectionRecovered[0] = value != null && value.contains("PHYSICAL_H_PROJECTION_READY");
                        });
                    });
                } catch (IllegalStateException transitionInProgress) {
                    // ActivityScenario is between the destroyed and recreated Activity instances.
                }
                SystemClock.sleep(100L);
            }
        }
        assertTrue("Activity was not recreated by the product renderer recovery handler", rendererActivityRecreated[0]);
        assertTrue("WebView projection did not recover after renderer termination: "
            + lastProjectionProbe[0], projectionRecovered[0]);
        Bundle completion = new Bundle(arguments);
        completion.putString("phase", "COMPLETE");
        completion.putBoolean("lifecycleBackgrounded", true);
        completion.putBoolean("activityRecreated", true);
        completion.putBoolean("rendererTerminated", rendererTerminated[0]);
        completion.putBoolean("projectionRecovered", projectionRecovered[0]);
        JSONObject completed = PhysicalHDriver.execute(
            instrumentation.getTargetContext(), "activityAndRendererLifecycle", completion
        );
        sendAndAssert(instrumentation, completed);
    }

    private static void runExternallyOrchestrated(String caseName) {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Bundle arguments = InstrumentationRegistry.getArguments();
        JSONObject authority = PhysicalHDriver.execute(
            instrumentation.getTargetContext(), "enableTestAuthorityAndHealth", arguments
        );
        sendAndAssert(instrumentation, authority);
        JSONObject receipt;
        try (ActivityScenario<MainActivity> ignored = ActivityScenario.launch(MainActivity.class)) {
            receipt = PhysicalHDriver.execute(instrumentation.getTargetContext(), caseName, arguments);
            sendAndAssert(instrumentation, receipt);
            if (booleanArgument(arguments, "selfTerminateAfterReceipt", false)
                && "ARMED_FOR_EXTERNAL_ACTION".equals(receipt.optString("status"))) {
                SystemClock.sleep(250L);
                android.os.Process.killProcess(android.os.Process.myPid());
                throw new AssertionError("PHYSICAL_H_SELF_PROCESS_DEATH_DID_NOT_TERMINATE");
            }
            if (booleanArgument(arguments, "awaitExternalDeath", false)
                && "ARMED_FOR_EXTERNAL_ACTION".equals(receipt.optString("status"))) {
                long deadline = SystemClock.elapsedRealtime() + 120_000L;
                while (SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(250L);
                throw new AssertionError("PHYSICAL_H_EXTERNAL_DEATH_NOT_OBSERVED_WITHIN_120_SECONDS");
            }
        }
    }

    private static void runRemainingPhaseControl() {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Bundle arguments = new Bundle(InstrumentationRegistry.getArguments());
        String scenario = arguments.getString("scenario", "");
        if ("PH10_UPGRADE_MIGRATE_PREPARE".equalsIgnoreCase(scenario)) {
            runCurrentUpgradeMigration(instrumentation, arguments);
            return;
        }
        if ("PH11_ERASURE_TRIPS".equalsIgnoreCase(scenario)
            && booleanArgument(arguments, "selfTerminateAfterReceipt", false)) {
            JSONObject armed = PhysicalHDriver.execute(
                instrumentation.getTargetContext(), "remainingPhaseControl", arguments);
            sendAndAssert(instrumentation, armed);
            assertTrue("PH-11 trip rollover did not reach the interruption boundary",
                "ARMED_FOR_EXTERNAL_ACTION".equals(armed.optString("status")));
            SystemClock.sleep(250L);
            android.os.Process.killProcess(android.os.Process.myPid());
            throw new AssertionError("PHYSICAL_H_SELF_PROCESS_DEATH_DID_NOT_TERMINATE");
        }
        if ("PH11_ERASURE_COMPLETE".equalsIgnoreCase(scenario)) {
            JSONObject completed = PhysicalHDriver.execute(
                instrumentation.getTargetContext(), "remainingPhaseControl", arguments);
            sendAndAssert(instrumentation, completed);
            assertTrue("PH-11 native erasure did not reach projection cleanup",
                "ARMED_FOR_EXTERNAL_ACTION".equals(completed.optString("status")));
            assertTrue("Physical H projection deletion did not complete", deleteProjectionAndRecreate());
            Bundle verify = new Bundle(arguments);
            verify.putString("scenario", "PH11_POST_ERASURE_VERIFY");
            verify.putBoolean("projectionDeleted", true);
            sendAndAssert(instrumentation, PhysicalHDriver.execute(
                instrumentation.getTargetContext(), "remainingPhaseControl", verify));
            return;
        }
        if ("PH5_PROJECTION_PREPARE".equalsIgnoreCase(scenario)) {
            JSONObject armed = PhysicalHDriver.execute(instrumentation.getTargetContext(), "remainingPhaseControl", arguments);
            sendAndAssert(instrumentation, armed);
            assertTrue("Physical H projection deletion did not complete", deleteProjectionAndRecreate());
            Bundle verify = new Bundle(arguments); verify.putString("scenario", "PH5_PROJECTION_VERIFY");
            sendAndAssert(instrumentation, PhysicalHDriver.execute(
                instrumentation.getTargetContext(), "remainingPhaseControl", verify));
            return;
        }
        run("remainingPhaseControl");
    }

    private static boolean deleteProjectionAndRecreate() {
        AtomicReference<String> deletionResult = new AtomicReference<>("PHYSICAL_H_IDB_DELETE_PENDING");
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            activity.onActivity(current -> {
                WebView webView = findWebView(current.getWindow().getDecorView());
                assertNotNull("Physical H WebView unavailable", webView);
                webView.loadDataWithBaseURL("https://localhost", "<html><body></body></html>",
                    "text/html", "UTF-8", null);
            });
            SystemClock.sleep(1_000L);
            android.webkit.WebStorage.getInstance().deleteAllData();
            SystemClock.sleep(2_000L);
            activity.onActivity(current -> {
                WebView webView = findWebView(current.getWindow().getDecorView());
                assertNotNull("Physical H WebView unavailable", webView);
                webView.evaluateJavascript(
                    "window.__physicalHIdbDeleteResult='PHYSICAL_H_IDB_DELETE_PENDING';"
                        + "(async()=>{try{const ds=await indexedDB.databases();"
                        + "if(!ds.some(d=>d&&d.name==='drivesense_mobile'))return 'PHYSICAL_H_IDB_DELETE_COMPLETE';"
                        + "return await new Promise((ok)=>{const r=indexedDB.deleteDatabase('drivesense_mobile');"
                        + "r.onsuccess=()=>ok('PHYSICAL_H_IDB_DELETE_COMPLETE');r.onerror=()=>ok('PHYSICAL_H_IDB_DELETE_FAILED');"
                        + "r.onblocked=()=>ok('PHYSICAL_H_IDB_DELETE_BLOCKED');});}"
                        + "catch(e){return 'PHYSICAL_H_IDB_DELETE_FAILED';}})()"
                        + ".then(v=>window.__physicalHIdbDeleteResult=v)"
                        + ".catch(()=>window.__physicalHIdbDeleteResult='PHYSICAL_H_IDB_DELETE_FAILED');",
                    ignored -> { }
                );
            });
            long deadline = SystemClock.elapsedRealtime() + 10_000L;
            while (SystemClock.elapsedRealtime() < deadline) {
                activity.onActivity(current -> {
                    WebView webView = findWebView(current.getWindow().getDecorView());
                    assertNotNull("Physical H WebView unavailable", webView);
                    webView.evaluateJavascript("window.__physicalHIdbDeleteResult || 'PHYSICAL_H_IDB_DELETE_PENDING'",
                        value -> deletionResult.set(value == null ? "" : value));
                });
                if (deletionResult.get().contains("PHYSICAL_H_IDB_DELETE_COMPLETE")) break;
                if (deletionResult.get().contains("PHYSICAL_H_IDB_DELETE_FAILED")
                    || deletionResult.get().contains("PHYSICAL_H_IDB_DELETE_BLOCKED")) break;
                SystemClock.sleep(100L);
            }
            if (deletionResult.get().contains("PHYSICAL_H_IDB_DELETE_COMPLETE")) activity.recreate();
        }
        return deletionResult.get().contains("PHYSICAL_H_IDB_DELETE_COMPLETE");
    }

    private static void runCurrentUpgradeMigration(Instrumentation instrumentation, Bundle arguments) {
        JSONObject armed = PhysicalHDriver.execute(
            instrumentation.getTargetContext(), "remainingPhaseControl", arguments);
        sendAndAssert(instrumentation, armed);

        final String[] bridgeResult = {null};
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            awaitAppOrigin(activity);
            activity.onActivity(current -> {
                WebView webView = findWebView(current.getWindow().getDecorView());
                assertNotNull("Physical H current WebView unavailable", webView);
                webView.evaluateJavascript(currentUpgradeMigrationScript(), ignored -> { });
            });
            // evaluateJavascript does not await a promise - it serializes the Promise object as
            // "{}" - so poll the resolved value the script parks on window instead.
            long deadline = SystemClock.elapsedRealtime() + 300_000L;
            while (SystemClock.elapsedRealtime() < deadline) {
                activity.onActivity(current -> {
                    WebView webView = findWebView(current.getWindow().getDecorView());
                    if (webView == null) return;
                    webView.evaluateJavascript(
                        "window.__physicalHUpgradeResult || 'PHYSICAL_H_UPGRADE_PENDING'",
                        value -> { if (value != null && !value.contains("PHYSICAL_H_UPGRADE_PENDING")) bridgeResult[0] = value; });
                });
                if (bridgeResult[0] != null) break;
                SystemClock.sleep(250L);
            }
        }
        assertNotNull("Physical H upgrade bridge timed out", bridgeResult[0]);
        assertTrue("Physical H upgrade bridge failed: " + bridgeResult[0],
            bridgeResult[0].contains("PHYSICAL_H_UPGRADE_MIGRATED"));

        Bundle verify = new Bundle(arguments);
        verify.putString("scenario", "PH10_UPGRADE_MIGRATE_VERIFY");
        sendAndAssert(instrumentation, PhysicalHDriver.execute(
            instrumentation.getTargetContext(), "remainingPhaseControl", verify));
    }

    /**
      * The Activity's WebView is not on the app origin the instant it is created, and the Capacitor
      * bridge is not registered until the page runs, so wait for the real origin before evaluating.
      */
    private static void awaitAppOrigin(ActivityScenario<MainActivity> scenario) {
        final boolean[] ready = {false};
        long deadline = SystemClock.elapsedRealtime() + 60_000L;
        while (!ready[0] && SystemClock.elapsedRealtime() < deadline) {
            scenario.onActivity(current -> {
                WebView webView = findWebView(current.getWindow().getDecorView());
                if (webView == null) return;
                webView.evaluateJavascript(
                    "(location.origin==='https://localhost'&&typeof indexedDB!=='undefined')?'PH_ORIGIN_READY':'PH_ORIGIN_WAIT'",
                    value -> { if (value != null && value.contains("PH_ORIGIN_READY")) ready[0] = true; });
            });
            SystemClock.sleep(250L);
        }
        assertTrue("Physical H WebView never reached the app origin", ready[0]);
    }

    private static String currentUpgradeMigrationScript() {
        return "window.__physicalHUpgradeResult='PHYSICAL_H_UPGRADE_PENDING';"
            + "(async()=>{try{"
            + "const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));"
            + "let plugin=null;for(let i=0;i<100;i++){plugin=globalThis.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins.DriveSenseArchive;if(plugin)break;await sleep(100);}"
            + "if(!plugin)throw new Error('ARCHIVE_PLUGIN_UNAVAILABLE');"
            + "const read=(dbName,store,key)=>new Promise((ok,no)=>{const r=indexedDB.open(dbName);r.onerror=()=>no(r.error);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains(store)){db.close();no(new Error('STORE_MISSING:'+store));return;}const t=db.transaction(store,'readonly');const q=t.objectStore(store).get(key);q.onsuccess=()=>{const v=q.result;db.close();ok(v);};q.onerror=()=>{db.close();no(q.error);};};});"
            + "const hex=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');"
            + "const b64=bytes=>{let s='';for(let o=0;o<bytes.length;o+=32768)s+=String.fromCharCode(...bytes.subarray(o,Math.min(bytes.length,o+32768)));return btoa(s);};"
            + "const trip=await read('drivesense_mobile','trips','physical-h-legacy-upgrade-trip');if(!trip)throw new Error('LEGACY_TRIP_MISSING');"
            + "const tripBytes=new TextEncoder().encode(JSON.stringify(trip));const sourceHash=await hex(tripBytes);"
            + "const begun=await plugin.beginMigrationTrip({tripId:String(trip.id),sourceHash,expectedBytes:tripBytes.length});"
            + "if(begun.alreadyMigrated!==true){for(let o=0,i=0;o<tripBytes.length;o+=262144,i++)await plugin.appendMigrationTripChunk({operationId:begun.operationId,chunkIndex:i,chunkBase64:b64(tripBytes.subarray(o,Math.min(tripBytes.length,o+262144)))});}"
            + "const committed=begun.alreadyMigrated===true?{payloadHash:sourceHash}:await plugin.finishMigrationTrip({operationId:begun.operationId});"
            + "const prior='0'.repeat(64);const manifest=await hex(new TextEncoder().encode(prior+'\\u0000'+String(trip.id)+'\\u0000'+String(committed.payloadHash)));"
            + "const complete=await plugin.completeMigration({expectedCount:1,visitedCount:1,quarantineCount:0,manifestHash:manifest});if(complete.verified!==true)throw new Error('TRIP_MIGRATION_NOT_VERIFIED');"
            + "const speedRecord=await read('drivesense_speed_knowledge','knowledge','speed_knowledge_v1');const wrapper=speedRecord&&speedRecord.value;"
            + "if(!wrapper||wrapper.encrypted!==true||typeof wrapper.ciphertext!=='string')throw new Error('ENCRYPTED_SPEED_PREDECESSOR_MISSING');"
            + "const raw=atob(wrapper.ciphertext);const cipher=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)cipher[i]=raw.charCodeAt(i);"
            + "const speedBegin=await plugin.beginLegacySpeedMigration({sourceId:'indexeddb',sourceContext:'indexeddb:drivesense_speed_knowledge/knowledge:speed_knowledge_v1',sourceCiphertextHash:await hex(cipher),sourceRevision:0,keyVersion:Number(wrapper.key_version)||0,expectedCiphertextBytes:cipher.length});"
            + "if(speedBegin.state==='LEGACY_SPEED_MIGRATION_BLOCKED_RESOURCE')throw new Error('SPEED_MIGRATION_RESOURCE_BLOCKED');"
            + "for(let o=0,i=Number(speedBegin.nextChunkIndex)||0;o<cipher.length;o+=262144,i++)await plugin.appendLegacySpeedCiphertext({operationId:speedBegin.operationId,chunkIndex:i,chunkBase64:b64(cipher.subarray(o,Math.min(cipher.length,o+262144)))});"
            + "const speed=await plugin.executeLegacySpeedMigration({operationId:speedBegin.operationId});if(speed.state!=='VERIFIED')throw new Error('SPEED_MIGRATION_NOT_VERIFIED:'+String(speed.state));"
            + "tripBytes.fill(0);cipher.fill(0);return 'PHYSICAL_H_UPGRADE_MIGRATED';"
            + "}catch(e){return 'PHYSICAL_H_UPGRADE_FAILED:'+String(e&&e.message||e);}})()"
            + ".then(v=>window.__physicalHUpgradeResult=v)"
            + ".catch(e=>window.__physicalHUpgradeResult='PHYSICAL_H_UPGRADE_FAILED:'+String(e&&e.message||e));";
    }

    private static WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (!(view instanceof ViewGroup)) return null;
        ViewGroup group = (ViewGroup) view;
        for (int index = 0; index < group.getChildCount(); index++) {
            WebView found = findWebView(group.getChildAt(index));
            if (found != null) return found;
        }
        return null;
    }

    private static boolean booleanArgument(Bundle arguments, String key, boolean fallback) {
        if (arguments == null || !arguments.containsKey(key)) return fallback;
        return Boolean.parseBoolean(String.valueOf(arguments.get(key)));
    }

    private static void sendAndAssert(Instrumentation instrumentation, JSONObject receipt) {
        Bundle status = new Bundle();
        status.putString("physicalHReceipt", receipt.toString());
        instrumentation.sendStatus(1, status);
        String state = receipt.optString("status", "NOT_READY");
        assertFalse(receipt.toString(), "SAFE_REFUSAL".equals(state) || "NOT_READY".equals(state));
    }
}
