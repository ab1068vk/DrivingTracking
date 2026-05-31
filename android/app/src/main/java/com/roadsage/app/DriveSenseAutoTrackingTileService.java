package com.roadsage.app;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

public class DriveSenseAutoTrackingTileService extends TileService {
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String SETTINGS_KEY_OLD = "drivesense_settings";
    private static final String SETTINGS_KEY = "road_sage_settings";

    @Override
    public void onStartListening() {
        super.onStartListening();
        updateTile();
    }

    @Override
    public void onClick() {
        super.onClick();
        if (isBackgroundAutoActive()) {
            setBackgroundAutoPaused();
            RoadSageAutoTrackingService.stop(this);
            updateTile("Auto off", Tile.STATE_INACTIVE);
            return;
        }

        if (!hasNativeAutoTrackingPermissions()) {
            updateTile("Setup needed", Tile.STATE_INACTIVE);
            return;
        }

        setBackgroundAutoEnabled();
        RoadSageAutoTrackingService.start(this);
        updateTile("Auto on", Tile.STATE_ACTIVE);
    }

    private void updateTile() {
        boolean enabled = isBackgroundAutoActive();
        updateTile(enabled ? "Auto on" : "Auto off", enabled ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
    }

    private void updateTile(String label, int state) {
        Tile tile = getQsTile();
        if (tile == null) return;
        tile.setLabel(label);
        tile.setState(state);
        tile.updateTile();
    }

    private JSONObject getSettings() {
        SharedPreferences prefs = getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(SETTINGS_KEY, null);
        if (raw == null || raw.trim().isEmpty()) {
            raw = prefs.getString(SETTINGS_KEY_OLD, null);
            if (raw != null && !raw.trim().isEmpty()) {
                prefs.edit().putString(SETTINGS_KEY, raw).apply();
            }
        }
        if (raw == null || raw.trim().isEmpty()) return new JSONObject();
        try {
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    private void setBackgroundAutoEnabled() {
        JSONObject settings = getSettings();
        try {
            settings.put("tracking_mode", "background_auto");
            settings.put("auto_tracking_enabled", true);
            settings.put("background_tracking_enabled", true);
            settings.put("tracking_paused", false);
            getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(SETTINGS_KEY, settings.toString())
                .apply();
        } catch (Exception ignored) {}
    }

    private void setBackgroundAutoPaused() {
        JSONObject settings = getSettings();
        try {
            settings.put("tracking_mode", "background_auto");
            settings.put("auto_tracking_enabled", true);
            settings.put("background_tracking_enabled", true);
            settings.put("tracking_paused", true);
            getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(SETTINGS_KEY, settings.toString())
                .apply();
        } catch (Exception ignored) {}
    }

    private boolean isBackgroundAutoActive() {
        JSONObject settings = getSettings();
        boolean backgroundAuto = "background_auto".equals(settings.optString("tracking_mode", "manual"));
        boolean paused = settings.optBoolean("tracking_paused", false);
        return backgroundAuto && !paused && DriveSenseNativeTripStore.isServiceEnabled(this);
    }

    private boolean hasNativeAutoTrackingPermissions() {
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) return false;
        if (!hasPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            !hasPermission(Manifest.permission.ACTIVITY_RECOGNITION)) return false;
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            hasPermission(Manifest.permission.POST_NOTIFICATIONS);
    }

    private boolean hasPermission(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }
}
