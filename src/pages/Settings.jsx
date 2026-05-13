import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import {
  Moon, Sun, Monitor, Trash2, Download, Shield, ChevronRight, Info, AlertTriangle, Check, Bell
} from 'lucide-react';
import { applyThemeMode, localSettings } from '@/lib/trackingStore';
import { tripsToCSV, downloadCSV } from '@/lib/tripEngine';
import { useQuery } from '@tanstack/react-query';
import {
  getPermissionExplanation,
  getPermissionStatus,
  openNativeSettings,
  requestActivityRecognitionPermission,
  requestBackgroundLocationPermission,
  requestForegroundLocationPermission,
  requestNotificationPermission,
} from '@/lib/permissions';
import { isAndroid } from '@/lib/nativePlatform';
import { startNativeAutoTracking, stopNativeAutoTracking } from '@/lib/activityRecognition';
import { syncReminderNotifications } from '@/lib/notificationService';

function SectionTitle({ children }) {
  return <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground px-1 mb-2 mt-6">{children}</div>;
}

function SettingRow({ icon: Icon, label, sublabel, children, onClick, danger }) {
  return (
    <div
      className={`flex items-center justify-between py-3 px-1 border-b border-border/50 last:border-0 ${onClick ? 'cursor-pointer hover:bg-secondary/50 rounded-xl -mx-1 px-2 transition-colors' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {Icon && (
          <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${danger ? 'bg-red-50 dark:bg-red-950/30' : 'bg-secondary'}`}>
            <Icon className={`w-4 h-4 ${danger ? 'text-red-500' : 'text-muted-foreground'}`} />
          </div>
        )}
        <div className="min-w-0">
          <div className={`text-sm font-medium ${danger ? 'text-red-600 dark:text-red-400' : ''}`}>{label}</div>
          {sublabel && <div className="text-xs text-muted-foreground mt-0.5">{sublabel}</div>}
        </div>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ value, onChange }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange(!value); }}
      className={`relative w-12 h-6 rounded-full transition-colors ${value ? 'bg-primary' : 'bg-secondary border border-border'}`}
    >
      <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${value ? 'left-6' : 'left-0.5'}`} />
    </button>
  );
}

function PermissionBadge({ value }) {
  const granted = value === 'granted';
  return (
    <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
      granted ? 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
    }`}>
      {granted ? 'Granted' : value === 'denied' ? 'Denied' : 'Needs setup'}
    </span>
  );
}

export default function Settings() {
  const [saved, setSaved] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState(null);
  const qc = useQueryClient();

  // Load settings from local storage
  const [cfg, setCfg] = useState(() => localSettings.get());

  const { data: allTrips = [] } = useQuery({
    queryKey: ['settings-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 500 }),
  });

  const updateCfg = (patch) => {
    const updated = localSettings.update(patch);
    setCfg(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    return updated;
  };

  const updateTheme = (mode) => {
    const updated = updateCfg({ dark_mode: mode });
    applyThemeMode(updated.dark_mode);
  };

  const updateNotificationSetting = async (patch) => {
    const wantsNotifications = patch.notifications_enabled === true ||
      Object.entries(patch).some(([key, value]) => key !== 'notifications_enabled' && value === true);

    if (wantsNotifications) {
      const granted = await requestNotificationPermission();
      if (!granted) {
        alert(getPermissionExplanation('notifications'));
        await refreshPermissions();
        return;
      }
    }

    const updated = updateCfg(patch);
    await syncReminderNotifications(updated);
    await refreshPermissions();
  };

  const updateRetention = async (days) => {
    updateCfg({ data_retention_days: days });
    await qc.invalidateQueries();
  };

  const showPrivacyPolicy = () => {
    alert('DriveSense stores trip, route, score, vehicle, and settings data locally on this device. The app does not upload trips to a cloud service, does not sell data, and does not use ads or analytics. Deleting trips in Settings removes local trip history from this device.');
  };

  const updateTrackingPaused = async (paused) => {
    const updated = updateCfg({ tracking_paused: paused });
    if (!isAndroid()) return;

    if (paused) {
      await stopNativeAutoTracking();
      return;
    }

    if (updated.tracking_mode === 'background_auto') {
      try {
        await startNativeAutoTracking();
      } catch {}
    }
  };

  const enableTrackingMode = async (mode) => {
    if (mode === 'manual') {
      if (isAndroid()) await stopNativeAutoTracking();
      updateCfg({
        tracking_mode: 'manual',
        auto_tracking_enabled: false,
        background_tracking_enabled: false,
      });
      return;
    }

    const locationGranted = await requestForegroundLocationPermission();
    if (!locationGranted) {
      alert(getPermissionExplanation('foregroundLocation'));
      await refreshPermissions();
      return;
    }

    const activityGranted = !isAndroid() || await requestActivityRecognitionPermission();
    if (!activityGranted) {
      alert(getPermissionExplanation('activityRecognition'));
      await refreshPermissions();
      return;
    }

    if (mode === 'background_auto') {
      const backgroundGranted = await requestBackgroundLocationPermission();
      if (!backgroundGranted) {
        alert('Android requires "Allow all the time" location access for background auto tracking. Enable it in the app settings screen that opens.');
        await refreshPermissions();
        return;
      }

      if (isAndroid()) {
        try {
          await startNativeAutoTracking();
        } catch (error) {
          alert(error.message || 'Could not start native background auto tracking.');
          await refreshPermissions();
          return;
        }
      }
    }

    updateCfg({
      tracking_mode: mode,
      auto_tracking_enabled: mode !== 'manual',
      background_tracking_enabled: mode === 'background_auto',
    });
    if (mode !== 'background_auto' && isAndroid()) await stopNativeAutoTracking();
    await refreshPermissions();
  };

  const refreshPermissions = async () => {
    setPermissionStatus(await getPermissionStatus());
  };

  useEffect(() => {
    refreshPermissions();
  }, []);

  const handleDeleteAllTrips = async () => {
    if (!confirm('Delete ALL trips? This cannot be undone.')) return;
    const trips = allTrips;
    for (const t of trips) {
      await tripService.delete(t.id);
    }
    qc.invalidateQueries();
    alert('All trips deleted.');
  };

  const handleExportAll = async () => {
    const completed = allTrips.filter(t => t.status === 'completed');
    const csv = tripsToCSV(completed);
    const result = await downloadCSV(csv, `drivesense-all-trips-${new Date().toISOString().split('T')[0]}.csv`);
    if (result?.native) alert(`Export saved to Documents as ${result.filename}.`);
  };

  return (
    <div className="space-y-4 pb-6">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-grotesk font-bold">Settings</h1>
          <p className="text-muted-foreground text-sm mt-1">Customize your DriveSense experience</p>
        </div>
        {saved && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-1.5 text-xs text-green-600 font-medium bg-green-50 dark:bg-green-950/30 px-2.5 py-1.5 rounded-full"
          >
            <Check className="w-3.5 h-3.5" />
            Saved
          </motion.div>
        )}
      </motion.div>

      <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">

        {/* Tracking */}
        <SectionTitle>Tracking</SectionTitle>
        <div className="space-y-1">
          <div>
            <div className="text-sm font-medium mb-2 px-1">Tracking Mode</div>
            <div className="space-y-2">
              {[
                { id: 'manual', label: 'Manual Only', sub: 'Start/stop trips manually' },
                { id: 'auto_detect', label: 'Auto-Detect', sub: 'Detects driving when app is open' },
                { id: 'background_auto', label: 'Background Auto', sub: '⚠️ Uses more battery' },
              ].map(opt => (
                <button
                  key={opt.id}
                  onClick={() => enableTrackingMode(opt.id)}
                  className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all text-left ${
                    cfg.tracking_mode === opt.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                  }`}
                >
                  <div>
                    <div className="text-sm font-medium">{opt.label}</div>
                    <div className="text-xs text-muted-foreground">{opt.sub}</div>
                  </div>
                  {cfg.tracking_mode === opt.id && <Check className="w-4 h-4 text-primary" />}
                </button>
              ))}
            </div>
          </div>

          <SettingRow
            icon={AlertTriangle}
            label="Pause All Tracking"
            sublabel="Temporarily disable trip detection"
          >
            <Toggle value={cfg.tracking_paused} onChange={updateTrackingPaused} />
          </SettingRow>
          <SettingRow
            icon={Shield}
            label="Auto-Tracking"
            sublabel="Start only after you enable it and driving signals are strong"
          >
            <Toggle value={cfg.auto_tracking_enabled} onChange={async v => {
              if (v) {
                await enableTrackingMode('auto_detect');
                return;
              }
              if (isAndroid()) await stopNativeAutoTracking();
              updateCfg({ auto_tracking_enabled: false, tracking_mode: 'manual' });
            }} />
          </SettingRow>
          <SettingRow
            icon={Shield}
            label="Background Tracking"
            sublabel="Keeps recording after the app is minimized with a persistent notification"
          >
            <Toggle value={cfg.background_tracking_enabled} onChange={async v => {
              if (v) {
                await enableTrackingMode('background_auto');
                return;
              }
              if (isAndroid()) await stopNativeAutoTracking();
              updateCfg({ background_tracking_enabled: false, auto_tracking_enabled: false, tracking_mode: 'manual' });
              await refreshPermissions();
            }} />
          </SettingRow>
        </div>

        {/* Android Permissions */}
        <SectionTitle>Android Permissions</SectionTitle>
        <div className="space-y-1">
          {[
            { key: 'foregroundLocation', label: 'Location', sub: getPermissionExplanation('foregroundLocation'), action: requestForegroundLocationPermission },
            { key: 'backgroundLocation', label: 'Background Location', sub: getPermissionExplanation('backgroundLocation'), action: requestBackgroundLocationPermission },
            { key: 'activityRecognition', label: 'Physical Activity', sub: getPermissionExplanation('activityRecognition'), action: requestActivityRecognitionPermission },
            { key: 'notifications', label: 'Notifications', sub: getPermissionExplanation('notifications'), action: requestNotificationPermission },
          ].map(({ key, label, sub, action }) => (
            <SettingRow key={key} icon={Info} label={label} sublabel={sub}>
              <div className="flex items-center gap-2">
                <PermissionBadge value={permissionStatus?.[key]} />
                {permissionStatus?.[key] !== 'granted' && (
                  <button
                    className="text-xs font-semibold text-primary"
                    onClick={async e => {
                      e.stopPropagation();
                      await action();
                      await refreshPermissions();
                    }}
                  >
                    Enable
                  </button>
                )}
              </div>
            </SettingRow>
          ))}
          <SettingRow
            icon={AlertTriangle}
            label="Battery Optimization"
            sublabel="Open Android app settings if long background trips are being stopped"
            onClick={openNativeSettings}
          >
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </SettingRow>
        </div>

        {/* Appearance */}
        <SectionTitle>Appearance</SectionTitle>
        <div className="space-y-1">
          <div>
            <div className="text-sm font-medium mb-2 px-1">Theme</div>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'light', icon: Sun, label: 'Light' },
                { id: 'dark', icon: Moon, label: 'Dark' },
                { id: 'system', icon: Monitor, label: 'System' },
              ].map(({ id, icon: Icon, label }) => (
                <button
                  key={id}
                  onClick={() => updateTheme(id)}
                  className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all ${
                    cfg.dark_mode === id ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:border-primary/40'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="text-xs font-medium">{label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3">
            <div className="text-sm font-medium mb-2 px-1">Units</div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: 'metric', label: 'Metric (km/h)' },
                { id: 'imperial', label: 'Imperial (mph)' },
              ].map(opt => (
                <button
                  key={opt.id}
                  onClick={() => updateCfg({ units: opt.id })}
                  className={`p-3 rounded-xl border text-sm font-medium transition-all ${
                    cfg.units === opt.id ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:border-primary/40'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Notifications */}
        <SectionTitle>Notifications</SectionTitle>
        <div>
          <SettingRow
            icon={Bell}
            label="Enable Notifications"
            sublabel="Master switch for all DriveSense reminders and summaries"
          >
            <Toggle value={cfg.notifications_enabled !== false} onChange={v => updateNotificationSetting({ notifications_enabled: v })} />
          </SettingRow>
          {[
            { key: 'trip_start_notification', label: 'Trip Started', sub: 'Notify when a trip begins' },
            { key: 'trip_end_notification', label: 'Trip Ended', sub: 'Summary when trip finishes' },
            { key: 'weekly_report_notification', label: 'Weekly Report', sub: 'Weekly driving summary' },
            { key: 'safe_driving_reminder', label: 'Safe Driving Tips', sub: 'Occasional driving reminders' },
          ].map(({ key, label, sub }) => (
            <SettingRow key={key} label={label} sublabel={sub}>
              <Toggle value={cfg.notifications_enabled !== false && cfg[key]} onChange={v => updateNotificationSetting({ [key]: v })} />
            </SettingRow>
          ))}
        </div>

        {/* Detection Thresholds */}
        <SectionTitle>Detection Thresholds</SectionTitle>
        <p className="text-xs text-muted-foreground px-1 mb-3">
          Adjust sensitivity of driving event detection. Lower values = more sensitive.
        </p>
        <div className="space-y-4">
          {[
            { key: 'threshold_harsh_brake_ms2', label: 'Harsh Braking', unit: 'm/s²', min: 2, max: 8, step: 0.5 },
            { key: 'threshold_rapid_accel_ms2', label: 'Rapid Acceleration', unit: 'm/s²', min: 1.5, max: 6, step: 0.5 },
            { key: 'threshold_sharp_turn_degs', label: 'Sharp Turn', unit: '°/s', min: 20, max: 90, step: 5 },
            { key: 'threshold_speeding_kmh', label: 'Speeding (fallback)', unit: 'km/h', min: 80, max: 180, step: 10 },
          ].map(({ key, label, unit, min, max, step }) => (
            <div key={key} className="px-1">
              <div className="flex justify-between text-xs mb-1.5">
                <span className="font-medium">{label}</span>
                <span className="text-primary font-semibold">{cfg[key]} {unit}</span>
              </div>
              <input
                type="range" min={min} max={max} step={step} value={cfg[key]}
                onChange={e => updateCfg({ [key]: parseFloat(e.target.value) })}
                className="w-full accent-primary"
              />
            </div>
          ))}
        </div>

        {/* Speed Warning */}
        <SectionTitle>Speed Warning</SectionTitle>
        <p className="text-xs text-muted-foreground px-1 mb-3">
          Get warned during a trip if you exceed the speed limit by this margin.
        </p>
        <div className="px-1">
          <div className="flex justify-between text-xs mb-1.5">
            <span className="font-medium">Warn when over limit by</span>
            <span className="text-primary font-semibold">+{cfg.threshold_speed_over_kmh ?? 10} km/h</span>
          </div>
          <input
            type="range" min={5} max={30} step={5}
            value={cfg.threshold_speed_over_kmh ?? 10}
            onChange={e => updateCfg({ threshold_speed_over_kmh: parseFloat(e.target.value) })}
            className="w-full accent-primary"
          />
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>+5 km/h (strict)</span>
            <span>+30 km/h (lenient)</span>
          </div>
        </div>

        {/* Privacy */}
        <SectionTitle>Privacy & Data</SectionTitle>
        <div>
          <SettingRow
            icon={Shield}
            label="Privacy Policy"
            sublabel="All data is stored locally on your device"
            onClick={showPrivacyPolicy}
          >
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </SettingRow>
          <SettingRow
            icon={Download}
            label="Export All Trips"
            sublabel="Download as CSV file"
            onClick={handleExportAll}
          >
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </SettingRow>
          <SettingRow
            icon={Info}
            label="Data Retention"
            sublabel="Keep local trip history on this device"
          >
            <select
              value={cfg.data_retention_days}
              onChange={e => updateRetention(Number(e.target.value))}
              className="bg-card border border-border rounded-lg text-xs px-2 py-1"
            >
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
              <option value={0}>Forever</option>
            </select>
          </SettingRow>
          <SettingRow
            icon={Trash2}
            label="Delete All Trips"
            sublabel="Permanently removes all trip data"
            danger
            onClick={handleDeleteAllTrips}
          >
            <ChevronRight className="w-4 h-4 text-red-400" />
          </SettingRow>
        </div>
      </div>

      {/* About */}
      <div className="bg-secondary/50 rounded-2xl p-4 text-xs text-muted-foreground space-y-1">
        <div className="font-semibold text-foreground text-sm">DriveSense</div>
        <div>Version 1.0.0 (Capacitor Android)</div>
        <div>Map: OpenStreetMap + Leaflet (free, open-source)</div>
        <div>Data: Stored locally · No cloud sync · No ads · No analytics</div>
      </div>
    </div>
  );
}
