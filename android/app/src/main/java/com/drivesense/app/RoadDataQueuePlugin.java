package com.drivesense.app;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.os.PersistableBundle;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

@CapacitorPlugin(name = "RoadDataQueue")
public class RoadDataQueuePlugin extends Plugin {
    @PluginMethod
    public void enqueue(PluginCall call) {
        String requestId = call.getString("requestId", "");
        String url = call.getString("url", "");
        if (requestId.isEmpty() || url.isEmpty()) {
            call.reject("ROAD_DATA_REQUEST_ID_AND_URL_REQUIRED");
            return;
        }
        try {
            if (RoadDataQueueStore.readResult(getContext(), requestId) != null) {
                JSObject result = new JSObject();
                result.put("queued", false);
                result.put("status", "complete");
                call.resolve(result);
                return;
            }
        } catch (Exception ignored) {
            // No completed result exists yet.
        }

        try {
            JSONObject request = new JSONObject();
            request.put("url", url);
            request.put("method", call.getString("method", "GET"));
            request.put("headers", call.getObject("headers", new JSObject()));
            String body = call.getString("body");
            if (body != null) request.put("body", body);
            RoadDataQueueStore.writeRequest(getContext(), requestId, request);

            PersistableBundle extras = new PersistableBundle();
            extras.putString(RoadDataJobService.EXTRA_REQUEST_ID, requestId);
            int jobId = 0x40000000 | (RoadDataQueueStore.keyFor(requestId).hashCode() & 0x3fffffff);
            long delayMs = Math.max(0L, call.getLong("delayMs", 0L));
            JobInfo job = new JobInfo.Builder(jobId, new ComponentName(getContext(), RoadDataJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setMinimumLatency(delayMs)
                .setPersisted(true)
                .setExtras(extras)
                .build();
            JobScheduler scheduler = (JobScheduler) getContext().getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (scheduler.schedule(job) != JobScheduler.RESULT_SUCCESS) {
                call.reject("ROAD_DATA_BACKGROUND_JOB_NOT_SCHEDULED");
                return;
            }
            JSObject result = new JSObject();
            result.put("queued", true);
            result.put("status", "pending");
            call.resolve(result);
        } catch (Exception error) {
            call.reject("ROAD_DATA_BACKGROUND_JOB_FAILED", error);
        }
    }

    @PluginMethod
    public void getResult(PluginCall call) {
        String requestId = call.getString("requestId", "");
        try {
            JSONObject stored = RoadDataQueueStore.readResult(getContext(), requestId);
            JSObject result = stored == null ? new JSObject() : JSObject.fromJSONObject(stored);
            if (stored == null) result.put("status", "pending");
            call.resolve(result);
        } catch (Exception error) {
            call.reject("ROAD_DATA_RESULT_READ_FAILED", error);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String requestId = call.getString("requestId", "");
        try {
            RoadDataQueueStore.remove(getContext(), requestId);
            call.resolve();
        } catch (Exception error) {
            call.reject("ROAD_DATA_RESULT_REMOVE_FAILED", error);
        }
    }
}
