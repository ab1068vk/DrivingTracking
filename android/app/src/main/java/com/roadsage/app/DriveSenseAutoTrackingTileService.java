package com.roadsage.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

import androidx.core.content.ContextCompat;

import java.util.HashMap;
import java.util.Map;

import org.json.JSONObject;

public class DriveSenseAutoTrackingTileService extends TileService {
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
            openAppForBackgroundAutoSetup();
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
        String raw = NativeSettingsStore.getSettingsJson(this);
        if (raw == null || raw.trim().isEmpty()) return new JSONObject();
        try {
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    private void setBackgroundAutoEnabled() {
        Map<String, Object> updates = new HashMap<>();
        updates.put("tracking_mode", "background_auto");
        updates.put("auto_tracking_enabled", true);
        updates.put("background_tracking_enabled", true);
        updates.put("tracking_paused", false);
        NativeSettingsStore.updateSettingsFields(this, updates);
    }

    private void setBackgroundAutoPaused() {
        Map<String, Object> updates = new HashMap<>();
        updates.put("tracking_mode", "background_auto");
        updates.put("auto_tracking_enabled", true);
        updates.put("background_tracking_enabled", true);
        updates.put("tracking_paused", true);
        NativeSettingsStore.updateSettingsFields(this, updates);
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

    private void openAppForBackgroundAutoSetup() {
        Uri setupUri = Uri.parse("roadsage://app/settings?action=request_background_auto&tab=tracking");
        Intent intent = new Intent(Intent.ACTION_VIEW, setupUri, this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("tile_action", "request_background_auto");
        intent.putExtra("deeplink", setupUri.toString());
        startActivityAndCollapse(intent);
    }
}
