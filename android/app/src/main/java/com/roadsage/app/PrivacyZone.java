package com.roadsage.app;

import org.json.JSONException;
import org.json.JSONObject;

public final class PrivacyZone {
    public final String name;
    public final double lat;
    public final double lng;
    public final float radiusMeters;

    public PrivacyZone(String name, double lat, double lng, float radiusMeters) {
        this.name = name;
        this.lat = lat;
        this.lng = lng;
        this.radiusMeters = Math.max(1f, radiusMeters);
    }

    /** True when point is within zone. Uses Location.distanceBetween with no network. */
    public boolean containsPoint(double lat, double lng) {
        float[] d = new float[1];
        android.location.Location.distanceBetween(this.lat, this.lng, lat, lng, d);
        return d[0] <= this.radiusMeters;
    }

    public static PrivacyZone fromJson(JSONObject o) throws JSONException {
        float r = (float) o.optDouble("radius", 200.0);
        return new PrivacyZone(
            o.optString("name", "Private zone"),
            o.getDouble("lat"),
            o.getDouble("lng"),
            r > 0 ? r : 200f
        );
    }

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("name", name);
        o.put("lat", lat);
        o.put("lng", lng);
        o.put("radius", radiusMeters);
        return o;
    }
}
