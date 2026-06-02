import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import {
  Moon, Sun, Monitor, Trash2, Download, Upload, Shield, ChevronRight, Info, AlertTriangle, Check, Bell, Clock, Lock, Unlock, SlidersHorizontal, Focus, MapPin, Plus, LocateFixed, Gauge, Droplets, Bluetooth, Volume2, Route, Target, Search, X, Leaf, Zap, Banknote, Smartphone
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui/use-toast';
import { logError } from '@/lib/errorReporting';
import { activeTripStore, applyThemeMode, getLastParkedLocation, localSettings, validateSettingsPatch } from '@/lib/trackingStore';
import { NIGHT_END_TIME, NIGHT_START_TIME } from '@/lib/appConstants';
import { downloadCSV, tripsToCSV } from '@/engine/export/index.js';
import { buildDrivingThresholds, SCORING_VERSION } from '@/lib/scoring/componentScores';
import {
  AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO,
  AUTO_RESCORE_RECENT_WINDOW_DAYS,
  enforceDataRetention,
  RESCORE_PROGRESS_EVENT,
  TRIP_EVENT_MIGRATION_KEY,
  TRIP_EVENT_MIGRATION_NOTE_DISMISSED_KEY,
  TRIP_EVENT_MIGRATION_VERSION,
} from '@/lib/localTripRepository';
import { getJson, setJson } from '@/lib/mobileStorage';
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
import {
  BACKUP_INTEGRITY_ERROR,
  BACKUP_TOO_LARGE_MESSAGE,
  exportDriveSenseBackup,
  importDriveSenseBackup,
  MAX_BACKUP_BYTES,
} from '@/lib/dataBackup';
import { COMMUTE_MATCH_RADIUS_M } from '@/lib/mediumInsights';
import {
  applyCalibrationProfile,
  clearCalibrationProfile,
  computeCalibrationProfile,
  loadCalibrationProfile,
  saveCalibrationProfile,
} from '@/lib/thresholdCalibration';
import { getCurrentLocation } from '@/lib/trackingService';
import { getPrivacyZones, removePrivacyZone, upsertPrivacyZone } from '@/lib/privacyZones';
import { invalidateRouteRiskIndex } from '@/lib/routeRiskIndex';
import { connectObdBleAdapter, getObdBluetoothSupport } from '@/lib/obdBluetooth';
import { getMotionSensorSupport, requestMotionSensorPermission } from '@/lib/sensorFusionModel';
import { testVoiceAlert } from '@/lib/voiceAlerts';
import { PUBLIC_OSRM_DEMO_URL, isPublicOsrmDemoUrl } from '@/lib/osrmPrivacy';
import { checkOsrmEndpointHealth, buildOsrmHealthPatch } from '@/lib/osrmEndpointHealth';
import { hasVerifiedOsrmEndpoint } from '@/lib/osrmEndpointTrust';
import { CURRENCY_SYMBOL_OPTIONS } from '@/lib/currency';
import {
  SPEED_LIMIT_DEFAULT_COUNTRY_LABELS,
  speedLimitDefaultCountryKey,
} from '@/lib/speedLimitSource';
import CalibrationStatusTag from '@/components/CalibrationStatusTag';
import { useSettingsSections } from '@/features/settings/hooks/useSettingsSections';
import { SettingsNavigator } from '@/settings/SettingsNavigator';
import { LEGAL_DISCLAIMER_SUMMARY } from '@/lib/legalDisclaimers';
import {
  CALIBRATION_STATUSES,
  SCORING_CONSTANTS,
  calibrationEntryForSetting,
  getProvisionalScoringConstants,
  scoringValue,
} from '@/lib/scoringConstants';
import { SCORE_ESTIMATE_NOTICE } from '@/lib/scoreDisplay';
import {
  getEphemeralTripModeState,
  setStealthNextTrip,
  subscribeEphemeralTripMode,
} from '@/lib/ephemeralTripMode';

function SectionTitle({ children, id }) {
  return <div id={id} className="scroll-mt-24 text-xs font-bold uppercase tracking-widest text-muted-foreground px-1 mb-2 mt-6">{children}</div>;
}

function SettingRow({ icon: Icon = null, label, sublabel = '', children = null, onClick = null, danger = false }) {
  return (
    <div
      className={`flex items-center justify-between gap-3 py-3 px-1 border-b border-border/50 last:border-0 ${onClick ? 'cursor-pointer hover:bg-secondary/50 rounded-xl -mx-1 px-2 transition-colors' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {Icon && (
          <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${danger ? 'bg-red-50 dark:bg-red-950/30' : 'bg-secondary'}`}>
            <Icon className={`w-4 h-4 ${danger ? 'text-red-500' : 'text-muted-foreground'}`} />
          </div>
        )}
        <div className="min-w-0">
          <div className={`break-words text-sm font-medium ${danger ? 'text-red-600 dark:text-red-400' : ''}`}>{label}</div>
          {sublabel && <div className="mt-0.5 break-words text-xs text-muted-foreground">{sublabel}</div>}
        </div>
      </div>
      <div className="flex-shrink-0 max-w-[46%]">{children}</div>
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
    definition: 'Rates hard acceleration, harsh braking, speed creep, and jerk. GPS overtake patterns are Beta diagnostics and do not affect this score.',
  },
  {
    term: 'Defensive score',
    definition: 'Blends only observed defensive-driving evidence such as smooth stops, approach-stop behavior, speed variability, and GPS-only stop-start patterns. It does not score following distance.',
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
    term: 'Stop-start pattern score',
    definition: 'Looks for repeated acceleration and deceleration patterns in GPS speed data. It cannot measure actual following distance and is shown only with enough contextual evidence: 2 km for city-speed trips or 5 km for highway trips.',
  },
  {
    term: 'Focus score',
    definition: 'Uses Android Usage Access evidence for phone-use scoring. GPS micro-steering patterns are diagnostic only and never reduce this score.',
  },
  {
    term: 'Approach-stop estimate',
    definition: 'Scores observed low-speed approaches and stops lasting at least four seconds below 10 km/h, including rolling stops. Trips without enough evidence show no approach-stop estimate.',
  },
  {
    term: 'Heading drift (Beta)',
    definition: 'Flags sustained GPS heading-drift patterns during highway-speed travel. It is an attention pattern signal from GPS only, uses a late-night time multiplier, and is not a fatigue measurement.',
  },
  {
    term: 'Braking and cornering scores',
    definition: 'Estimated from GPS speed and heading data. They are suppressed from composite scores when trip confidence is below 0.5.',
  },
  {
    term: 'Inferred speed limits',
    definition: 'Fallback limits are estimated from road type and the configured country default when OSM maxspeed data is unavailable. Inferred-limit speeding penalties use half weight and may not reflect the actual legal limit.',
  },
  {
    term: 'Parking approach',
    definition: 'Scores the final low-speed part of a trip for smooth deceleration instead of abrupt stopping near the destination.',
  },
];

const PRIVACY_RADIUS_MIN_M = 50;
const PRIVACY_RADIUS_MAX_M = 1000;
const RECOMMENDED_PRIVACY_RADIUS_M = 200;
const PRIVACY_RADIUS_DEFAULT_M = RECOMMENDED_PRIVACY_RADIUS_M;
const PROVISIONAL_SCORING_CONSTANTS = getProvisionalScoringConstants();
const PENALTY_SCALE_CALIBRATION = Object.freeze({
  key: 'PENALTY_SCALE_FACTOR',
  ...SCORING_CONSTANTS.PENALTY_SCALE_FACTOR,
});

function calibrationStatusLabel(status) {
  return status === CALIBRATION_STATUSES.PROVISIONAL ? 'Provisional' : status;
}

function validatePrivacyRadius(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return { valid: false, error: `Enter a radius between ${PRIVACY_RADIUS_MIN_M} and ${PRIVACY_RADIUS_MAX_M} meters.` };
  }

  const number = Number(raw);
  if (!Number.isFinite(number)) {
    return { valid: false, error: 'Radius must be a number in meters.' };
  }

  if (number < PRIVACY_RADIUS_MIN_M || number > PRIVACY_RADIUS_MAX_M) {
    return { valid: false, error: `Radius must be between ${PRIVACY_RADIUS_MIN_M} and ${PRIVACY_RADIUS_MAX_M} meters.` };
  }

  return { valid: true, radius: Math.round(number), error: '' };
}

export default function Settings() {
  const [saved, setSaved] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState(null);
  const [nativeTrackingStatus, setNativeTrackingStatus] = useState(null);
  const [batteryStatus, setBatteryStatus] = useState(null);
  const [patternGuideOpen, setPatternGuideOpen] = useState(false);
  const [calibProfile, setCalibProfile] = useState(null);
  const [calibLoading, setCalibLoading] = useState(false);
  const [parkedLocation, setParkedLocation] = useState(null);
  const [privacyDraft, setPrivacyDraft] = useState({ label: 'Private place', radius_m: String(PRIVACY_RADIUS_DEFAULT_M) });
  const [privacyRadiusDrafts, setPrivacyRadiusDrafts] = useState({});
  const [privacyDraftRadiusError, setPrivacyDraftRadiusError] = useState('');
  const [privacyZoneRadiusErrors, setPrivacyZoneRadiusErrors] = useState({});
  const [obdPairingStatus, setObdPairingStatus] = useState('');
  const [voiceTestStatus, setVoiceTestStatus] = useState('');
  const [settingsSearch, setSettingsSearch] = useState('');
  const [rescoreStatus, setRescoreStatus] = useState('');
  const [ephemeralModeState, setEphemeralModeState] = useState(() => getEphemeralTripModeState());
  const [rescoreProgress, setRescoreProgress] = useState(null);
  const [headingEventMigrationNoteVisible, setHeadingEventMigrationNoteVisible] = useState(false);
  const [osrmConsentOpen, setOsrmConsentOpen] = useState(false);
  const [osrmConsentChecked, setOsrmConsentChecked] = useState(false);
  const [osrmPendingEndpoint, setOsrmPendingEndpoint] = useState('');
  const [backupExportOpen, setBackupExportOpen] = useState(false);
  const [backupExportPassword, setBackupExportPassword] = useState('');
  const [backupExportConfirm, setBackupExportConfirm] = useState('');
  const [backupExportBusy, setBackupExportBusy] = useState(false);
  const [backupImportOpen, setBackupImportOpen] = useState(false);
  const [backupImportPassword, setBackupImportPassword] = useState('');
  const [backupImportError, setBackupImportError] = useState('');
  const [pendingBackupImportFile, setPendingBackupImportFile] = useState(null);
  const [backupImportBusy, setBackupImportBusy] = useState(false);
  const [osrmEndpointDraft, setOsrmEndpointDraft] = useState(() => localSettings.get().osrm_map_matching_url || '');
  const [osrmHealthCheckState, setOsrmHealthCheckState] = useState('idle');
  const importInputRef = useRef(null);
  const qc = useQueryClient();

  // Load settings from local storage
  const [cfg, setCfg] = useState(() => localSettings.get());
  const [thresholdEditingEnabled, setThresholdEditingEnabled] = useState(false);

  const { data: allTrips = [] } = useQuery({
    queryKey: ['settings-trips'],
    queryFn: () => tripService.listAll({ sort: '-start_time' }),
  });

  const { data: scoreMigrationSummary = {
    scoring_version: SCORING_VERSION,
    completed_count: 0,
    mismatch_count: 0,
    recent_window_days: AUTO_RESCORE_RECENT_WINDOW_DAYS,
    recent_completed_count: 0,
    recent_mismatch_count: 0,
    recent_mismatch_ratio: 0,
    auto_rescore_threshold_ratio: AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO,
    auto_rescore_recommended: false,
    unavailable_score_count: 0,
    event_migration_version: 0,
    trips: [],
  } } = useQuery({
    queryKey: ['score-migration-summary'],
    queryFn: () => tripService.getScoreMigrationSummary(),
  });

  const { data: allVehicles = [] } = useQuery({
    queryKey: ['settings-vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 200 }),
  });

  const updateCfg = (patch) => {
    const validation = validateSettingsPatch(patch);
    if (!validation.valid) {
      toast({
        title: 'Setting not saved',
        description: validation.errors[0],
        variant: 'destructive',
      });
      return cfg;
    }
    const nextCfg = { ...cfg, ...patch };
    const touchesEcoMultipliers = Object.prototype.hasOwnProperty.call(patch, 'eco_cruise_score_multiplier') ||
      Object.prototype.hasOwnProperty.call(patch, 'eco_idle_penalty_multiplier');
    if (touchesEcoMultipliers && wouldDisableEcoScore(nextCfg)) {
      toast({
        title: 'Eco setting not saved',
        description: 'Eco scoring needs either the cruise multiplier or idle multiplier above 0.',
        variant: 'destructive',
      });
      return cfg;
    }
    const updated = localSettings.update(patch);
    setCfg(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    return updated;
  };

  useEffect(() => {
    setOsrmEndpointDraft(cfg.osrm_map_matching_url || '');
  }, [cfg.osrm_map_matching_url]);

  useEffect(() => subscribeEphemeralTripMode(setEphemeralModeState), []);

  useEffect(() => {
    let active = true;
    Promise.all([
      getJson(TRIP_EVENT_MIGRATION_KEY, 0),
      getJson(TRIP_EVENT_MIGRATION_NOTE_DISMISSED_KEY, false),
    ]).then(([version, dismissed]) => {
      if (!active) return;
      setHeadingEventMigrationNoteVisible(
        Number(version || scoreMigrationSummary.event_migration_version || 0) >= TRIP_EVENT_MIGRATION_VERSION &&
        dismissed !== true
      );
    });
    return () => {
      active = false;
    };
  }, [scoreMigrationSummary.event_migration_version]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onProgress = (event) => {
      const detail = event.detail || {};
      setRescoreProgress(detail);
      if (detail.status === 'running') {
        setRescoreStatus(detail.reason === 'auto_provenance'
          ? `Updating older trip scores ${detail.completed || 0}/${detail.total || 0}.`
          : `Refreshing stored trip scores ${detail.completed || 0}/${detail.total || 0}.`);
      }
      if (detail.status === 'complete') {
        setRescoreStatus(`${detail.completed || 0} trip${detail.completed === 1 ? '' : 's'} re-scored.`);
        qc.invalidateQueries({ queryKey: ['settings-trips'] });
        qc.invalidateQueries({ queryKey: ['score-migration-summary'] });
        setTimeout(() => {
          setRescoreProgress(null);
          setRescoreStatus('');
        }, 5000);
      }
    };
    window.addEventListener(RESCORE_PROGRESS_EVENT, onProgress);
    return () => window.removeEventListener(RESCORE_PROGRESS_EVENT, onProgress);
  }, [qc]);

  const dismissHeadingEventMigrationNote = async () => {
    await setJson(TRIP_EVENT_MIGRATION_NOTE_DISMISSED_KEY, true);
    setHeadingEventMigrationNoteVisible(false);
  };

  const enableOsrmMapMatching = (enabled) => {
    if (!enabled) {
      updateCfg({ map_matching_enabled: false });
      return;
    }
    if (!hasVerifiedOsrmEndpoint(cfg)) {
      toast({
        title: 'OSRM endpoint not ready',
        description: 'Save a trusted OSRM endpoint that passes the OSRM OPTIONS health check before route snapping can run.',
        variant: 'destructive',
      });
      return;
    }
    updateCfg({ map_matching_enabled: true });
  };

  const runOsrmEndpointHealthCheck = async (endpoint) => {
    setOsrmHealthCheckState('checking');
    const result = await checkOsrmEndpointHealth(endpoint);
    const patch = buildOsrmHealthPatch(result);
    setOsrmHealthCheckState('idle');
    return { result, patch };
  };

  const saveOsrmEndpoint = async (endpoint, consented = false) => {
    const value = String(endpoint || '').trim().replace(/\/$/, '');
    if (!value) {
      updateCfg({
        map_matching_enabled: false,
        osrm_map_matching_url: '',
        osrm_public_demo_consent_at: '',
        osrm_data_sharing_consented: false,
        osrm_data_sharing_consented_at: '',
        osrm_health_status: '',
        osrm_last_health_checked_at: '',
        osrm_last_reachable_at: '',
        osrm_last_health_error: '',
      });
      return;
    }
    if (isPublicOsrmDemoUrl(value)) {
      toast({
        title: 'Public demo not saved',
        description: `Use a private or trusted OSRM endpoint. ${PUBLIC_OSRM_DEMO_URL} is shown only as an example.`,
        variant: 'destructive',
      });
      return;
    }
    try {
      new URL(value);
    } catch {
      toast({
        title: 'Endpoint not saved',
        description: 'Enter a valid OSRM URL, such as https://your-osrm.example.',
        variant: 'destructive',
      });
      return;
    }
    if (!consented) {
      setOsrmPendingEndpoint(value);
      setOsrmConsentChecked(false);
      setOsrmConsentOpen(true);
      return;
    }

    const consentedAt = new Date().toISOString();
    const { result, patch } = await runOsrmEndpointHealthCheck(value);
    if (!result.ok) {
      toast({
        title: 'Endpoint not saved',
        description: result.error,
        variant: 'destructive',
      });
      return;
    }
    updateCfg({
      map_matching_enabled: true,
      osrm_map_matching_url: value,
      osrm_public_demo_consent_at: '',
      osrm_data_sharing_consented: true,
      osrm_data_sharing_consented_at: consentedAt,
      ...patch,
    });
    toast({
      title: 'OSRM endpoint connected',
      description: 'Route snapping can use this endpoint when you tap Get Road Data.',
    });
  };

  const requestSaveOsrmEndpoint = () => {
    const value = String(osrmEndpointDraft || '').trim().replace(/\/$/, '');
    const alreadyConsentedForEndpoint = cfg.osrm_data_sharing_consented === true && cfg.osrm_map_matching_url === value;
    saveOsrmEndpoint(value, alreadyConsentedForEndpoint);
  };

  const acceptOsrmDataSharingConsent = () => {
    if (!osrmConsentChecked || !osrmPendingEndpoint) return;
    const endpoint = osrmPendingEndpoint;
    setOsrmConsentOpen(false);
    setOsrmConsentChecked(false);
    setOsrmPendingEndpoint('');
    saveOsrmEndpoint(endpoint, true);
  };

  const updateExternalContextAutoFetch = (enabled) => {
    if (!enabled) {
      updateCfg({ external_context_auto_fetch_enabled: false });
      return;
    }
    const ok = typeof window === 'undefined' || window.confirm(
      'Automatic road data sends route-area boxes to OpenStreetMap and a privacy-safe route point/date to Open-Meteo whenever a trip is saved. OSRM route snapping still stays manual. Continue?'
    );
    if (!ok) return;
    updateCfg({ external_context_auto_fetch_enabled: true });
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
  const effectiveEcoMultiplier = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  };
  const wouldDisableEcoScore = (settings) => (
    effectiveEcoMultiplier(settings.eco_cruise_score_multiplier) === 0 &&
    effectiveEcoMultiplier(settings.eco_idle_penalty_multiplier) === 0
  );
  const ecoScoreWarning = (key, value = cfg[key]) => {
    if (!['eco_cruise_score_multiplier', 'eco_idle_penalty_multiplier'].includes(key)) return null;
    const next = { ...cfg, [key]: value };
    return wouldDisableEcoScore(next) ? 'Eco score unavailable' : null;
  };

  const updateTheme = (mode) => {
    const updated = updateCfg({ dark_mode: mode });
    applyThemeMode(updated.dark_mode);
  };

  const runVoiceTest = async () => {
    const ok = await testVoiceAlert(cfg);
    setVoiceTestStatus(ok ? 'Voice test sent.' : 'Speech output is unavailable in this browser/WebView.');
    setTimeout(() => setVoiceTestStatus(''), 3000);
  };

  const runCalibration = async () => {
    setCalibLoading(true);
    const trips = await tripService.listAll({ sort: '-start_time' });
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
    const count = await tripService.markCompletedForRescore().catch(() => 0);
    await qc.invalidateQueries();
    setRescoreStatus(count ? `${count} completed trips queued for re-score.` : 'Calibration applied.');
    setCfg(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    setCalibProfile(await loadCalibrationProfile());
  };

  const rescoreTrips = async () => {
    await getPermissionStatus().catch(() => null);
    const onlyProvenanceMismatch = (scoreMigrationSummary.mismatch_count || 0) > 0;
    const count = await tripService.markCompletedForRescore({ onlyProvenanceMismatch });
    await qc.invalidateQueries();
    setRescoreStatus(onlyProvenanceMismatch
      ? `${count} outdated trip${count === 1 ? '' : 's'} queued. Open Trips to refresh scores.`
      : `${count} completed trip${count === 1 ? '' : 's'} queued. Open Trips to refresh scores.`);
    setTimeout(() => setRescoreStatus(''), 5000);
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
        toast({
          title: 'Notification permission needed',
          description: getPermissionExplanation('notifications'),
          variant: 'destructive',
        });
        await refreshPermissions();
        return;
      }
    }

    const updated = updateCfg(patch);
    await syncReminderNotifications(updated);
    await refreshPermissions();
  };

  const updateRetention = async (months) => {
    const updated = updateCfg({ data_retention_months: months });
    const deleted = await enforceDataRetention(updated.data_retention_months);
    if (deleted > 0) {
      logError('data_retention_pruned', new Error('Retention pruning'), { deleted });
    }
    await qc.invalidateQueries();
  };

  const showPrivacyPolicy = () => {
    toast({
      title: 'Privacy, legal, and local data',
      description: `Road Sage stores trip, route, score, vehicle, and settings data locally by default. Optional Get Road Data requests can send route-area boxes to OpenStreetMap, a privacy-safe route point/date to Open-Meteo, and sampled GPS points only to a trusted OSRM endpoint after explicit consent. ${LEGAL_DISCLAIMER_SUMMARY}`,
      duration: 9000,
    });
  };

  const stopNativeAutoTrackingSafely = async (title = 'Auto tracking could not be turned off') => {
    if (!isAndroid()) return true;

    try {
      const stopped = await stopNativeAutoTracking();
      await refreshPermissions();
      if (stopped !== true) {
        throw new Error('Android did not confirm that native auto tracking stopped.');
      }
      return true;
    } catch (error) {
      toast({
        title,
        description: error.message || 'Check Android permissions and try again.',
        variant: 'destructive',
      });
      await refreshPermissions();
      return false;
    }
  };

  const stealthTripToggleDisabled = ephemeralModeState.ephemeralActive || Boolean(activeTripStore.get());
  const setStealthNextTripEnabled = async (enabled) => {
    if (stealthTripToggleDisabled) return;
    const nextEnabled = enabled === true;
    if (nextEnabled && isAndroid()) {
      const stopped = await stopNativeAutoTrackingSafely('Stealth mode could not pause background tracking');
      if (!stopped) return;
    }
    setStealthNextTrip(nextEnabled);
  };

  const updateTrackingPaused = async (paused) => {
    const updated = updateCfg({ tracking_paused: paused });
    if (!isAndroid()) return;

    if (paused) {
      const stopped = await stopNativeAutoTrackingSafely('Auto tracking could not be paused');
      if (!stopped) updateCfg({ tracking_paused: false });
      return;
    }

    if (updated.tracking_mode === 'background_auto') {
      try {
        await startNativeAutoTracking();
        await refreshPermissions();
      } catch (error) {
        updateCfg({ tracking_paused: true });
        toast({
          title: 'Background tracking could not resume',
          description: error.message || 'Check Location, Physical Activity, Notifications, and Battery Optimization settings.',
          variant: 'destructive',
        });
        await refreshPermissions();
      }
    }
  };

  const enableTrackingMode = async (mode) => {
    if (cfg.tracking_paused && mode !== 'manual') {
      updateCfg({ tracking_paused: false });
    }

    if (mode === 'manual') {
      const stopped = await stopNativeAutoTrackingSafely('Manual mode could not stop background tracking');
      if (!stopped) return;
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
      toast({
        title: 'Location permission needed',
        description: getPermissionExplanation('foregroundLocation'),
        variant: 'destructive',
      });
      await refreshPermissions();
      return;
    }

    const activityGranted = !isAndroid() || await requestActivityRecognitionPermission();
    if (!activityGranted) {
      toast({
        title: 'Activity permission needed',
        description: getPermissionExplanation('activityRecognition'),
        variant: 'destructive',
      });
      await refreshPermissions();
      return;
    }

    if (mode === 'background_auto') {
      const backgroundGranted = await requestBackgroundLocationPermission();
      if (!backgroundGranted) {
        toast({
          title: 'Background location needed',
          description: 'Android requires Location permission set to "Allow all the time" for background auto tracking. Open app permissions, update Location, then return to Road Sage.',
          variant: 'destructive',
          duration: 9000,
        });
        await refreshPermissions();
        return;
      }

      if (isAndroid()) {
        try {
          await startNativeAutoTracking();
        } catch (error) {
          toast({
            title: 'Background tracking could not start',
            description: error.message || 'Check Location, Physical Activity, Notifications, and Battery Optimization settings.',
            variant: 'destructive',
          });
          await refreshPermissions();
          return;
        }
      }
    }

    if (mode !== 'background_auto') {
      const stopped = await stopNativeAutoTrackingSafely('Background tracking could not be turned off');
      if (!stopped) return;
    }
    updateCfg({
      tracking_mode: mode,
      auto_tracking_enabled: mode !== 'manual',
      background_tracking_enabled: mode === 'background_auto',
      tracking_paused: false,
    });
    await refreshPermissions();
  };

  const refreshPermissions = async () => {
    const status = await getPermissionStatus();
    setPermissionStatus(status);

    if (isAndroid()) {
      try {
        setNativeTrackingStatus(await getNativeAutoTrackingStatus());
      } catch (err) {
        logError('settings_native_tracking_status', err);
      }
      try {
        setBatteryStatus(await getAndroidBatteryOptimizationStatus());
      } catch (err) {
        logError('settings_battery_optimization_status', err);
      }
    }
  };

  const refreshSettingsFromNative = async ({ restartIfReady = false } = {}) => {
    const latest = await localSettings.hydrateFromNative();
    setCfg((current) => (
      JSON.stringify(current) === JSON.stringify(latest) ? current : latest
    ));
    await refreshPermissions();

    if (restartIfReady && isAndroid() && latest.tracking_mode === 'background_auto' && !latest.tracking_paused) {
      try {
        await startNativeAutoTracking();
        setNativeTrackingStatus(await getNativeAutoTrackingStatus());
      } catch (err) {
        logError('native_auto_tracking_start_settings_refresh', err, { mode: latest.tracking_mode });
      }
    }
    return latest;
  };

  useEffect(() => {
    refreshSettingsFromNative();
    loadCalibrationProfile().then(setCalibProfile);
    getLastParkedLocation().then(setParkedLocation);
  }, []);

  const privacyZones = getPrivacyZones(cfg);

  const commitPrivacyDraftRadius = () => {
    const validation = validatePrivacyRadius(privacyDraft.radius_m);
    if (!validation.valid) {
      setPrivacyDraftRadiusError(validation.error);
      return false;
    }

    setPrivacyDraftRadiusError('');
    setPrivacyDraft((draft) => ({
      ...draft,
      radius_m: String(validation.radius),
    }));
    return true;
  };

  const savePrivacyZone = (location, sourceLabel) => {
    const validation = validatePrivacyRadius(privacyDraft.radius_m);
    if (!validation.valid) {
      setPrivacyDraftRadiusError(validation.error);
      toast({
        title: 'Privacy zone radius needs fixing',
        description: validation.error,
        variant: 'destructive',
      });
      return;
    }

    const lat = Number(location?.lat);
    const lng = Number(location?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      toast({
        title: 'No location available',
        description: 'Try again after Road Sage has a current or parked location.',
        variant: 'destructive',
      });
      return;
    }
    setPrivacyDraftRadiusError('');
    const updated = upsertPrivacyZone({
      label: privacyDraft.label || sourceLabel,
      radius_m: validation.radius,
      lat,
      lng,
    }, cfg);
    void invalidateRouteRiskIndex();
    setCfg(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const addCurrentPrivacyZone = async () => {
    try {
      const location = await getCurrentLocation();
      savePrivacyZone(location, 'Current location');
    } catch (error) {
      toast({
        title: 'Could not get current location',
        description: error.message || 'Check location permission and GPS availability.',
        variant: 'destructive',
      });
    }
  };

  const deletePrivacyZone = (id) => {
    const updated = removePrivacyZone(id, cfg);
    void invalidateRouteRiskIndex();
    setCfg(updated);
    setPrivacyRadiusDrafts((drafts) => {
      const next = { ...drafts };
      delete next[id];
      return next;
    });
    setPrivacyZoneRadiusErrors((errors) => {
      const next = { ...errors };
      delete next[id];
      return next;
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const updatePrivacyZoneRadius = (zone, rawValue) => {
    const validation = validatePrivacyRadius(rawValue);
    if (!validation.valid) {
      setPrivacyZoneRadiusErrors((errors) => ({ ...errors, [zone.id]: validation.error }));
      toast({
        title: 'Privacy zone radius needs fixing',
        description: validation.error,
        variant: 'destructive',
      });
      return;
    }

    const radius = validation.radius;
    const updated = upsertPrivacyZone({ ...zone, radius_m: radius }, cfg);
    void invalidateRouteRiskIndex();
    setCfg(updated);
    setPrivacyRadiusDrafts((drafts) => ({ ...drafts, [zone.id]: String(radius) }));
    setPrivacyZoneRadiusErrors((errors) => {
      const next = { ...errors };
      delete next[zone.id];
      return next;
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  useEffect(() => {
    if (!isAndroid()) return undefined;

    const refreshAndRestartIfReady = async () => {
      await refreshSettingsFromNative({ restartIfReady: true });
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshAndRestartIfReady();
    };
    const interval = window.setInterval(refreshAndRestartIfReady, 2000);
    window.addEventListener('focus', refreshAndRestartIfReady);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshAndRestartIfReady);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const handleBatteryOptimization = async () => {
    try {
      await openAndroidBatteryOptimizationSettings();
      await refreshPermissions();
    } catch {
      toast({
        title: 'Battery settings unavailable',
        description: 'Open Android Settings > Apps > Road Sage > Battery and choose Unrestricted.',
        variant: 'destructive',
      });
    }
  };

  const handleMotionPermission = async () => {
    const granted = await requestMotionSensorPermission();
    await refreshPermissions();
    if (!granted) {
      toast({
        title: 'Motion permission needed',
        description: getPermissionExplanation('motionSensors'),
        variant: 'destructive',
      });
    }
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
    if (tripService.deleteAll) await tripService.deleteAll();
    else {
      const trips = allTrips;
      for (const t of trips) {
        await tripService.delete(t.id);
      }
    }
    const { SecureKey } = await import('@/lib/nativeSecureKey');
    await SecureKey.wipeAllFiles().catch(() => {});
    qc.invalidateQueries();
    toast({
      title: 'Trips deleted',
      description: 'All local trip history and sensitive native cache files were removed from this device.',
    });
  };

  const handleExportAll = async () => {
    const completed = allTrips.filter(t => t.status === 'completed');
    const csv = tripsToCSV(completed);
    const password = prompt('Create an export password (12+ characters). You will need it to open this file.');
    if (!password) return;
    const result = await downloadCSV(csv, `road-sage-all-trips-${new Date().toISOString().split('T')[0]}.csv`, { password });
    toast({
      title: 'Encrypted export saved',
      description: result?.native
        ? `${result.filename} was saved to Downloads.`
        : `${result?.filename || 'Trip CSV'} is downloading.`,
    });
  };

  const backupPasswordStrong = backupExportPassword.length >= 12;
  const backupPasswordsMatch = backupExportPassword === backupExportConfirm;
  const backupExportReady = backupPasswordStrong && backupPasswordsMatch;
  const backupPasswordStrengthScore = backupExportPassword
    ? [
      backupExportPassword.length >= 12,
      /[a-z]/.test(backupExportPassword) && /[A-Z]/.test(backupExportPassword),
      /\d/.test(backupExportPassword),
      /[^A-Za-z0-9]/.test(backupExportPassword),
    ].filter(Boolean).length
    : 0;
  const backupPasswordStrengthLabel = backupPasswordStrengthScore >= 4
    ? 'Strong'
    : backupPasswordStrengthScore >= 3
      ? 'Good'
      : backupPasswordStrengthScore >= 2
        ? 'Fair'
        : 'Weak';
  const pendingBackupImportIsEncrypted = /\.rsbackup$/i.test(pendingBackupImportFile?.name || '');

  const showBackupExportToast = (result) => {
    toast({
      title: result?.encrypted ? 'Encrypted backup saved' : 'Backup saved',
      description: result?.nativeFallback
        ? `Could not save to Downloads. ${result?.filename || 'Road Sage backup'} is downloading in the browser instead.`
        : result?.native
        ? `${result.filename} was saved to Downloads.`
        : `${result?.filename || 'Road Sage backup'} is downloading.`,
      variant: result?.nativeFallback ? 'destructive' : undefined,
    });
  };

  const handleExportBackup = () => {
    setBackupExportPassword('');
    setBackupExportConfirm('');
    setBackupExportOpen(true);
  };

  const performExportBackup = async () => {
    if (!backupExportReady || backupExportBusy) return;
    setBackupExportBusy(true);
    try {
      const result = await exportDriveSenseBackup({
        trips: allTrips,
        vehicles: allVehicles,
        settings: cfg,
        password: backupExportPassword,
      });
      setBackupExportOpen(false);
      showBackupExportToast(result);
    } catch (error) {
      toast({
        title: 'Could not export backup',
        description: error.message || 'Try again with a different backup password.',
        variant: 'destructive',
      });
    } finally {
      setBackupExportBusy(false);
    }
  };

  const finishImportBackup = async (file, { password = null, acknowledgeTruncation = false } = {}) => {
    const result = await importDriveSenseBackup(file, { password, acknowledgeTruncation });
    if (result?.error === 'password_required' || result?.error === 'wrong_password') {
      setPendingBackupImportFile(file);
      setBackupImportError(result.error);
      setBackupImportOpen(true);
      return null;
    }
    if (result?.error === BACKUP_INTEGRITY_ERROR) {
      toast({
        title: 'Backup integrity check failed',
        description: /\.rsbackup$/i.test(file?.name || '')
          ? 'This backup file appears to be corrupted.'
          : 'The file may have been modified or exported from another Road Sage install.',
        variant: 'destructive',
      });
      return null;
    }
    if (result.requiresAcknowledgement) {
      const affected = result.truncatedNoteTripCount;
      if (!confirm(`This backup contains notes longer than the supported limit. Importing will truncate notes on ${affected} trip${affected === 1 ? '' : 's'}. Continue?`)) return null;
      return finishImportBackup(file, { password, acknowledgeTruncation: true });
    }
    setCfg(localSettings.get());
    applyThemeMode(localSettings.get().dark_mode);
    await qc.invalidateQueries();
    toast({
      title: 'Import complete',
      description: result.truncatedFields
        ? `${result.trips} trips and ${result.vehicles} vehicles merged. ${result.warnings.join(' ')}`
        : !result.savedFiltersRestored && result.savedFilters
        ? `${result.trips} trips and ${result.vehicles} vehicles merged, but saved filters could not be restored.`
        : result.privacy_zones_need_reconfiguration
        ? `${result.trips} trips and ${result.vehicles} vehicles merged. Re-add ${result.privacy_zones_need_reconfiguration} privacy zone${result.privacy_zones_need_reconfiguration === 1 ? '' : 's'} because backups do not store private coordinates.`
        : `${result.trips} trips, ${result.vehicles} vehicles, and ${result.savedFilters || 0} saved filters merged.`,
      variant: result.truncatedFields || (!result.savedFiltersRestored && result.savedFilters) || result.privacy_zones_need_reconfiguration ? 'destructive' : undefined,
    });
    setBackupImportOpen(false);
    setPendingBackupImportFile(null);
    setBackupImportPassword('');
    setBackupImportError('');
    return result;
  };

  const handleImportPasswordSubmit = async () => {
    if (!pendingBackupImportFile || backupImportPassword.length < 12 || backupImportBusy) return;
    setBackupImportBusy(true);
    try {
      await finishImportBackup(pendingBackupImportFile, { password: backupImportPassword });
    } catch (error) {
      toast({
        title: 'Could not import backup',
        description: error.message || 'Make sure the file is a Road Sage backup file.',
        variant: 'destructive',
      });
    } finally {
      setBackupImportBusy(false);
    }
  };

  const handleImportBackup = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (Number(file.size) > MAX_BACKUP_BYTES) {
      toast({
        title: 'Could not import backup',
        description: BACKUP_TOO_LARGE_MESSAGE,
        variant: 'destructive',
      });
      return;
    }
    const legacyPlaintextWarning = /\.json$/i.test(file.name || '')
      ? 'This backup is unencrypted. Anyone with this file can read your driving history.\n\n'
      : '';
    if (!confirm(`${legacyPlaintextWarning}Import this Road Sage backup? Trips and vehicles with matching IDs will be updated, and new ones will be added.`)) return;

    try {
      await finishImportBackup(file);
    } catch (error) {
      toast({
        title: 'Could not import backup',
        description: /\.rsbackup$/i.test(file.name || '')
          ? 'This backup file appears to be corrupted.'
          : error.message || 'Make sure the file is a Road Sage backup JSON file.',
        variant: 'destructive',
      });
    }
  };

  const effectiveTrackingMode = cfg.tracking_paused ? 'manual' : cfg.tracking_mode;
  const obdSupport = getObdBluetoothSupport();
  const motionSupport = getMotionSensorSupport();
  const locationFeatureStatus = permissionStatus?.foregroundLocation === 'granted' ? 'granted' : permissionStatus?.foregroundLocation;
  const notificationFeatureStatus = permissionStatus?.notifications === 'granted' ? 'granted' : permissionStatus?.notifications;
  const { settingSearchResults } = useSettingsSections(settingsSearch, setSettingsSearch);
  const rescoreTotal = Number(rescoreProgress?.total) || 0;
  const rescoreCompleted = Number(rescoreProgress?.completed) || 0;
  const rescoreProgressPct = rescoreTotal > 0
    ? Math.min(100, Math.round((rescoreCompleted / rescoreTotal) * 100))
    : 0;
  const autoRescoreVisible = scoreMigrationSummary.auto_rescore_recommended || rescoreProgress?.reason === 'auto_provenance';
  const settingsContext = {
    AlertTriangle, Banknote, Bell, Bluetooth, Check, ChevronRight, Clock, Download, Droplets, Focus, Gauge, Info, Leaf, LocateFixed, Lock, MapPin, Monitor, Moon, Plus, Route, Search, Shield, SlidersHorizontal, Smartphone, Sun, Target, Trash2, Unlock, Upload, Volume2, X, Zap,
    AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO, CALIBRATION_STATUSES, Checkbox, COMMUTE_MATCH_RADIUS_M, CURRENCY_SYMBOL_OPTIONS, CalibrationStatusTag, NIGHT_END_TIME, NIGHT_START_TIME, PENALTY_SCALE_CALIBRATION, PRIVACY_RADIUS_MAX_M, PRIVACY_RADIUS_MIN_M, PROVISIONAL_SCORING_CONSTANTS, PUBLIC_OSRM_DEMO_URL, RECOMMENDED_PRIVACY_RADIUS_M, SCORING_VERSION, SPEED_LIMIT_DEFAULT_COUNTRY_LABELS,
    addCurrentPrivacyZone, applyCalibration, autoRescoreVisible, batteryStatus, calibLoading, calibProfile, calibrationEntryForSetting, calibrationStatusLabel, cfg, commitPrivacyDraftRadius, deletePrivacyZone, dismissCalibration, effectiveTrackingMode, enableOsrmMapMatching, enableTrackingMode, ephemeralModeState, getPermissionExplanation, handleBatteryOptimization, handleDeleteAllTrips, handleExportAll, handleExportBackup, handleMotionPermission, handleObdPairing, importInputRef, isAndroid, isPublicOsrmDemoUrl, locationFeatureStatus, motionSupport, nativeTrackingStatus, notificationFeatureStatus, obdPairingStatus, obdSupport, openAndroidUsageAccessSettings, osrmEndpointDraft, osrmHealthCheckState, parkedLocation, permissionStatus, privacyDraft, privacyDraftRadiusError, privacyRadiusDrafts, privacyZoneRadiusErrors, privacyZones, refreshPermissions, requestActivityRecognitionPermission, requestBackgroundLocationPermission, requestForegroundLocationPermission, requestNotificationPermission, requestSaveOsrmEndpoint, rescoreCompleted, rescoreProgress, rescoreProgressPct, rescoreStatus, rescoreTotal, rescoreTrips, runCalibration, runVoiceTest, saveOsrmEndpoint, savePrivacyZone, scoreMigrationSummary, scoringValue, setOsrmEndpointDraft, setPatternGuideOpen, setPrivacyDraft, setPrivacyDraftRadiusError, setPrivacyRadiusDrafts, setPrivacyZoneRadiusErrors, setStealthNextTripEnabled, setThresholdEditingEnabled, showPrivacyPolicy, sliderWarning, speedLimitDefaultCountryKey, stealthTripToggleDisabled, stopNativeAutoTrackingSafely, thresholdEditingEnabled, updateCfg, updateExternalContextAutoFetch, updateNightMode, updateNotificationSetting, updatePrivacyZoneRadius, updateRetention, updateTheme, updateTrackingPaused, voiceTestStatus,
  };

  return (
    <div className="space-y-4 pb-6">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-grotesk font-bold">Settings</h1>
          <p className="text-muted-foreground text-sm mt-1">Customize your Road Sage experience</p>
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

      <div role="note" className="flex gap-3 rounded-2xl border border-amber-400/40 bg-amber-500/10 p-3 text-sm">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div>
          <div className="font-semibold text-foreground">{SCORE_ESTIMATE_NOTICE}</div>
          <p className="mt-1 text-muted-foreground">
            Trip Safety, Eco, Smoothness, Overall, fatigue, and score-card outputs are coaching estimates until calibrated against labeled outcome data.
          </p>
        </div>
      </div>

      {headingEventMigrationNoteVisible && (
        <div role="note" className="flex items-start justify-between gap-3 rounded-2xl border border-sky-400/40 bg-sky-500/10 p-3 text-sm">
          <div className="flex gap-3">
            <Info className="mt-0.5 h-5 w-5 shrink-0 text-sky-600" />
            <div>
              <div className="font-semibold text-foreground">Lane change events have been relabelled as heading events.</div>
              <p className="mt-1 text-muted-foreground">
                Road Sage does not measure lane-boundary crossings, so legacy records now appear as heading events.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={dismissHeadingEventMigrationNote}
            className="shrink-0 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold hover:bg-secondary"
          >
            Got it
          </button>
        </div>
      )}

      <SettingsNavigator
        ctx={settingsContext}
        settingsSearch={settingsSearch}
        setSettingsSearch={setSettingsSearch}
        settingSearchResults={settingSearchResults}
      />

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,application/octet-stream,.json,.rsbackup"
        className="hidden"
        onChange={handleImportBackup}
      />

      <Dialog open={backupExportOpen} onOpenChange={(open) => {
        if (backupExportBusy) return;
        setBackupExportOpen(open);
      }}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Export Backup</DialogTitle>
            <DialogDescription>
              Protect trip history, routes, vehicles, and settings with a password before saving the backup file.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block text-sm font-medium">
              Password
              <input
                type="password"
                value={backupExportPassword}
                onChange={(event) => setBackupExportPassword(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                autoComplete="new-password"
              />
            </label>
            <label className="block text-sm font-medium">
              Confirm password
              <input
                type="password"
                value={backupExportConfirm}
                onChange={(event) => setBackupExportConfirm(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                autoComplete="new-password"
              />
            </label>
            <div className="space-y-1.5">
              <div className="grid grid-cols-4 gap-1" aria-hidden="true">
                {[1, 2, 3, 4].map((level) => (
                  <div
                    key={level}
                    className={`h-1.5 rounded-full ${
                      backupPasswordStrengthScore >= level
                        ? backupPasswordStrong
                          ? 'bg-green-500'
                          : 'bg-amber-500'
                        : 'bg-secondary'
                    }`}
                  />
                ))}
              </div>
              <div className={`text-xs font-medium ${backupPasswordStrong && backupPasswordsMatch ? 'text-green-600' : 'text-amber-600'}`}>
                {backupPasswordStrong
                  ? backupPasswordsMatch
                    ? `${backupPasswordStrengthLabel} password`
                    : 'Passwords must match'
                  : `Use at least 12 characters. Current strength: ${backupPasswordStrengthLabel}`}
              </div>
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setBackupExportOpen(false)}
              disabled={backupExportBusy}
              className="rounded-lg border border-border px-3 py-2 text-sm font-semibold disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={performExportBackup}
              disabled={!backupExportReady || backupExportBusy}
              className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {backupExportBusy ? 'Exporting...' : 'Export Backup'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={backupImportOpen} onOpenChange={(open) => {
        if (backupImportBusy) return;
        setBackupImportOpen(open);
        if (!open) {
          setPendingBackupImportFile(null);
          setBackupImportPassword('');
          setBackupImportError('');
        }
      }}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Import Backup</DialogTitle>
            <DialogDescription>
              {pendingBackupImportIsEncrypted
                ? 'Enter the password used when this backup was created.'
                : 'Enter the password used when this Road Sage backup was exported.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {backupImportError === 'wrong_password' && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                Wrong password. Check the password and try again.
              </div>
            )}
            {backupImportError === 'password_required' && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                This backup is encrypted.
              </div>
            )}
            <label className="block text-sm font-medium">
              Password
              <input
                type="password"
                value={backupImportPassword}
                onChange={(event) => setBackupImportPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleImportPasswordSubmit();
                }}
                className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary"
                autoComplete="current-password"
              />
            </label>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setBackupImportOpen(false)}
              disabled={backupImportBusy}
              className="rounded-lg border border-border px-3 py-2 text-sm font-semibold disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleImportPasswordSubmit}
              disabled={backupImportPassword.length < 12 || backupImportBusy}
              className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {backupImportBusy ? 'Importing...' : 'Import'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={osrmConsentOpen} onOpenChange={(open) => {
        setOsrmConsentOpen(open);
        if (!open) {
          setOsrmConsentChecked(false);
          setOsrmPendingEndpoint('');
        }
      }}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Share route samples with OSRM?</DialogTitle>
            <DialogDescription>
              Road Sage will send sampled GPS coordinate pairs from one selected trip at a time to the OSRM endpoint you save. This happens only when you tap Get Road Data; each continuous route segment sends up to 100 sampled coordinate pairs, with privacy-zone gaps excluded.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
            <Checkbox
              checked={osrmConsentChecked}
              onCheckedChange={(checked) => setOsrmConsentChecked(checked === true)}
              className="mt-0.5"
            />
            <span>I understand and accept that sampled GPS coordinate pairs from selected trips will be sent to this OSRM endpoint when I tap Get Road Data.</span>
          </label>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setOsrmConsentOpen(false)}
              className="rounded-lg border border-border px-3 py-2 text-sm font-semibold"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={acceptOsrmDataSharingConsent}
              disabled={!osrmConsentChecked}
              className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              Confirm and check endpoint
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
        <div className="font-semibold text-foreground text-sm">Road Sage</div>
        <div>Version 1.0.0 (Capacitor Android)</div>
        <div>Map: OpenStreetMap + Leaflet (free, open-source)</div>
        <div>Data: Stored locally by default - No ads - Calibration sharing is opt-in</div>
        <div>Legal: Personal-use estimates only; not professional advice or official records.</div>
      </div>
    </div>
  );
}
