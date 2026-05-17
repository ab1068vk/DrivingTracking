import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import {
  Moon, Sun, Monitor, Trash2, Download, Upload, Shield, ChevronRight, Info, AlertTriangle, Check, Bell, Clock, Lock, Unlock, SlidersHorizontal, Focus, MapPin, Plus, LocateFixed, Gauge, Droplets, Bluetooth, Volume2, Route, Target
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { applyThemeMode, getLastParkedLocation, localSettings } from '@/lib/trackingStore';
import { tripsToCSV, downloadCSV } from '@/lib/tripEngine';
import { buildDrivingThresholds } from '@/lib/tripEngine';
import { useQuery } from '@tanstack/react-query';
import {
  getPermissionExplanation,
  getPermissionStatus,
  requestActivityRecognitionPermission,
  requestBackgroundLocationPermission,
  requestForegroundLocationPermission,
  requestNotificationPermission,
} from '@/lib/permissions';
import { isAndroid } from '@/lib/nativePlatform';
import {
  getAndroidBatteryOptimizationStatus,
  openAndroidUsageAccessSettings,
  getNativeAutoTrackingStatus,
  openAndroidBatteryOptimizationSettings,
  startNativeAutoTracking,
  stopNativeAutoTracking,
} from '@/lib/activityRecognition';
import { syncReminderNotifications } from '@/lib/notificationService';
import { exportDriveSenseBackup, importDriveSenseBackup } from '@/lib/dataBackup';
import {
  applyCalibrationProfile,
  clearCalibrationProfile,
  computeCalibrationProfile,
  loadCalibrationProfile,
  saveCalibrationProfile,
} from '@/lib/thresholdCalibration';
import { getCurrentLocation } from '@/lib/trackingService';
import { getPrivacyZones, removePrivacyZone, upsertPrivacyZone } from '@/lib/privacyZones';
import { connectObdBleAdapter, getObdBluetoothSupport } from '@/lib/obdBluetooth';
import { getMotionSensorSupport, requestMotionSensorPermission } from '@/lib/sensorFusionModel';

function SectionTitle({ children }) {
  return <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground px-1 mb-2 mt-6">{children}</div>;
}

function SettingRow({ icon: Icon = null, label, sublabel = '', children = null, onClick = null, danger = false }) {
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

function Toggle({ value, onChange, disabled = false }) {
  return (
    <button
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(!value); }}
      className={`relative w-12 h-6 rounded-full transition-colors disabled:opacity-50 ${value ? 'bg-primary' : 'bg-secondary border border-border'}`}
    >
      <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${value ? 'left-6' : 'left-0.5'}`} />
    </button>
  );
}

function PermissionBadge({ value }) {
  const granted = value === 'granted';
  const unavailable = value === 'unavailable';
  return (
    <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
      granted
        ? 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300'
        : unavailable
          ? 'bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300'
          : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
    }`}>
      {granted ? 'Granted' : unavailable ? 'Unavailable' : value === 'denied' ? 'Denied' : 'Needs setup'}
    </span>
  );
}

function FeaturePermissionBadge({ value }) {
  if (value === 'none') {
    return (
      <span className="rounded-full bg-secondary px-2 py-1 text-xs font-semibold text-muted-foreground">
        No prompt
      </span>
    );
  }
  return <PermissionBadge value={value} />;
}

const DRIVING_PATTERN_DEFINITIONS = [
  {
    term: 'Aggression score',
    definition: 'Rates hard acceleration, harsh braking, aggressive overtakes, speed creep, and jerk. Higher means calmer, more controlled driving.',
  },
  {
    term: 'Defensive score',
    definition: 'Rewards steady speed, safe following behavior, fewer near-miss signatures, fewer distraction signals, and consistent control.',
  },
  {
    term: 'Jerk score',
    definition: 'Measures how abruptly acceleration changes. Low jerk means smoother throttle and braking; high jerk often feels jumpy or uncomfortable.',
  },
  {
    term: 'Speed variability index',
    definition: 'Shows how much your speed swings during the trip. Lower variability usually means smoother traffic flow and better anticipation.',
  },
  {
    term: 'Fuel band score',
    definition: 'Checks how much driving happened in efficient cruising ranges versus stop-and-go, very slow crawling, or high-speed driving.',
  },
  {
    term: 'Following score',
    definition: 'Looks for repeated deceleration patterns that suggest following traffic too closely or reacting late to vehicles ahead.',
  },
  {
    term: 'Focus score',
    definition: 'Uses Android Usage Access when enabled, plus GPS behaviour signals as a fallback, to estimate distraction during trips.',
  },
  {
    term: 'Intersection score',
    definition: 'Looks at stop-and-go smoothness around lower-speed points where intersections, turns, parking lots, and traffic controls often happen.',
  },
  {
    term: 'Drowsy risk',
    definition: 'Flags longer highway sections with growing heading drift or weaker control patterns that can suggest fatigue.',
  },
  {
    term: 'Parking approach',
    definition: 'Scores the final low-speed part of a trip for smooth deceleration instead of abrupt stopping near the destination.',
  },
];

export default function Settings() {
  const [saved, setSaved] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState(null);
  const [nativeTrackingStatus, setNativeTrackingStatus] = useState(null);
  const [batteryStatus, setBatteryStatus] = useState(null);
  const [patternGuideOpen, setPatternGuideOpen] = useState(false);
  const [calibProfile, setCalibProfile] = useState(null);
  const [calibLoading, setCalibLoading] = useState(false);
  const [parkedLocation, setParkedLocation] = useState(null);
  const [privacyDraft, setPrivacyDraft] = useState({ label: 'Private place', radius_m: 180 });
  const [obdPairingStatus, setObdPairingStatus] = useState('');
  const importInputRef = useRef(null);
  const qc = useQueryClient();

  // Load settings from local storage
  const [cfg, setCfg] = useState(() => localSettings.get());
  const [thresholdEditingEnabled, setThresholdEditingEnabled] = useState(false);

  const { data: allTrips = [] } = useQuery({
    queryKey: ['settings-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 5000 }),
  });

  const { data: allVehicles = [] } = useQuery({
    queryKey: ['settings-vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 200 }),
  });

  const updateCfg = (patch) => {
    const updated = localSettings.update(patch);
    setCfg(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    return updated;
  };

  const updateNightMode = (mode) => {
    updateCfg({ night_detection_mode: mode });
  };

  const sliderWarning = (value, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    const span = max - min;
    if (parsed <= min + span * 0.12) return 'Very sensitive';
    if (parsed >= max - span * 0.12) return 'Very lenient';
    return null;
  };

  const updateTheme = (mode) => {
    const updated = updateCfg({ dark_mode: mode });
    applyThemeMode(updated.dark_mode);
  };

  const runCalibration = async () => {
    setCalibLoading(true);
    const trips = await tripService.list({ sort: '-start_time', limit: 200 });
    const profile = computeCalibrationProfile(trips, buildDrivingThresholds(cfg));
    await saveCalibrationProfile(profile);
    setCalibProfile(profile);
    setCalibLoading(false);
  };

  const applyCalibration = async () => {
    const updated = await applyCalibrationProfile(calibProfile, cfg, async (next) => {
      localSettings.set(next);
      setCfg(next);
    });
    setCfg(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    setCalibProfile(await loadCalibrationProfile());
  };

  const dismissCalibration = async () => {
    await clearCalibrationProfile();
    setCalibProfile(null);
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
    const updated = paused
      ? updateCfg({
        tracking_paused: true,
        tracking_mode: 'manual',
        auto_tracking_enabled: false,
        background_tracking_enabled: false,
      })
      : updateCfg({ tracking_paused: false });
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
    if (cfg.tracking_paused && mode !== 'manual') {
      updateCfg({ tracking_paused: false });
    }

    if (mode === 'manual') {
      if (isAndroid()) await stopNativeAutoTracking();
      updateCfg({
        tracking_mode: 'manual',
        auto_tracking_enabled: false,
        background_tracking_enabled: false,
        tracking_paused: false,
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
        alert('Android requires Location permission set to "Allow all the time" for background auto tracking. In the app settings screen that opened, tap Permissions > Location > Allow all the time, then return to DriveSense and turn Background Tracking on again.');
        await refreshPermissions();
        return;
      }

      if (isAndroid()) {
        try {
          await startNativeAutoTracking();
        } catch (error) {
          alert(error.message || 'Could not start native background auto tracking. Check Location, Physical Activity, Notifications, and Battery Optimization settings.');
          await refreshPermissions();
          return;
        }
      }
    }

    updateCfg({
      tracking_mode: mode,
      auto_tracking_enabled: mode !== 'manual',
      background_tracking_enabled: mode === 'background_auto',
      tracking_paused: false,
    });
    if (mode !== 'background_auto' && isAndroid()) await stopNativeAutoTracking();
    await refreshPermissions();
  };

  const refreshPermissions = async () => {
    const status = await getPermissionStatus();
    setPermissionStatus(status);

    if (isAndroid()) {
      try {
        setNativeTrackingStatus(await getNativeAutoTrackingStatus());
      } catch {}
      try {
        setBatteryStatus(await getAndroidBatteryOptimizationStatus());
      } catch {}
    }
  };

  useEffect(() => {
    refreshPermissions();
    loadCalibrationProfile().then(setCalibProfile);
    getLastParkedLocation().then(setParkedLocation);
  }, []);

  const privacyZones = getPrivacyZones(cfg);

  const savePrivacyZone = (location, sourceLabel) => {
    if (!location?.lat || !location?.lng) {
      alert('No location is available for that privacy zone yet.');
      return;
    }
    const updated = upsertPrivacyZone({
      label: privacyDraft.label || sourceLabel,
      radius_m: privacyDraft.radius_m,
      lat: location.lat,
      lng: location.lng,
    }, cfg);
    setCfg(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const addCurrentPrivacyZone = async () => {
    try {
      const location = await getCurrentLocation();
      savePrivacyZone(location, 'Current location');
    } catch (error) {
      alert(error.message || 'Could not get current location.');
    }
  };

  const deletePrivacyZone = (id) => {
    const updated = removePrivacyZone(id, cfg);
    setCfg(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  useEffect(() => {
    if (!isAndroid()) return undefined;

    const refreshAndRestartIfReady = async () => {
      await refreshPermissions();
      const latest = localSettings.get();
      if (latest.tracking_mode === 'background_auto' && !latest.tracking_paused) {
        try {
          await startNativeAutoTracking();
          setNativeTrackingStatus(await getNativeAutoTrackingStatus());
        } catch {}
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshAndRestartIfReady();
    };
    window.addEventListener('focus', refreshAndRestartIfReady);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refreshAndRestartIfReady);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const handleBatteryOptimization = async () => {
    try {
      await openAndroidBatteryOptimizationSettings();
      await refreshPermissions();
    } catch {
      alert('Could not open the Android battery optimization screen. Open Android Settings > Apps > DriveSense > Battery and choose Unrestricted.');
    }
  };

  const handleMotionPermission = async () => {
    const granted = await requestMotionSensorPermission();
    await refreshPermissions();
    if (!granted) alert(getPermissionExplanation('motionSensors'));
  };

  const handleObdPairing = async () => {
    setObdPairingStatus('Opening Bluetooth chooser...');
    try {
      const result = await connectObdBleAdapter();
      const name = result.device?.name || 'OBD-II adapter';
      setObdPairingStatus(result.connected ? `${name} connected for this session.` : `${name} selected. Could not open a GATT session.`);
      updateCfg({ obd_bluetooth_enabled: true });
      await refreshPermissions();
    } catch (error) {
      setObdPairingStatus(error?.message || 'Could not connect to the OBD-II adapter.');
      await refreshPermissions();
    }
  };

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
    if (result?.native) alert(`Export saved to Downloads as ${result.filename}.`);
  };

  const handleExportBackup = async () => {
    const result = await exportDriveSenseBackup({
      trips: allTrips,
      vehicles: allVehicles,
      settings: cfg,
    });
    if (result?.native) alert(`Full backup saved to Downloads as ${result.filename}.`);
  };

  const handleImportBackup = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!confirm('Import this DriveSense backup? Trips and vehicles with matching IDs will be updated, and new ones will be added.')) return;

    try {
      const result = await importDriveSenseBackup(file);
      setCfg(localSettings.get());
      applyThemeMode(localSettings.get().dark_mode);
      await qc.invalidateQueries();
      alert(`Import complete: ${result.trips} trips and ${result.vehicles} vehicles merged.`);
    } catch (error) {
      alert(error.message || 'Could not import backup.');
    }
  };

  const effectiveTrackingMode = cfg.tracking_paused ? 'manual' : cfg.tracking_mode;
  const obdSupport = getObdBluetoothSupport();
  const motionSupport = getMotionSensorSupport();
  const locationFeatureStatus = permissionStatus?.foregroundLocation === 'granted' ? 'granted' : permissionStatus?.foregroundLocation;
  const notificationFeatureStatus = permissionStatus?.notifications === 'granted' ? 'granted' : permissionStatus?.notifications;

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
                    effectiveTrackingMode === opt.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                  }`}
                >
                  <div>
                    <div className="text-sm font-medium">{opt.label}</div>
                    <div className="text-xs text-muted-foreground">{opt.sub}</div>
                  </div>
                  {effectiveTrackingMode === opt.id && <Check className="w-4 h-4 text-primary" />}
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
            sublabel={cfg.tracking_paused ? 'Paused until Pause All Tracking is turned off' : 'Start only after you enable it and driving signals are strong'}
          >
            <Toggle value={!cfg.tracking_paused && cfg.auto_tracking_enabled} onChange={async v => {
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
            sublabel={cfg.tracking_paused ? 'Paused until Pause All Tracking is turned off' : nativeTrackingStatus?.enabled ? 'Native background auto tracking is running' : 'Keeps recording after the app is minimized with a persistent notification'}
          >
            <Toggle value={!cfg.tracking_paused && cfg.background_tracking_enabled} onChange={async v => {
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
          {isAndroid() && (
            <SettingRow
              icon={Shield}
              label="Native Auto Tracking"
              sublabel={nativeTrackingStatus?.enabled ? 'Android service is armed and waiting for driving motion' : 'Android service is not running'}
            >
              <PermissionBadge value={nativeTrackingStatus?.enabled ? 'granted' : 'not_requested'} />
            </SettingRow>
          )}
          {[
            { key: 'foregroundLocation', label: 'Location', sub: getPermissionExplanation('foregroundLocation'), action: requestForegroundLocationPermission },
            { key: 'backgroundLocation', label: 'Background Location', sub: getPermissionExplanation('backgroundLocation'), action: requestBackgroundLocationPermission },
            { key: 'activityRecognition', label: 'Physical Activity', sub: getPermissionExplanation('activityRecognition'), action: requestActivityRecognitionPermission },
            { key: 'notifications', label: 'Notifications', sub: getPermissionExplanation('notifications'), action: requestNotificationPermission },
            { key: 'motionSensors', label: 'Motion Sensors', sub: getPermissionExplanation('motionSensors'), action: handleMotionPermission },
            { key: 'bluetooth', label: 'Bluetooth / Nearby Devices', sub: getPermissionExplanation('bluetooth'), action: handleObdPairing },
            ...(isAndroid() ? [{ key: 'phoneUsageAccess', label: 'Phone Usage Access', sub: getPermissionExplanation('phoneUsageAccess'), action: openAndroidUsageAccessSettings }] : []),
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
            sublabel={batteryStatus?.batteryOptimizationIgnored ? 'Battery optimization is already unrestricted for DriveSense' : 'Open Android battery settings and allow unrestricted background activity'}
            onClick={handleBatteryOptimization}
          >
            <div className="flex items-center gap-2">
              {isAndroid() && (
                <PermissionBadge value={batteryStatus?.batteryOptimizationIgnored ? 'granted' : 'not_requested'} />
              )}
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </div>
          </SettingRow>
        </div>

        {/* Feature Permission Check */}
        <SectionTitle>Feature Permissions</SectionTitle>
        <div className="space-y-1">
          {[
            {
              label: 'Trip history, search, tags, notes, favorites, calendar, weekly summary, goals, costs',
              sub: 'No new Android permission prompt. These features use local trips, vehicles, and settings already stored on this device.',
              value: 'none',
            },
            {
              label: 'Route comparison, commute detection, road types, parking reminder, risk hotspots',
              sub: 'Uses trip GPS data. Android asks for Location when you start tracking, use current location, or enable auto tracking.',
              value: locationFeatureStatus,
              action: requestForegroundLocationPermission,
            },
            {
              label: 'Maintenance reminders and weekly driver digests',
              sub: 'In-app dashboards need no prompt. Android asks for Notifications only if reminder notifications are enabled.',
              value: notificationFeatureStatus,
              action: requestNotificationPermission,
            },
            {
              label: 'Background auto tracking for richer repeated-route history',
              sub: 'Only needed if you choose Background Auto. Android asks separately for Background Location, Activity, and Notifications.',
              value: permissionStatus?.backgroundLocation,
              action: requestBackgroundLocationPermission,
            },
            {
              label: 'Sensor fusion, crash detection, phone movement, and incident check-in',
              sub: 'Uses GPS plus device motion and Android activity context. Motion usually has no Android prompt, but this row will request it on platforms that require one.',
              value: permissionStatus?.motionSensors,
              action: handleMotionPermission,
            },
            {
              label: 'Real speed limits, weather, OSRM map matching, and offline route previews',
              sub: 'Uses open-source map/weather data over the network or cached local route data. Android does not show a runtime prompt for Internet access.',
              value: 'none',
            },
            {
              label: 'Live voice alerts and AI driving coach summaries',
              sub: 'Runs on-device with rules and speech output. No microphone, paid AI service, or cloud permission is required.',
              value: 'none',
            },
            {
              label: 'OBD-II Bluetooth diagnostics',
              sub: 'Optional. Pairing a compatible BLE adapter may trigger Android Nearby Devices/Bluetooth permission and the Bluetooth chooser.',
              value: permissionStatus?.bluetooth,
              action: handleObdPairing,
            },
          ].map(({ label, sub, value, action }) => (
            <SettingRow key={label} icon={Info} label={label} sublabel={sub}>
              <div className="flex items-center gap-2">
                <FeaturePermissionBadge value={value} />
                {action && value !== 'granted' && (
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
        <div className="space-y-3">
          <SettingRow
            icon={Bell}
            label="Enable all notifications"
            sublabel="Disabling this turns off all notification groups below"
          >
            <Toggle value={cfg.notifications_enabled !== false} onChange={v => updateNotificationSetting({ notifications_enabled: v })} />
          </SettingRow>
          <div className={`${cfg.notifications_enabled === false ? 'pointer-events-none opacity-50' : ''}`}>
            <div className="rounded-2xl bg-secondary/40 p-3">
              <div className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">Quiet Hours</div>
              <SettingRow label="Quiet hours" sublabel="Suppress non-safety notifications during this window">
                <Toggle value={cfg.notif_quiet_hours_enabled === true} onChange={v => updateNotificationSetting({ notif_quiet_hours_enabled: v })} disabled={cfg.notifications_enabled === false} />
              </SettingRow>
              <div className="grid grid-cols-2 gap-3 px-1 pt-3">
                <label className="text-xs font-medium">
                  Start
                  <input
                    type="time"
                    value={cfg.notif_quiet_start || '22:00'}
                    disabled={cfg.notif_quiet_hours_enabled !== true}
                    onChange={e => updateNotificationSetting({ notif_quiet_start: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
                  />
                </label>
                <label className="text-xs font-medium">
                  End
                  <input
                    type="time"
                    value={cfg.notif_quiet_end || '07:00'}
                    disabled={cfg.notif_quiet_hours_enabled !== true}
                    onChange={e => updateNotificationSetting({ notif_quiet_end: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
                  />
                </label>
              </div>
              <p className="mt-2 px-1 text-xs text-muted-foreground">Safety alerts always come through unless that channel is disabled.</p>
            </div>

            <div className="rounded-2xl bg-secondary/40 p-3">
              <div className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">While Driving</div>
              {[
                { key: 'notif_safety_alerts_enabled', label: 'Safety alerts channel', sub: 'Urgent warnings while driving' },
                { key: 'notif_phone_use_alert_enabled', label: 'Phone use warning', sub: 'Immediate warning when phone-use patterns appear' },
                { key: 'notif_drowsy_alert_enabled', label: 'Drowsy / fatigue warning', sub: 'Fatigue and long-drive break alerts' },
                { key: 'notif_speeding_alert_enabled', label: 'Speeding alert', sub: 'Sustained speeding warnings' },
                { key: 'danger_zone_alerts_enabled', label: 'Danger zone proximity alerts', sub: 'Warn when approaching your historical risk hotspots' },
                { key: 'live_coaching_enabled', label: 'Live coaching overlay', sub: 'Show real-time coaching feedback during active trips' },
              ].map(({ key, label, sub }) => (
                <SettingRow key={key} label={label} sublabel={sub}>
                  <Toggle value={cfg[key] !== false} onChange={v => updateNotificationSetting({ [key]: v })} disabled={cfg.notifications_enabled === false || (key !== 'notif_safety_alerts_enabled' && cfg.notif_safety_alerts_enabled === false)} />
                </SettingRow>
              ))}
            </div>

            <div className="rounded-2xl bg-secondary/40 p-3">
              <div className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">After Each Trip</div>
              {[
                { key: 'trip_start_notification', label: 'Trip started', sub: 'Notify when a trip begins' },
                { key: 'trip_end_notification', label: 'Trip ended', sub: 'Basic summary when trip finishes' },
                { key: 'notif_post_trip_summary_enabled', label: 'Post-trip smart summary', sub: 'One contextual notification after a notable trip' },
                { key: 'notif_post_trip_score_change', label: 'Score improvements and declines', sub: 'Notify when a score moves meaningfully' },
                { key: 'notif_post_trip_phone_use', label: 'Phone use report', sub: 'Post-trip report for high phone-use risk' },
                { key: 'notif_post_trip_fuel_saving', label: 'Eco fuel savings', sub: 'Call out efficient trips with fuel savings' },
              ].map(({ key, label, sub }) => (
                <SettingRow key={key} label={label} sublabel={sub}>
                  <Toggle value={cfg[key] !== false} onChange={v => updateNotificationSetting({ [key]: v })} disabled={cfg.notifications_enabled === false || (key.startsWith('notif_post_trip_') && cfg.notif_post_trip_summary_enabled === false && key !== 'notif_post_trip_summary_enabled')} />
                </SettingRow>
              ))}
              <div className="px-1 pt-3">
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="font-medium">Only notify if score is at least</span>
                  <span className="text-primary font-semibold">{cfg.notif_min_score_for_post_trip ?? 0}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={cfg.notif_min_score_for_post_trip ?? 0}
                  onChange={e => updateNotificationSetting({ notif_min_score_for_post_trip: Number(e.target.value) })}
                  className="w-full accent-primary"
                />
                <p className="mt-1 text-xs text-muted-foreground">0 means always notify when a post-trip rule matches.</p>
              </div>
            </div>

            <div className="rounded-2xl bg-secondary/40 p-3">
              <div className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">Coaching & Milestones</div>
              {[
                { key: 'notif_coaching_enabled', label: 'Coaching notifications', sub: 'Driving improvement tips and pattern changes' },
                { key: 'achievement_notifications', label: 'Achievements', sub: 'Notify when an achievement unlocks' },
                { key: 'notif_streak_enabled', label: 'Streak milestones', sub: 'Smooth-driving streak notifications' },
                { key: 'notif_weekly_pattern_enabled', label: 'Weekly driving summary', sub: 'Monday at 8:30am' },
                { key: 'weekly_report_notification', label: 'Classic weekly report', sub: 'Legacy Tuesday report' },
                { key: 'notif_style_shift_enabled', label: 'Driving style shift alerts', sub: 'Notify when your style changes across recent trips' },
                { key: 'safe_driving_reminder', label: 'Safe driving tips', sub: 'Occasional driving reminders' },
              ].map(({ key, label, sub }) => (
                <SettingRow key={key} label={label} sublabel={sub}>
                  <Toggle value={cfg[key] !== false} onChange={v => updateNotificationSetting({ [key]: v })} disabled={cfg.notifications_enabled === false || (key !== 'notif_coaching_enabled' && cfg.notif_coaching_enabled === false && key.startsWith('notif_'))} />
                </SettingRow>
              ))}
            </div>

            <div className="rounded-2xl bg-secondary/40 p-3">
              <div className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">Vehicle</div>
              <SettingRow label="Maintenance reminders" sublabel="Vehicle service due and soon notifications">
                <Toggle value={cfg.notif_maintenance_enabled !== false} onChange={v => updateNotificationSetting({ notif_maintenance_enabled: v })} disabled={cfg.notifications_enabled === false} />
              </SettingRow>
              <SettingRow label="No-trip nudge" sublabel="Remind after a period with no recorded trips">
                <Toggle value={cfg.notif_inactive_nudge_enabled !== false} onChange={v => updateNotificationSetting({ notif_inactive_nudge_enabled: v })} disabled={cfg.notifications_enabled === false} />
              </SettingRow>
              <SettingRow label="Nudge after" sublabel="Days without a completed trip">
                <select
                  value={cfg.notif_inactive_nudge_days ?? 7}
                  disabled={cfg.notif_inactive_nudge_enabled === false}
                  onChange={e => updateNotificationSetting({ notif_inactive_nudge_days: Number(e.target.value) })}
                  className="bg-card border border-border rounded-lg text-xs px-2 py-1 disabled:opacity-60"
                >
                  {[3, 5, 7, 14].map((days) => <option key={days} value={days}>{days} days</option>)}
                </select>
              </SettingRow>
            </div>
          </div>
        </div>

        {/* Driving Goals */}
        <SectionTitle>Driving Goals</SectionTitle>
        <p className="text-xs text-muted-foreground px-1 mb-3">
          Weekly targets used by the Dashboard goals card.
        </p>
        <div className="space-y-4">
          {[
            { key: 'weekly_goal_harsh_brakes', label: 'Max harsh brakes', min: 0, max: 20, step: 1 },
            { key: 'weekly_goal_speeding_events', label: 'Max speeding events', min: 0, max: 20, step: 1 },
            { key: 'weekly_goal_min_avg_score', label: 'Minimum average score', min: 50, max: 100, step: 5 },
            { key: 'weekly_goal_max_night_km', label: 'Max night km', min: 0, max: 100, step: 5 },
            { key: 'weekly_goal_max_night_trips', label: 'Max night trips', min: 0, max: 14, step: 1 },
          ].map(({ key, label, min, max, step }) => (
            <div key={key} className="px-1">
              <div className="flex justify-between text-xs mb-1.5">
                <span className="font-medium">{label}</span>
                <span className="text-primary font-semibold">{cfg[key]}</span>
              </div>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={cfg[key]}
                onChange={e => updateCfg({ [key]: Number(e.target.value) })}
                className="w-full accent-primary"
              />
            </div>
          ))}
        </div>

        {/* Night Driving Window */}
        <SectionTitle>Night Driving Window</SectionTitle>
        <p className="text-xs text-muted-foreground px-1 mb-3">
          Used for night-trip labels, goals, and safety scoring.
        </p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'sunset', label: 'Sunset', sub: 'GPS-based' },
              { id: 'custom', label: 'Custom', sub: `${cfg.night_start_time || '22:00'} to ${cfg.night_end_time || '06:00'}` },
            ].map(opt => (
              <button
                key={opt.id}
                onClick={() => updateNightMode(opt.id)}
                className={`flex items-center justify-between p-3 rounded-xl border transition-all text-left ${
                  cfg.night_detection_mode === opt.id ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:border-primary/40'
                }`}
              >
                <div>
                  <div className="text-sm font-medium">{opt.label}</div>
                  <div className="text-xs">{opt.sub}</div>
                </div>
                {cfg.night_detection_mode === opt.id && <Check className="w-4 h-4" />}
              </button>
            ))}
          </div>

          <div className={`rounded-xl border p-3 ${cfg.night_detection_mode === 'custom' ? 'border-primary/30 bg-primary/5' : 'border-border bg-secondary/30'}`}>
            <div className="flex items-center gap-2 text-sm font-medium mb-3">
              <Clock className="w-4 h-4 text-primary" />
              Custom night hours
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-medium">
                Start
                <input
                  type="time"
                  value={cfg.night_start_time || '22:00'}
                  disabled={cfg.night_detection_mode !== 'custom'}
                  onChange={e => updateCfg({ night_start_time: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
                />
              </label>
              <label className="text-xs font-medium">
                End
                <input
                  type="time"
                  value={cfg.night_end_time || '06:00'}
                  disabled={cfg.night_detection_mode !== 'custom'}
                  onChange={e => updateCfg({ night_end_time: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
                />
              </label>
            </div>
          </div>

          {cfg.night_detection_mode === 'sunset' && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
                <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                Sunset mode uses each trip point's date and GPS position; if GPS coordinates are missing, DriveSense falls back to the custom window.
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  { key: 'night_sunset_offset_minutes', label: 'Sunset offset', min: -120, max: 120 },
                  { key: 'night_sunrise_offset_minutes', label: 'Sunrise offset', min: -120, max: 120 },
                ].map(({ key, label, min, max }) => (
                  <div key={key} className="rounded-xl border border-border bg-secondary/30 p-3">
                    <div className="mb-1.5 flex justify-between text-xs">
                      <span className="font-medium">{label}</span>
                      <span className="font-semibold text-primary">{cfg[key] || 0} min</span>
                    </div>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={15}
                      value={cfg[key] || 0}
                      onChange={e => updateCfg({ [key]: Number(e.target.value) })}
                      className="w-full accent-primary"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Detection Thresholds */}
        <SectionTitle>Detection Thresholds</SectionTitle>
        <SettingRow
          icon={Info}
          label="Driving Pattern Definitions"
          sublabel="Explain aggression, defensive, jerk, focus, fuel band, and related trip metrics"
          onClick={() => setPatternGuideOpen(true)}
        >
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </SettingRow>
        <div className="flex items-start justify-between gap-3 px-1 mb-3">
          <p className="text-xs text-muted-foreground">
            Adjust sensitivity of driving event detection. Lower values = more sensitive.
          </p>
          <button
            type="button"
            onClick={() => setThresholdEditingEnabled(value => !value)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
              thresholdEditingEnabled ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200' : 'bg-secondary text-muted-foreground'
            }`}
          >
            {thresholdEditingEnabled ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
            {thresholdEditingEnabled ? 'Editing' : 'Locked'}
          </button>
        </div>
        {!thresholdEditingEnabled && (
          <div className="mb-3 flex items-start gap-2 rounded-xl bg-secondary/70 px-3 py-2 text-xs text-muted-foreground">
            <Lock className="w-4 h-4 flex-shrink-0 mt-0.5" />
            Sliders are locked to prevent accidental scoring changes.
          </div>
        )}
        {thresholdEditingEnabled && (
          <div className="mb-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            These settings directly change trip event detection, scoring, imports, and rescoring.
          </div>
        )}
        <div className="mb-4 rounded-2xl border border-border bg-secondary/30 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Threshold calibration</div>
              <div className="mt-1 text-xs text-muted-foreground">Analyse your driving to suggest personalized detection thresholds.</div>
            </div>
            <button
              type="button"
              onClick={runCalibration}
              disabled={calibLoading}
              className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
            >
              {calibLoading ? 'Analysing...' : calibProfile?.appliedAt ? 'Re-analyze' : 'Analyse my driving'}
            </button>
          </div>
          {calibProfile?.insufficient && (
            <div className="mt-3 rounded-xl bg-card p-3 text-xs text-muted-foreground">
              Needs {calibProfile.tripsNeeded} more trips or {calibProfile.kmNeeded} more km before calibration is reliable.
              <div className="mt-2 h-2 rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.min(100, ((15 - calibProfile.tripsNeeded) / 15) * 100)}%` }}
                />
              </div>
            </div>
          )}
          {calibProfile && !calibProfile.insufficient && !calibProfile.appliedAt && (
            <div className="mt-3 space-y-3">
              <span className="inline-flex rounded-full bg-blue-50 px-2 py-1 text-xs font-semibold capitalize text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">
                {calibProfile.confidence} confidence · {calibProfile.tripsAnalyzed} trips · {calibProfile.kmAnalyzed} km
              </span>
              <div className="overflow-hidden rounded-xl border border-border text-xs">
                {Object.entries(calibProfile.suggested).filter(([, value]) => value != null).map(([key, value]) => (
                  <div key={key} className="grid grid-cols-4 gap-2 border-b border-border/50 p-2 last:border-0">
                    <div className="col-span-1 truncate">{key.replace('threshold_', '').replace(/_/g, ' ')}</div>
                    <div>{calibProfile.current[key]}</div>
                    <div className="font-semibold text-primary">{value}</div>
                    <div className={calibProfile.delta[key] >= 0 ? 'text-orange-500' : 'text-emerald-500'}>{calibProfile.delta[key] >= 0 ? '+' : ''}{calibProfile.delta[key]}</div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={applyCalibration} className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground">Apply suggested thresholds</button>
                <button type="button" onClick={dismissCalibration} className="rounded-xl border border-border px-3 py-2 text-xs font-semibold">Dismiss</button>
              </div>
            </div>
          )}
          {calibProfile?.appliedAt && (
            <div className="mt-3 rounded-xl bg-emerald-50 p-3 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
              Calibrated to your driving · applied {new Date(calibProfile.appliedAt).toLocaleDateString()}
            </div>
          )}
        </div>
        <div className="space-y-4">
          {[
            { key: 'threshold_harsh_brake_ms2', label: 'Harsh Braking', unit: 'm/s²', min: 2, max: 8, step: 0.5 },
            { key: 'threshold_rapid_accel_ms2', label: 'Rapid Acceleration', unit: 'm/s²', min: 1.5, max: 6, step: 0.5 },
            { key: 'threshold_tailgate_decel_ms2', label: 'Tailgate Decel', unit: 'm/s²', min: 1.5, max: 5, step: 0.25 },
            { key: 'threshold_sharp_turn_g_low', label: 'Sharp Turn Low', unit: 'g', min: 0.2, max: 0.6, step: 0.05 },
            { key: 'threshold_sharp_turn_g_medium', label: 'Sharp Turn Medium', unit: 'g', min: 0.25, max: 0.8, step: 0.05 },
            { key: 'threshold_sharp_turn_g_high', label: 'Sharp Turn High', unit: 'g', min: 0.35, max: 1.0, step: 0.05 },
            { key: 'threshold_speeding_kmh', label: 'Speeding (fallback)', unit: 'km/h', min: 80, max: 180, step: 10 },
            { key: 'threshold_idle_seconds', label: 'Idle Event', unit: 's', min: 90, max: 300, step: 30 },
            { key: 'min_speed_harsh_brake_kmh', label: 'Harsh Brake Min Speed', unit: 'km/h', min: 5, max: 60, step: 5 },
            { key: 'min_speed_rapid_accel_kmh', label: 'Rapid Accel Min Speed', unit: 'km/h', min: 0, max: 40, step: 5 },
          ].map(({ key, label, unit, min, max, step }) => (
            <div key={key} className="px-1">
              <div className="flex justify-between text-xs mb-1.5">
                <span className="font-medium">{label}</span>
                <span className="flex items-center gap-2 text-primary font-semibold">
                  {sliderWarning(cfg[key], min, max) && thresholdEditingEnabled && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                      {sliderWarning(cfg[key], min, max)}
                    </span>
                  )}
                  {cfg[key]} {unit}
                </span>
              </div>
              <input
                type="range" min={min} max={max} step={step} value={cfg[key]}
                disabled={!thresholdEditingEnabled}
                onChange={e => updateCfg({ [key]: parseFloat(e.target.value) })}
                className="w-full accent-primary disabled:opacity-45"
              />
            </div>
          ))}
          <div className="pt-3 border-t border-border/70">
            <SettingRow
              icon={SlidersHorizontal}
              label="Advanced Safety Detection"
              sublabel={cfg.advanced_safety_detection_enabled === false ? 'Near-miss, drowsy, phone-proxy, speed-creep, and overtake detection are off' : 'Extra safety signatures are included in detection and scoring'}
            >
              <Toggle
                value={cfg.advanced_safety_detection_enabled !== false}
                onChange={v => updateCfg({ advanced_safety_detection_enabled: v })}
              />
            </SettingRow>
            <div className="space-y-4">
              {[
                { key: 'threshold_near_miss_brake_ms2', label: 'Near-Miss Brake Threshold', unit: 'm/s²', min: 2.5, max: 5.0, step: 0.5, help: 'How much braking force is needed before DriveSense considers a combined brake-and-turn a near miss.' },
                { key: 'threshold_near_miss_turn_degs', label: 'Near-Miss Turn Threshold', unit: 'deg/s', min: 15, max: 60, step: 5, help: 'How quickly heading must change during braking to count as a near-miss manoeuvre.' },
                { key: 'threshold_drowsy_heading_std', label: 'Drowsy Heading Drift', unit: 'degrees', min: 5, max: 15, step: 1, help: 'How much highway heading drift is allowed before a fatigue warning can trigger.' },
                { key: 'threshold_phone_proxy_oscillations', label: 'Phone Proxy Sensitivity', unit: 'oscillations', min: 2, max: 6, step: 1, help: 'How many left-right heading corrections are needed before distraction risk is flagged.' },
                { key: 'threshold_speed_creep_kmh', label: 'Speed Creep Alert', unit: 'km/h', min: 5, max: 25, step: 5, help: 'How much speed can rise on straight highway sections before DriveSense logs speed creep.' },
                { key: 'threshold_overtake_accel_ms2', label: 'Overtake Detection Sensitivity', unit: 'm/s²', min: 2.0, max: 5.0, step: 0.5, help: 'How hard acceleration must be to start the aggressive-overtake signature.' },
              ].map(({ key, label, unit, min, max, step, help }) => (
                <div key={key} className={`px-1 ${cfg.advanced_safety_detection_enabled === false ? 'opacity-60' : ''}`}>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="font-medium">{label}</span>
                    <span className="flex items-center gap-2 text-primary font-semibold">
                      {sliderWarning(cfg[key], min, max) && thresholdEditingEnabled && cfg.advanced_safety_detection_enabled !== false && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                          {sliderWarning(cfg[key], min, max)}
                        </span>
                      )}
                      {cfg[key]} {unit}
                    </span>
                  </div>
                  <input
                    type="range" min={min} max={max} step={step} value={cfg[key]}
                    disabled={!thresholdEditingEnabled || cfg.advanced_safety_detection_enabled === false}
                    onChange={e => updateCfg({ [key]: parseFloat(e.target.value) })}
                    className="w-full accent-primary disabled:opacity-45"
                  />
                  <p className="text-xs text-muted-foreground mt-1">{help}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Advanced Models */}
        <SectionTitle>Advanced Models</SectionTitle>
        <div className="rounded-2xl bg-secondary/40 p-3">
          <SettingRow
            icon={SlidersHorizontal}
            label="Sensor fusion model"
            sublabel={motionSupport.supported ? 'Combine GPS, device motion, gyroscope, and Android activity context' : motionSupport.note}
          >
            <div className="flex items-center gap-2">
              {motionSupport.permissionRequired && permissionStatus?.motionSensors !== 'granted' && (
                <button
                  className="text-xs font-semibold text-primary"
                  onClick={async e => {
                    e.stopPropagation();
                    await handleMotionPermission();
                  }}
                >
                  Enable
                </button>
              )}
              <Toggle
                value={cfg.sensor_fusion_enabled !== false}
                onChange={v => updateCfg({ sensor_fusion_enabled: v })}
                disabled={!motionSupport.supported}
              />
            </div>
          </SettingRow>
          <SettingRow
            icon={AlertTriangle}
            label="Crash / incident detection"
            sublabel="Detect impact-like motion followed by little movement"
          >
            <Toggle
              value={cfg.crash_detection_enabled !== false}
              onChange={v => updateCfg({ crash_detection_enabled: v })}
              disabled={cfg.sensor_fusion_enabled === false}
            />
          </SettingRow>
          <SettingRow
            icon={Bell}
            label="Emergency workflow"
            sublabel="Optional local check-in notice after a possible incident; no SMS or paid emergency service is used"
          >
            <Toggle
              value={cfg.emergency_workflow_enabled === true}
              onChange={v => updateCfg({ emergency_workflow_enabled: v })}
              disabled={cfg.crash_detection_enabled === false}
            />
          </SettingRow>
          <SettingRow
            icon={Route}
            label="OSRM map matching"
            sublabel="Snap GPS to roads with an open-source OSRM endpoint"
          >
            <Toggle
              value={cfg.map_matching_enabled !== false}
              onChange={v => updateCfg({ map_matching_enabled: v })}
            />
          </SettingRow>
          <div className="px-1 py-3 border-b border-border/50">
            <div className="mb-1 text-xs font-medium">OSRM endpoint</div>
            <input
              value={cfg.osrm_map_matching_url || 'https://router.project-osrm.org'}
              onChange={event => updateCfg({ osrm_map_matching_url: event.target.value })}
              disabled={cfg.map_matching_enabled === false}
              className="w-full rounded-xl border border-border bg-card px-3 py-2 text-xs disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-muted-foreground">Use a self-hosted OSRM server for production privacy and reliability.</p>
          </div>
          <SettingRow
            icon={Target}
            label="Predictive route risk"
            sublabel="Estimate safest route window from history, danger zones, and context"
          >
            <Toggle
              value={cfg.predictive_route_risk_enabled !== false}
              onChange={v => updateCfg({ predictive_route_risk_enabled: v })}
            />
          </SettingRow>
          <SettingRow
            icon={Volume2}
            label="Live voice alerts"
            sublabel="Speak urgent coaching alerts on device"
          >
            <Toggle
              value={cfg.voice_alerts_enabled !== false}
              onChange={v => updateCfg({ voice_alerts_enabled: v })}
            />
          </SettingRow>
          <SettingRow
            icon={Bluetooth}
            label="OBD-II Bluetooth"
            sublabel={obdSupport.supported ? 'BLE OBD-II parsing is available for compatible adapters' : obdSupport.note}
          >
            <div className="flex items-center gap-2">
              <button
                className="text-xs font-semibold text-primary disabled:text-muted-foreground"
                disabled={!obdSupport.supported}
                onClick={async e => {
                  e.stopPropagation();
                  await handleObdPairing();
                }}
              >
                Pair
              </button>
              <Toggle
                value={cfg.obd_bluetooth_enabled === true}
                onChange={v => updateCfg({ obd_bluetooth_enabled: v })}
                disabled={!obdSupport.supported}
              />
            </div>
          </SettingRow>
          {obdPairingStatus && (
            <div className="px-1 pb-3 text-xs text-muted-foreground">
              {obdPairingStatus}
            </div>
          )}
        </div>

        {/* Phone Use Detection */}
        <SectionTitle>Phone Use Detection</SectionTitle>
        <div className="rounded-2xl bg-secondary/40 p-3">
          <SettingRow
            icon={Focus}
            label="Detect phone use while driving"
            sublabel="Use Android Usage Access when allowed, with GPS behaviour signals as a fallback"
          >
            <Toggle
              value={cfg.phone_use_detection_enabled !== false}
              onChange={v => updateCfg({ phone_use_detection_enabled: v })}
            />
          </SettingRow>
          <div className={`${cfg.phone_use_detection_enabled === false ? 'pointer-events-none opacity-50' : ''}`}>
            <SettingRow
              label="Phone use live alert"
              sublabel="Send an immediate warning when phone-use patterns are detected"
            >
              <Toggle
                value={cfg.phone_use_live_alert_enabled !== false}
                onChange={v => updateCfg({ phone_use_live_alert_enabled: v, notif_phone_use_alert_enabled: v })}
                disabled={cfg.phone_use_detection_enabled === false}
              />
            </SettingRow>
            <div className="px-1 py-3 border-b border-border/50">
              <div className="mb-2 text-sm font-medium">Detection sensitivity</div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'low', label: 'Low', sub: 'Fewer false positives' },
                  { id: 'medium', label: 'Medium', sub: 'Recommended' },
                  { id: 'high', label: 'High', sub: 'More sensitive' },
                ].map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => updateCfg({ phone_use_sensitivity: option.id })}
                    disabled={cfg.phone_use_detection_enabled === false}
                    className={`rounded-xl border p-2 text-left transition-all disabled:opacity-50 ${
                      (cfg.phone_use_sensitivity || 'medium') === option.id
                        ? 'border-primary bg-primary/5 text-primary'
                        : 'border-border text-muted-foreground hover:border-primary/40'
                    }`}
                  >
                    <div className="text-xs font-semibold">{option.label}</div>
                    <div className="mt-0.5 text-[11px]">{option.sub}</div>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Threshold: {(cfg.phone_use_sensitivity || 'medium') === 'low' ? '0.60' : (cfg.phone_use_sensitivity || 'medium') === 'high' ? '0.25' : '0.40'} confidence.
              </p>
            </div>
            <SettingRow label="Show on trip map" sublabel="Mark suspected phone-use windows on route maps">
              <Toggle
                value={cfg.phone_use_show_on_map !== false}
                onChange={v => updateCfg({ phone_use_show_on_map: v })}
                disabled={cfg.phone_use_detection_enabled === false}
              />
            </SettingRow>
            <SettingRow label="Include in trip score" sublabel="Apply phone-use penalties to the Safety score">
              <Toggle
                value={cfg.phone_use_affects_score !== false}
                onChange={v => updateCfg({ phone_use_affects_score: v })}
                disabled={cfg.phone_use_detection_enabled === false}
              />
            </SettingRow>
            <div className="mt-3 flex items-start gap-2 rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              For real phone activity detection on Android, enable Phone Usage Access above. Without it, DriveSense falls back to GPS behaviour patterns only.
            </div>
            <div className="mt-3 rounded-2xl border border-border bg-card p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">Expert phone-use tuning</div>
                  <div className="text-xs text-muted-foreground">Backend detection knobs exposed for calibration and testing.</div>
                </div>
                <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${thresholdEditingEnabled ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200' : 'bg-secondary text-muted-foreground'}`}>
                  {thresholdEditingEnabled ? 'Editable' : 'Locked'}
                </span>
              </div>
              <div className="space-y-3">
                {[
                  { key: 'phone_micro_steer_count', label: 'Micro-steer count', min: 2, max: 8, step: 1, unit: 'turns' },
                  { key: 'phone_creep_rate_kmh_s', label: 'Speed creep rate', min: 0.5, max: 4, step: 0.25, unit: 'km/h/s' },
                  { key: 'phone_lane_drift_deg', label: 'Lane drift angle', min: 3, max: 18, step: 1, unit: 'deg' },
                  { key: 'phone_coupling_threshold', label: 'Coupling threshold', min: 0.05, max: 0.4, step: 0.05, unit: '' },
                  { key: 'phone_confidence_threshold', label: 'Confidence threshold', min: 0.15, max: 0.8, step: 0.05, unit: '' },
                  { key: 'phone_min_window_s', label: 'Minimum window', min: 2, max: 12, step: 1, unit: 's' },
                ].map(({ key, label, min, max, step, unit }) => (
                  <div key={key}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="font-medium">{label}</span>
                      <span className="font-semibold text-primary">{cfg[key]} {unit}</span>
                    </div>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={cfg[key]}
                      disabled={!thresholdEditingEnabled || cfg.phone_use_detection_enabled === false}
                      onChange={e => updateCfg({ [key]: Number(e.target.value) })}
                      className="w-full accent-primary disabled:opacity-45"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Speed Warning */}
        <SectionTitle>Speed Warning</SectionTitle>
        <SettingRow
          icon={Bell}
          label="Live Speed Warning"
          sublabel={cfg.speed_warning_enabled === false ? 'Dashboard speed warnings are disabled' : 'Warn during a trip when speed exceeds the fallback limit plus margin'}
        >
          <Toggle
            value={cfg.speed_warning_enabled !== false}
            onChange={v => updateCfg({ speed_warning_enabled: v })}
          />
        </SettingRow>
        <SettingRow
          icon={Gauge}
          label="OpenStreetMap speed limits"
          sublabel="Use Overpass maxspeed tags after trips; fallback thresholds fill gaps"
        >
          <Toggle
            value={cfg.speed_limit_lookup_enabled !== false}
            onChange={v => updateCfg({ speed_limit_lookup_enabled: v })}
          />
        </SettingRow>
        <SettingRow
          icon={Droplets}
          label="Weather-aware scoring"
          sublabel="Use Open-Meteo rain, snow, fog, and temperature context"
        >
          <Toggle
            value={cfg.weather_context_enabled !== false}
            onChange={v => updateCfg({ weather_context_enabled: v })}
          />
        </SettingRow>
        <div className="px-1">
          <div className="flex justify-between text-xs mb-1.5">
            <span className="font-medium">Warn when over limit by</span>
            <span className="text-primary font-semibold">+{cfg.threshold_speed_over_kmh ?? 10} km/h</span>
          </div>
          <input
            type="range" min={5} max={30} step={5}
            value={cfg.threshold_speed_over_kmh ?? 10}
            disabled={cfg.speed_warning_enabled === false}
            onChange={e => updateCfg({ threshold_speed_over_kmh: parseFloat(e.target.value) })}
            className="w-full accent-primary disabled:opacity-45"
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
          <div className="my-3 rounded-2xl border border-border bg-secondary/30 p-3">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <MapPin className="h-4 w-4 text-primary" />
                  Privacy Zones
                </div>
                <div className="mt-1 text-xs text-muted-foreground">Mask sensitive places from maps, CSV exports, and backups.</div>
              </div>
              <span className="rounded-full bg-card px-2 py-1 text-xs font-semibold">{privacyZones.length}</span>
            </div>
            <div className="grid grid-cols-[1fr_92px] gap-2">
              <input
                value={privacyDraft.label}
                onChange={(event) => setPrivacyDraft((draft) => ({ ...draft, label: event.target.value }))}
                className="rounded-xl border border-border bg-card px-3 py-2 text-sm"
                placeholder="Home, work, school"
              />
              <input
                type="number"
                min="50"
                max="1000"
                step="10"
                value={privacyDraft.radius_m}
                onChange={(event) => setPrivacyDraft((draft) => ({ ...draft, radius_m: Number(event.target.value) || 180 }))}
                className="rounded-xl border border-border bg-card px-3 py-2 text-sm"
                aria-label="Privacy zone radius in meters"
              />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={addCurrentPrivacyZone}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
              >
                <LocateFixed className="h-3.5 w-3.5" />
                Add Current
              </button>
              <button
                type="button"
                onClick={() => savePrivacyZone(parkedLocation, 'Parked location')}
                disabled={!parkedLocation}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-semibold disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Parked
              </button>
            </div>
            {privacyZones.length > 0 && (
              <div className="mt-3 space-y-2">
                {privacyZones.map((zone) => (
                  <div key={zone.id} className="flex items-center justify-between gap-2 rounded-xl bg-card px-3 py-2 text-xs">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{zone.label}</div>
                      <div className="text-muted-foreground">{Math.round(zone.radius_m)} m mask radius</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => deletePrivacyZone(zone.id)}
                      className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-red-500"
                      aria-label={`Delete ${zone.label} privacy zone`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <SettingRow
            icon={Download}
            label="Export All Trips"
            sublabel="Download as CSV file"
            onClick={handleExportAll}
          >
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </SettingRow>
          <SettingRow
            icon={Download}
            label="Export Full Backup"
            sublabel="JSON with trips, GPS route points, events, vehicles, and settings"
            onClick={handleExportBackup}
          >
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </SettingRow>
          <SettingRow
            icon={Upload}
            label="Import Backup"
            sublabel="Restore a DriveSense JSON backup into local storage"
            onClick={() => importInputRef.current?.click()}
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

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportBackup}
      />

      <Dialog open={patternGuideOpen} onOpenChange={setPatternGuideOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto rounded-2xl">
          <DialogHeader>
            <DialogTitle>Driving Pattern Definitions</DialogTitle>
            <DialogDescription>
              These metrics summarize patterns from GPS speed, route shape, timing, and detected driving events.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {DRIVING_PATTERN_DEFINITIONS.map(({ term, definition }) => (
              <div key={term} className="rounded-xl border border-border bg-secondary/40 p-3">
                <div className="text-sm font-semibold">{term}</div>
                <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{definition}</div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

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
