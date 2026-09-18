package com.drivesense.app;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;

final class DriveSenseTripOverviewBuilder {
    static final int MAX_POINTS = 2000;
    static final int DEFAULT_POINTS = 900;
    static final int MAX_PLAINTEXT_BYTES = 512 * 1024;

    private DriveSenseTripOverviewBuilder() {}

    static Result build(Context context, JSONObject trip, int targetPoints) throws Exception {
        JSONArray route = trip.optJSONArray("route_points");
        if (route == null) route = trip.optJSONArray("points");
        if (route == null || route.length() == 0) return new Result(new byte[0], 0);
        int target = Math.max(2, Math.min(MAX_POINTS, targetPoints));
        int stride = Math.max(1, (int)Math.ceil(route.length() / (double)target));
        JSONArray overview = new JSONArray();
        boolean wasMasked = false;
        for (int index=0; index<route.length(); index += stride) {
            JSONObject point = route.optJSONObject(index);
            if (!usable(point)) continue;
            double lat=point.optDouble("lat",Double.NaN), lng=point.optDouble("lng",Double.NaN);
            boolean masked = PrivacyZoneChecker.isInsidePrivacyZone(context, lat, lng);
            if (masked) { wasMasked=true; continue; }
            JSONObject reduced = new JSONObject();
            reduced.put("lat",lat); reduced.put("lng",lng);
            if (point.has("timestamp")) reduced.put("timestamp",point.opt("timestamp"));
            if (point.has("time")) reduced.put("time",point.opt("time"));
            if (wasMasked) { reduced.put("privacy_gap_before",true); wasMasked=false; }
            overview.put(reduced);
            if (overview.length() >= MAX_POINTS) break;
        }
        JSONObject envelope=new JSONObject();
        envelope.put("schemaVersion",1);
        envelope.put("tripId",trip.optString("id",""));
        envelope.put("points",overview);
        byte[] bytes=envelope.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if(bytes.length>MAX_PLAINTEXT_BYTES) throw new IllegalStateException("Overview exceeds frozen byte ceiling");
        return new Result(bytes,overview.length());
    }

    private static boolean usable(JSONObject point) {
        if(point==null||point.isNull("lat")||point.isNull("lng")) return false;
        double lat=point.optDouble("lat",Double.NaN),lng=point.optDouble("lng",Double.NaN);
        return Double.isFinite(lat)&&Double.isFinite(lng)&&lat>=-90&&lat<=90&&lng>=-180&&lng<=180;
    }
    static final class Result { final byte[] bytes; final int pointCount; Result(byte[] b,int c){bytes=b;pointCount=c;} }
}
