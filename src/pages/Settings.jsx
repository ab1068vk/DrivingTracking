import { memo, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { calibrationLabelService } from '@/api/calibrationLabels';
import {
  Moon, Sun, Monitor, Trash2, Download, Upload, Shield, ChevronRight, ArrowLeft, Info, AlertTriangle, Check, Bell, Clock, Lock, Unlock, SlidersHorizontal, Focus, MapPin, Plus, LocateFixed, Gauge, Droplets, Bluetooth, Volume2, Route, Target, Search, X, Leaf, Zap, Banknote, Smartphone, Eye, EyeOff, Mic
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
import { applyThemeMode, getLastParkedLocation, localSettings, validateSettingsPatch } from '@/lib/trackingStore';
import { NIGHT_END_TIME, NIGHT_START_TIME, SAVED_FILTERS_KEY } from '@/lib/appConstants';
import { tripsToCSV, downloadCSV } from '@/lib/tripEngine';
import { buildDrivingThresholds, SCORING_VERSION } from '@/lib/tripEngine';
import {
  AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO,
  AUTO_RESCORE_RECENT_WINDOW_DAYS,
  enforceTripDataRetention,
  enforceRawGpsRetention,
  getRawGpsLifecycleStatus,
  TRIP_EVENT_MIGRATION_KEY,
  TRIP_EVENT_MIGRATION_NOTE_DISMISSED_KEY,
  TRIP_EVENT_MIGRATION_VERSION,
} from '@/lib/localTripRepository';
import { RESCORE_PROGRESS_EVENT } from '@/lib/tripRepositoryEvents';
import { getJson, setJson } from '@/lib/mobileStorage';
import { useQuery } from '@tanstack/react-query';
import {
  getPermissionExplanation,
  getPermissionStatus,
  requestActivityRecognitionPermission,
  requestBackgroundLocationPermission,
  requestForegroundLocationPermission,
  requestMicrophonePermission,
  requestNotificationPermission,
} from '@/lib/permissions';
import { isAndroid } from '@/lib/nativePlatform';
import {
  getAndroidBatteryOptimizationStatus,
  openAndroidUsageAccessSettings,
  getNativeAutoTrackingStatus,
  openAndroidBatteryOptimizationSettings,
  clearNativeCompletedTrips,
  startNativeAutoTracking,
  stopNativeAutoTracking,
  testVoiceSpeedMarkerRecognition,
} from '@/lib/activityRecognition';
import { syncReminderNotifications } from '@/lib/notificationService';
import {
  BACKUP_PASSWORD_REQUIRED_CODE,
  BACKUP_SIGNATURE_INVALID_CODE,
  BACKUP_TOO_LARGE_MESSAGE,
  BACKUP_WRONG_PASSWORD_CODE,
  exportDriveSenseBackup,
  importDriveSenseBackup,
  MAX_BACKUP_BYTES,
} from '@/lib/dataBackup';
import {
  eraseAllLocalDataAndDownloadReceipt,
  exportDataPortabilityBundle,
} from '@/lib/dataRights';
import { BACKUP_PASSPHRASE_MIN_LENGTH, ENCRYPTED_BACKUP_MIME_TYPE } from '@/lib/backupEnvelopeEncryption';
import { COMMUTE_MATCH_RADIUS_M } from '@/lib/mediumInsights';
import { isExternalContextAutoFetchEnabled } from '@/lib/openSourceTripContext';
import {
  applyCalibrationProfile,
  clearCalibrationProfile,
  computeCalibrationProfile,
  loadCalibrationProfile,
  saveCalibrationProfile,
  summarizeCalibrationSurveyLabels,
  summarizeSurveyCoverage,
} from '@/lib/thresholdCalibration';
import { getCurrentLocation } from '@/lib/trackingService';
import {
  countTripsAffectedByPrivacyZone,
  corridorWaypointsFromRoute,
  findOverlappingZones,
  getPrivacyZones,
  loadPrivacyZonesFromStorage,
  mergePrivacyZones,
  NATIVE_PRIVACY_SYNC_FAILED_EVENT,
  NATIVE_PRIVACY_SYNC_STATUS_FAILED,
  PRIVACY_RADIUS_DEFAULT_M,
  PRIVACY_RADIUS_MAX_M,
  PRIVACY_RADIUS_MIN_M,
  PRIVACY_CORRIDOR_MAX_WAYPOINTS,
  PRIVACY_CORRIDOR_MIN_WAYPOINTS,
  purgeExistingGpsForHeightenedPrivacy,
  purgeGpsWithinPrivacyZone,
  removePrivacyZone,
  tripIdsAffectedByPrivacyZone,
  upsertPrivacyZone,
} from '@/lib/privacyZones';
import { enqueueRescoreJob, isPrivacyRescoreReason, scheduleRescoringQueue } from '@/lib/rescoringQueue';
import { rescoreTripForQueue } from '@/lib/rescoringWorker';
import { invalidateRouteRiskIndex } from '@/lib/routeRiskIndex';
import { connectObdBleAdapter, getObdBluetoothSupport } from '@/lib/obdBluetooth';
import { getMotionSensorSupport, requestMotionSensorPermission } from '@/lib/sensorFusionModel';
import { getVoiceAlertDeliveryStatus, testVoiceAlert } from '@/lib/voiceAlerts';
import { PUBLIC_OSRM_DEMO_URL, isPublicOsrmDemoUrl } from '@/lib/osrmPrivacy';
import { privacyZoneDraftFromSuggestion } from '@/lib/privacyZoneSuggestions';
import { checkOsrmEndpointHealth, clearMapMatchingCache } from '@/lib/mapMatching';
import { CURRENCY_SYMBOL_OPTIONS } from '@/lib/currency';
import {
  clearOsmSpeedLimitCache,
  SPEED_LIMIT_DEFAULT_COUNTRY_LABELS,
  REGION_SPEED_DEFAULTS,
  speedLimitDefaultCountryKey,
} from '@/lib/speedLimitSource';
import { clearWeatherContextCache } from '@/lib/weatherContext';
import CalibrationStatusTag from '@/components/CalibrationStatusTag';
import LegalNoticeDialog from '@/components/LegalNoticeDialog';
import {
  CALIBRATION_STATUSES,
  SCORING_CONSTANTS,
  calibrationEntryForSetting,
  getProvisionalScoringConstants,
  scoringValue,
} from '@/lib/scoringConstants';
import { SCORE_ESTIMATE_NOTICE } from '@/lib/scoreDisplay';
import { LEGAL_DISCLAIMER_SHORT, LEGAL_NOTICE_ACK_VERSION } from '@/lib/legalDisclaimers';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { verifyChain } from '@/lib/hashChainLog';
import { setScreenCaptureAllowed } from '@/lib/screenSecurity';
import {
  APP_LOCK_SETTING_EVENT,
  authenticateDevice,
  getDeviceAuthenticationAvailability,
} from '@/lib/biometricGate';
import { checkIntegrity, integrityStatusFromSettings } from '@/lib/rasp';
import { searchSettingsSections } from '@/lib/settingsSearch';
import InlineRefreshBadge from '@/components/InlineRefreshBadge';
import { HEIGHTENED_PRIVACY_MODE_EFFECTS } from '@/lib/privacyMode';
import PrivacyZoneProtectionCheck from '@/components/PrivacyZoneProtectionCheck';
import {
  invalidateSelfTestCache,
  selfTestPrivacyZoneProtection,
} from '@/lib/controlSelfTests';

// CHANGES (session):
// - Added province/state picker and Phase 2 estimated speed guidance settings.
// - Renamed regional default settings copy to estimate wording.
// - Added stronger posted-sign override wording for regional default estimates.
// - Softened generic speed-warning labels to speed-check wording for estimated tiers.
// - Fixed speed margin numeric inputs so users can clear and retype values.
// - Added explicit copy explaining speed margin values affect live voice alert timing.
// - Applied the same blank-safe numeric input handling to editable economics settings.

function SectionTitle({ children, id }) {
  return <div id={id} className="scroll-mt-24 text-xs font-bold uppercase tracking-widest text-muted-foreground px-1 mb-2 mt-6">{children}</div>;
}

function SettingsSubheading({ children }) {
  return <div className="px-1 pt-3 pb-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{children}</div>;
}

/**
 * @param {{ id: string, activeId: string, children: any }} props
 */
const SettingsSection = /** @type {any} */ (memo(function SettingsSection(props) {
  const { id, activeId, children } = /** @type {{ id: string, activeId: string, children: any }} */ (props);
  if (activeId !== id) return null;
  return (
    <div className="settings-section">
      {typeof children === 'function' ? children() : children}
    </div>
  );
}, (/** @type {any} */ previous, /** @type {any} */ next) => (
  previous.id === next.id && previous.activeId !== previous.id && next.activeId !== next.id
)));

function SettingRow({ icon: Icon = null, label, sublabel = '', children = null, onClick = null, danger = false }) {
  return (
    <div
      data-setting-label={label}
      className={`scroll-mt-24 flex items-center justify-between gap-3 py-3 px-1 border-b border-border/50 last:border-0 ${onClick ? 'cursor-pointer hover:bg-secondary/50 rounded-xl -mx-1 px-2 transition-colors' : ''}`}
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

function numberDraftValue(value, fallback) {
  return value === '' ? '' : value ?? fallback;
}

function updateOptionalNumberDraft(updateCfg, key, rawValue) {
  if (rawValue === '') {
    updateCfg({ [key]: '' });
    return;
  }
  const number = Number(rawValue);
  if (Number.isFinite(number)) {
    updateCfg({ [key]: number });
  }
}

function formatLegalNoticeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

const runAfterVisiblePaint = (callback) => {
  const run = () => window.setTimeout(callback, 0);
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(run);
  } else {
    setTimeout(callback, 0);
  }
};

function Toggle({ value, onChange, disabled = false }) {
  const [optimisticValue, setOptimisticValue] = useState(Boolean(value));
  const latestValueRef = useRef(Boolean(value));
  latestValueRef.current = Boolean(value);
  useEffect(() => setOptimisticValue(Boolean(value)), [value]);

  const change = (event) => {
    event.stopPropagation();
    const next = !optimisticValue;
    setOptimisticValue(next);
    runAfterVisiblePaint(() => {
      Promise.resolve(onChange(next)).finally(() => {
        window.setTimeout(() => setOptimisticValue(latestValueRef.current), 500);
      });
    });
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={optimisticValue}
      disabled={disabled}
      onClick={change}
      className={`relative w-12 h-6 rounded-full transition-colors disabled:opacity-50 ${optimisticValue ? 'bg-primary' : 'bg-secondary border border-border'}`}
    >
      <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${optimisticValue ? 'left-6' : 'left-0.5'}`} />
    </button>
  );
}

function OptimisticCheckbox({ checked, onCheckedChange, ...props }) {
  const [optimisticChecked, setOptimisticChecked] = useState(checked === true);
  const latestCheckedRef = useRef(checked === true);
  latestCheckedRef.current = checked === true;
  useEffect(() => setOptimisticChecked(checked === true), [checked]);

  return (
    <Checkbox
      {...props}
      checked={optimisticChecked}
      onCheckedChange={(next) => {
        const value = next === true;
        setOptimisticChecked(value);
        runAfterVisiblePaint(() => {
          Promise.resolve(onCheckedChange?.(value)).finally(() => {
            window.setTimeout(() => setOptimisticChecked(latestCheckedRef.current), 500);
          });
        });
      }}
    />
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

const SETTINGS_NAV_GROUPS = [
  { id: 'driving-device', label: 'Driving & Device' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'coaching-detection', label: 'Coaching & Detection' },
  { id: 'privacy-data', label: 'Privacy & Data' },
];

const REGION_LABELS = Object.freeze({
  CA: 'California',
  TX: 'Texas',
  NY: 'New York',
  ON: 'Ontario',
  BC: 'British Columbia',
  AB: 'Alberta',
  QC: 'Quebec',
  MB: 'Manitoba',
  SK: 'Saskatchewan',
});

const regionDefaultOptions = (countryCode) => (
  Object.keys(REGION_SPEED_DEFAULTS[countryCode] || {}).filter((key) => key !== '_country')
);

const SETTINGS_SECTIONS = [
  {
    id: 'settings-tracking',
    group: 'driving-device',
    title: 'Tracking',
    icon: Shield,
    detail: 'Manual, auto-detect, background tracking, and pause controls.',
    keywords: 'manual auto detect background pause delayed start not starting drive signal gps movement',
    searchItems: [
      { label: 'Tracking mode', keywords: 'manual only auto detect background auto' },
      { label: 'Pause all tracking', keywords: 'stop disable trip detection' },
      { label: 'Auto-tracking', keywords: 'automatic start driving signals' },
      { label: 'Background tracking', keywords: 'record app closed location' },
    ],
  },
  {
    id: 'settings-android-permissions',
    group: 'driving-device',
    title: 'Android Permissions',
    icon: Shield,
    detail: 'Location, activity, notification, battery, and native service setup.',
    keywords: 'location activity notification battery unrestricted native service usage bluetooth permission granted denied prompt',
    searchItems: [
      { label: 'Foreground location permission', targetLabel: 'Location', keywords: 'gps while using app' },
      { label: 'Background location permission', targetLabel: 'Background Location', keywords: 'always allow location' },
      { label: 'Activity recognition permission', targetLabel: 'Physical Activity', keywords: 'physical activity driving detection' },
      { label: 'Notification permission', targetLabel: 'Notifications', keywords: 'alerts prompt' },
      { label: 'Battery optimization', keywords: 'unrestricted battery background service' },
      { label: 'Native auto-tracking service', targetLabel: 'Native Auto Tracking', keywords: 'android background automatic trips' },
    ],
  },
  {
    id: 'settings-feature-permissions',
    group: 'driving-device',
    title: 'Feature Permissions',
    icon: Info,
    detail: 'See which app features need setup before they can work.',
    keywords: 'blocked unavailable permission feature status',
    searchItems: [
      { label: 'Motion sensor access', keywords: 'accelerometer gyroscope crash detection' },
      { label: 'Phone Usage Access', keywords: 'distraction foreground app android' },
      { label: 'OBD-II Bluetooth diagnostics', keywords: 'nearby devices ble adapter' },
      { label: 'Road data and weather access', keywords: 'openstreetmap open meteo osrm network' },
      { label: 'Voice alerts', keywords: 'speech coaching microphone' },
    ],
  },
  {
    id: 'settings-appearance',
    group: 'preferences',
    title: 'Appearance',
    icon: Monitor,
    detail: 'Theme and unit preferences.',
    keywords: 'theme dark light system units metric imperial kmh mph',
    searchItems: [
      { label: 'Theme', keywords: 'light dark system display' },
      { label: 'Units', keywords: 'metric imperial kmh mph kilometers miles' },
    ],
  },
  {
    id: 'settings-economics',
    group: 'preferences',
    title: 'Economics',
    icon: Banknote,
    detail: 'Currency, fuel, EV, carbon, and savings assumptions.',
    keywords: 'currency symbol money cost price co2 carbon emissions average vehicle baseline electric ev grid intensity kwh tree fuel savings economics',
    searchItems: [
      { label: 'Currency symbol', keywords: 'money cost dollar euro pound' },
      { label: 'Average vehicle CO2 baseline', keywords: 'emissions carbon comparison' },
      { label: 'Default EV efficiency', keywords: 'electric kwh per 100 km' },
      { label: 'Grid CO2 intensity', keywords: 'electricity emissions' },
      { label: 'Tree-year equivalent', keywords: 'carbon impact summary' },
    ],
  },
  {
    id: 'settings-notifications',
    group: 'preferences',
    title: 'Notifications',
    icon: Bell,
    detail: 'Quiet hours, trip summaries, coaching, maintenance, and safety alerts.',
    keywords: 'quiet hours trip summary coaching maintenance nudges alert',
    searchItems: [
      { label: 'Enable all notifications', keywords: 'master alerts toggle' },
      { label: 'Quiet hours', keywords: 'do not disturb start end time' },
      { label: 'Safety alerts', keywords: 'driving warning phone heading speeding danger zone' },
      { label: 'Trip started and ended notifications', keywords: 'start finish summary' },
      { label: 'Post-trip smart summary', keywords: 'score change phone use fuel saving' },
      { label: 'Coaching notifications', keywords: 'milestones achievements streak weekly driving summary tips' },
      { label: 'Maintenance reminders', keywords: 'vehicle service' },
      { label: 'No-trip nudge', keywords: 'inactive reminder days' },
    ],
  },
  {
    id: 'settings-driving-goals',
    group: 'coaching-detection',
    title: 'Driving Goals',
    icon: Target,
    detail: 'Weekly score, mileage, night driving, and behavior targets.',
    keywords: 'weekly score harsh brake speeding night goals target',
    searchItems: [
      { label: 'Maximum harsh brakes', keywords: 'weekly goal braking' },
      { label: 'Maximum speeding events', keywords: 'weekly goal speed' },
      { label: 'Minimum average score', keywords: 'weekly target' },
      { label: 'Maximum night distance and trips', keywords: 'night km driving goal' },
      { label: 'UBI annual mileage target', keywords: 'insurance mileage score' },
    ],
  },
  {
    id: 'settings-night-window',
    group: 'coaching-detection',
    title: 'Night Window',
    icon: Clock,
    detail: 'Night-trip detection window and sunset fallback.',
    keywords: 'night window sunset sunrise custom time late drive scoring',
    searchItems: [
      { label: 'Night driving start time', keywords: 'late evening begins' },
      { label: 'Night driving end time', keywords: 'morning ends' },
      { label: 'Sunset and sunrise fallback', keywords: 'automatic night window' },
    ],
  },
  {
    id: 'settings-detection-thresholds',
    group: 'coaching-detection',
    title: 'Detection Features',
    icon: SlidersHorizontal,
    detail: 'Detection toggles, sensitivity, calibration, and re-scoring.',
    keywords: 'harsh braking rapid acceleration speeding idle lane changing brake turn heading drift calibration rescore feedback accurate wrong false positive',
    searchItems: [
      { label: 'Detection feature switches', keywords: 'braking acceleration cornering speeding idle heading' },
      { label: 'Detection sensitivity', keywords: 'threshold strict lenient false positive' },
      { label: 'Calibration labels', keywords: 'feedback correct incorrect events' },
      { label: 'Re-score trip history', keywords: 'recalculate scoring version migration' },
      { label: 'Lane change and heading event scoring', keywords: 'advanced safety beta' },
    ],
  },
  {
    id: 'settings-advanced-models',
    group: 'coaching-detection',
    title: 'Advanced Models',
    icon: Route,
    detail: 'Sensor fusion, crash, route risk, voice alerts, OBD, and map overlays.',
    keywords: 'route risk voice alerts obd bluetooth sensor fusion crash map line event marker cornering heatmap',
    searchItems: [
      { label: 'Sensor fusion', keywords: 'motion accelerometer gyroscope gps' },
      { label: 'Crash detection', keywords: 'impact emergency safety' },
      { label: 'Emergency workflow', keywords: 'crash response' },
      { label: 'Predictive route risk', keywords: 'route warning hazard' },
      { label: 'Voice alerts', keywords: 'spoken warning test volume' },
      { label: 'OBD-II Bluetooth', keywords: 'vehicle adapter diagnostics ble' },
      { label: 'Map overlays', keywords: 'event markers heatmap route line' },
    ],
  },
  {
    id: 'settings-phone-use',
    group: 'coaching-detection',
    title: 'Phone Use Detection',
    icon: Smartphone,
    detail: 'Distraction detection, map display, scoring, and expert tuning.',
    keywords: 'distraction usage access phone score map foreground app',
    searchItems: [
      { label: 'Android Usage Access', keywords: 'permission foreground app' },
      { label: 'Phone use detection', keywords: 'distraction monitoring' },
      { label: 'Live phone use alert', keywords: 'driving warning notification' },
      { label: 'Show phone use on trip map', keywords: 'route markers' },
      { label: 'Include phone use in trip score', keywords: 'safety penalty' },
      { label: 'Phone detection expert tuning', keywords: 'threshold sensitivity duration' },
    ],
  },
  {
    id: 'settings-speed-warning',
    group: 'coaching-detection',
    title: 'Speed & Road Data',
    icon: Gauge,
    detail: 'Live speed checks, posted speed warnings, speed limits, weather, and automatic road-data lookup.',
    keywords: 'speed limits overpass osm warning margin over limit openstreetmap road data weather',
    searchItems: [
      { label: 'Live speed check', keywords: 'over limit alert coaching' },
      { label: 'Speed limits from OpenStreetMap', keywords: 'osm posted maxspeed' },
      { label: 'Fallback estimate country', keywords: 'canada united states global regional estimate' },
      { label: 'Weather from Open-Meteo', keywords: 'rain snow fog ice' },
      { label: 'Automatic road-data lookup', keywords: 'auto fetch speed weather' },
      { label: 'Snap route to roads with OSRM', keywords: 'map matching cleanup endpoint' },
      { label: 'OSRM timeout and endpoint', keywords: 'server route matching link' },
      { label: 'Speed check margin', keywords: 'strict lenient over limit kmh' },
    ],
  },
  {
    id: 'settings-privacy-data',
    group: 'privacy-data',
    title: 'Privacy & Data',
    icon: Shield,
    detail: 'Privacy zones, backups, exports, imports, deletion, and feedback data.',
    keywords: 'privacy export import backup retention delete data saved filters event feedback security',
    searchItems: [
      { label: 'Legal and privacy notice', targetLabel: 'Legal, safety, data & privacy notice', keywords: 'safety data external services' },
      { label: 'Privacy Intelligence', keywords: 'outbound records protections audit health' },
      { label: 'Request timing obfuscation', keywords: 'random delay network privacy' },
      { label: 'Decoy traffic', keywords: 'open meteo neutral location' },
      { label: 'App lock', keywords: 'fingerprint face device authentication' },
      { label: 'Screenshots and screen sharing', keywords: 'screen capture privacy' },
      { label: 'Privacy zones', keywords: 'home work hidden location radius map' },
      { label: 'Export all trips', keywords: 'csv download' },
      { label: 'Export everything', keywords: 'data portability json download' },
      { label: 'Export full backup', keywords: 'encrypted save password' },
      { label: 'Import backup', keywords: 'restore encrypted json' },
      { label: 'Erase all local data', keywords: 'delete erasure receipt proof' },
      { label: 'Data retention', keywords: 'delete trips days forever' },
      { label: 'Privacy log retention', keywords: 'operation records hours' },
      { label: 'Raw GPS retention', keywords: 'route coordinates delete days' },
      { label: 'Verify audit log', keywords: 'tamper chain integrity' },
      { label: 'Delete all trips', keywords: 'erase permanent danger' },
    ],
  },
];

function SettingsAreaNavigation({ sections, activeId, onSelect, variant }) {
  const mobile = variant === 'mobile';

  return (
    <nav aria-label="Settings areas" className={mobile ? 'space-y-4' : 'space-y-5'}>
      {SETTINGS_NAV_GROUPS.map((group) => {
        const groupedSections = sections.filter((section) => section.group === group.id);
        if (!groupedSections.length) return null;

        return (
          <div key={group.id}>
            <div className={`font-bold uppercase tracking-widest text-muted-foreground ${
              mobile ? 'mb-2 px-1 text-[11px]' : 'mb-1.5 px-2 text-[10px]'
            }`}>
              {group.label}
            </div>
            <div className={mobile ? 'overflow-hidden rounded-xl border border-border bg-card divide-y divide-border/70' : 'space-y-1'}>
              {groupedSections.map(({ id, title, detail, icon: Icon }) => {
                const active = activeId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onSelect(id)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex w-full items-center text-left transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary/40 ${
                      mobile
                        ? 'min-h-[72px] gap-3 px-3 py-3 hover:bg-secondary/50'
                        : `min-h-11 gap-2.5 rounded-lg px-2.5 py-2 ${
                            active
                              ? 'bg-primary text-primary-foreground'
                              : 'text-foreground hover:bg-secondary'
                          }`
                    }`}
                  >
                    <span className={`grid shrink-0 place-items-center rounded-lg ${
                      mobile
                        ? 'h-9 w-9 bg-secondary text-muted-foreground'
                        : `h-8 w-8 ${active ? 'bg-primary-foreground/15 text-primary-foreground' : 'bg-secondary text-muted-foreground'}`
                    }`}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold leading-snug">{title}</span>
                      {mobile && (
                        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                          {detail}
                        </span>
                      )}
                    </span>
                    {mobile ? (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : active ? (
                      <Check className="h-4 w-4 shrink-0" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
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
    definition: 'Regional defaults are useful fallback estimates when posted speed data is unavailable, but they are not proof of the posted speed limit. Posted signs, school zones, construction zones, temporary limits, municipal bylaws, and road-specific exceptions can override them. A REGION_DEFAULT result is more reliable than GPS-only inference because it uses country/province/state and road-context information, but it must still be treated as an estimate unless confirmed by posted data.',
  },
  {
    term: 'Parking approach',
    definition: 'Scores the final low-speed part of a trip for smooth deceleration instead of abrupt stopping near the destination.',
  },
];

const SETTINGS_HEAVY_QUERY_STALE_MS = 30_000;
const PROVISIONAL_SCORING_CONSTANTS = getProvisionalScoringConstants();
const PENALTY_SCALE_CALIBRATION = Object.freeze({
  key: 'PENALTY_SCALE_FACTOR',
  ...SCORING_CONSTANTS.PENALTY_SCALE_FACTOR,
});
const RASP_THREAT_LABELS = Object.freeze({
  SU_BINARY: 'su binary',
  TEST_KEYS: 'test-signed OS',
  DEBUGGABLE: 'debuggable app',
  ADB_ENABLED: 'USB debugging',
  EMULATOR: 'emulator',
});

function calibrationStatusLabel(status) {
  return status === CALIBRATION_STATUSES.PROVISIONAL ? 'Provisional' : status;
}

function formatRaspThreat(threat) {
  const value = String(threat || '');
  if (value.startsWith('ROOT_APP:')) return `root manager: ${value.slice('ROOT_APP:'.length)}`;
  return RASP_THREAT_LABELS[value] || value;
}

const calibrationLabelDate = (label = {}) => {
  const value = label.createdAt || label.submitted_at || label.stored_at;
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : 'Saved label';
};

const yieldToPaint = () => new Promise((resolve) => {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => resolve());
    return;
  }
  setTimeout(resolve, 0);
});

const BACKUP_IMPORT_ACCEPT = [
  'application/json',
  ENCRYPTED_BACKUP_MIME_TYPE,
  'application/octet-stream',
  'text/plain',
  '.json',
  '.drivesensebackup',
  '*/*',
].join(',');

const backupPasswordRequirements = (value = '') => ({
  minLength: value.length >= BACKUP_PASSPHRASE_MIN_LENGTH,
  capital: /[A-Z]/.test(value),
  special: /[^A-Za-z0-9]/.test(value),
});

function validatePrivacyRadius(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return { valid: false, error: `Enter a radius from ${PRIVACY_RADIUS_MIN_M} m to ${PRIVACY_RADIUS_MAX_M} m.` };
  }

  const number = Number(raw);
  if (!Number.isFinite(number)) {
    return { valid: false, error: 'Radius must be a number in meters.' };
  }

  if (number < PRIVACY_RADIUS_MIN_M || number > PRIVACY_RADIUS_MAX_M) {
    return { valid: false, error: `Radius must be from ${PRIVACY_RADIUS_MIN_M} m to ${PRIVACY_RADIUS_MAX_M} m. Values outside this range are not saved.` };
  }

  return { valid: true, radius: Math.round(number), error: '' };
}

export default function Settings() {
  const navigate = useNavigate();
  const location = useLocation();
  const [saved, setSaved] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState(null);
  const [nativeTrackingStatus, setNativeTrackingStatus] = useState(null);
  const [batteryStatus, setBatteryStatus] = useState(null);
  const [legalNoticeOpen, setLegalNoticeOpen] = useState(false);
  const [patternGuideOpen, setPatternGuideOpen] = useState(false);
  const [calibProfile, setCalibProfile] = useState(null);
  const [calibLoading, setCalibLoading] = useState(false);
  const [calibrationLabels, setCalibrationLabels] = useState([]);
  const [calibrationMarkers, setCalibrationMarkers] = useState({});
  const [calibrationLabelStatus, setCalibrationLabelStatus] = useState('');
  const [parkedLocation, setParkedLocation] = useState(null);
  const [privacyDraft, setPrivacyDraft] = useState({
    label: 'Private place',
    radius_m: String(PRIVACY_RADIUS_DEFAULT_M),
    type: 'circle',
    sensitivity: 'high',
    durationDays: 'permanent',
  });
  const [privacyCorridorWaypoints, setPrivacyCorridorWaypoints] = useState([]);
  const [privacyProtectionCheck, setPrivacyProtectionCheck] = useState(null);
  const [privacyProtectionTest, setPrivacyProtectionTest] = useState(null);
  const [privacyProtectionTestBusy, setPrivacyProtectionTestBusy] = useState(false);
  const [suggestedPrivacyLocation, setSuggestedPrivacyLocation] = useState(null);
  const [privacyRadiusDrafts, setPrivacyRadiusDrafts] = useState({});
  const [privacyDraftRadiusError, setPrivacyDraftRadiusError] = useState('');
  const [privacyZoneRadiusErrors, setPrivacyZoneRadiusErrors] = useState({});
  const [privacyDeleteZone, setPrivacyDeleteZone] = useState(null);
  const [privacyDeletePurge, setPrivacyDeletePurge] = useState(false);
  const [privacyDeleteBusy, setPrivacyDeleteBusy] = useState(false);
  const [privacyDeleteImpact, setPrivacyDeleteImpact] = useState({ loading: false, tripCount: null });
  const [obdPairingStatus, setObdPairingStatus] = useState('');
  const [voiceTestStatus, setVoiceTestStatus] = useState('');
  const [voiceSpeedMarkerTestStatus, setVoiceSpeedMarkerTestStatus] = useState('');
  const [voiceSpeedMarkerTestBusy, setVoiceSpeedMarkerTestBusy] = useState(false);
  const [settingsSearchInput, setSettingsSearchInput] = useState('');
  const [settingsSearch, setSettingsSearch] = useState('');
  const [isSettingsSearchPending, startSettingsSearchTransition] = useTransition();
  const [activeSettingsSection, setActiveSettingsSection] = useState('overview');
  const [rescoreStatus, setRescoreStatus] = useState('');
  const [rescoreProgress, setRescoreProgress] = useState(null);
  const [rescoreConfirmOpen, setRescoreConfirmOpen] = useState(false);
  const [rescoreBusy, setRescoreBusy] = useState(false);
  const [rescoreResult, setRescoreResult] = useState(null);
  const [headingEventMigrationNoteVisible, setHeadingEventMigrationNoteVisible] = useState(false);
  const [osrmConsentOpen, setOsrmConsentOpen] = useState(false);
  const [osrmConsentChecked, setOsrmConsentChecked] = useState(false);
  const [osrmPendingEndpoint, setOsrmPendingEndpoint] = useState('');
  const [backupExportOpen, setBackupExportOpen] = useState(false);
  const [backupExportPassphrase, setBackupExportPassphrase] = useState('');
  const [backupExportConfirm, setBackupExportConfirm] = useState('');
  const [backupExportPlaintext, setBackupExportPlaintext] = useState(false);
  const [backupExportBusy, setBackupExportBusy] = useState(false);
  const [backupExportPasswordVisible, setBackupExportPasswordVisible] = useState(false);
  const [backupExportConfirmVisible, setBackupExportConfirmVisible] = useState(false);
  const [backupImportOpen, setBackupImportOpen] = useState(false);
  const [backupImportPassphrase, setBackupImportPassphrase] = useState('');
  const [backupImportError, setBackupImportError] = useState('');
  const [backupImportBusy, setBackupImportBusy] = useState(false);
  const [backupImportPasswordVisible, setBackupImportPasswordVisible] = useState(false);
  const [pendingBackupImportFile, setPendingBackupImportFile] = useState(null);
  const [tripExportBusy, setTripExportBusy] = useState(false);
  const [portabilityExportBusy, setPortabilityExportBusy] = useState(false);
  const [erasureBusy, setErasureBusy] = useState(false);
  const [osrmEndpointDraft, setOsrmEndpointDraft] = useState(() => localSettings.get().osrm_map_matching_url || '');
  const [osrmHealthCheckState, setOsrmHealthCheckState] = useState('idle');
  const [integrity, setIntegrity] = useState(() => integrityStatusFromSettings(localSettings.get()));
  const [integrityChecking, setIntegrityChecking] = useState(false);
  const [auditVerifying, setAuditVerifying] = useState(false);
  const [rawGpsLifecycleStatus, setRawGpsLifecycleStatus] = useState(null);
  const [rawGpsLifecycleBusy, setRawGpsLifecycleBusy] = useState(false);
  const importInputRef = useRef(null);
  const corridorDraftExpiryRef = useRef(null);
  const qc = useQueryClient();

  // Load settings from local storage
  const [cfg, setCfg] = useState(() => localSettings.get());
  const cfgRef = useRef(cfg);
  const settingsPersistenceQueueRef = useRef(Promise.resolve());
  cfgRef.current = cfg;
  const [thresholdEditingEnabled, setThresholdEditingEnabled] = useState(false);
  const updateSettingsSearch = (value) => {
    setSettingsSearchInput(value);
    startSettingsSearchTransition(() => {
      setSettingsSearch(value);
    });
  };
  const clearSettingsSearch = () => {
    setSettingsSearchInput('');
    startSettingsSearchTransition(() => {
      setSettingsSearch('');
    });
  };

  useEffect(() => {
    const sectionId = new URLSearchParams(location.search || '').get('section');
    if (!sectionId || !SETTINGS_SECTIONS.some((section) => section.id === sectionId)) return;
    setActiveSettingsSection(sectionId);
    clearSettingsSearch();
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [location.search]);

  useEffect(() => {
    if (activeSettingsSection === 'settings-privacy-data') return;
    setPrivacyCorridorWaypoints([]);
    setPrivacyProtectionCheck(null);
  }, [activeSettingsSection]);

  useEffect(() => {
    if (!privacyCorridorWaypoints.length || activeSettingsSection !== 'settings-privacy-data') return undefined;
    const clearTimer = () => {
      if (corridorDraftExpiryRef.current) window.clearTimeout(corridorDraftExpiryRef.current);
      corridorDraftExpiryRef.current = window.setTimeout(() => {
        setPrivacyCorridorWaypoints([]);
        setPrivacyProtectionCheck((current) => current?.type === 'corridor' ? null : current);
        toast({
          title: 'Unsaved corridor cleared',
          description: 'The sensitive route draft was removed after 5 minutes of inactivity.',
        });
      }, 5 * 60 * 1000);
    };
    clearTimer();
    window.addEventListener('pointerdown', clearTimer, { passive: true });
    window.addEventListener('keydown', clearTimer);
    return () => {
      window.removeEventListener('pointerdown', clearTimer);
      window.removeEventListener('keydown', clearTimer);
      if (corridorDraftExpiryRef.current) window.clearTimeout(corridorDraftExpiryRef.current);
      corridorDraftExpiryRef.current = null;
    };
  }, [activeSettingsSection, privacyCorridorWaypoints.length]);

  useEffect(() => {
    if (!privacyProtectionCheck) return undefined;
    let cancelled = false;
    setScreenCaptureAllowed(false).catch((error) => {
      if (!cancelled) logSystemFailure('privacy_protection_check_screen_capture_block', error);
    });
    return () => {
      cancelled = true;
      setScreenCaptureAllowed(cfgRef.current.allow_screen_capture === true).catch((error) => {
        logSystemFailure('privacy_protection_check_screen_capture_restore', error);
      });
    };
  }, [privacyProtectionCheck]);

  useEffect(() => {
    const suggestion = location.state?.privacyZoneSuggestion;
    if (!suggestion) return;
    const draft = privacyZoneDraftFromSuggestion(suggestion);
    if (!Number.isFinite(draft.location.lat) || !Number.isFinite(draft.location.lng)) return;
    setPrivacyDraft((current) => ({ ...current, label: draft.label, radius_m: draft.radius_m, type: 'circle' }));
    setSuggestedPrivacyLocation(draft.location);
    if (location.state?.previewPrivacyZoneSuggestion) {
      void openPrivacyProtectionCheck({
        type: 'circle',
        location: draft.location,
        sourceLabel: 'Suggested private place',
        radius_m: draft.radius_m,
        clearSuggestionOnSave: true,
      }, 'Verify to review this suggested private place');
    }
    setPrivacyDraftRadiusError('');
    setActiveSettingsSection('settings-privacy-data');
    clearSettingsSearch();
    navigate('/settings?section=settings-privacy-data', { replace: true, state: null });
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        document.getElementById('settings-privacy-data')?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      });
    }
  }, [location.state, navigate]);

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
    rescore_eligible_count: 0,
    rescore_ineligible_count: 0,
    mismatch_rescore_eligible_count: 0,
    mismatch_rescore_ineligible_count: 0,
    event_migration_version: 0,
    trips: [],
  } } = useQuery({
    queryKey: ['score-migration-summary'],
    queryFn: () => tripService.getScoreMigrationSummary(),
    enabled: activeSettingsSection === 'settings-detection-thresholds',
    staleTime: SETTINGS_HEAVY_QUERY_STALE_MS,
  });

  const getSettingsTrips = () => qc.fetchQuery({
    queryKey: ['settings-trips'],
    queryFn: () => tripService.listAll({ sort: '-start_time' }),
    staleTime: SETTINGS_HEAVY_QUERY_STALE_MS,
  });

  const getSettingsVehicles = () => qc.fetchQuery({
    queryKey: ['settings-vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 200 }),
    staleTime: SETTINGS_HEAVY_QUERY_STALE_MS,
  });

  const enqueuePrivacyZoneRescore = async (reason, zones, trips = null) => {
    const zoneList = (Array.isArray(zones) ? zones : [zones]).filter((zone) => zone?.id);
    if (!zoneList.length) return null;
    const sourceTrips = Array.isArray(trips) ? trips : await getSettingsTrips();
    const tripIds = Array.from(new Set(zoneList.flatMap((zone) => tripIdsAffectedByPrivacyZone(sourceTrips, zone))));
    return enqueueRescoreJob({
      reason,
      zoneId: zoneList[0].id,
      tripIds,
    }, { rescoreTrip: rescoreTripForQueue });
  };

  useEffect(() => {
    if (!['settings-detection-thresholds', 'settings-privacy-data'].includes(activeSettingsSection)) return;
    scheduleRescoringQueue({ rescoreTrip: rescoreTripForQueue });
    if (activeSettingsSection === 'settings-privacy-data') {
      getRawGpsLifecycleStatus().then(setRawGpsLifecycleStatus).catch((error) => {
        logSystemFailure('settings_raw_gps_lifecycle_status', error);
      });
    }
  }, [activeSettingsSection]);

  useEffect(() => {
    if (!privacyDeleteZone) {
      setPrivacyDeleteImpact({ loading: false, tripCount: null });
      setPrivacyDeletePurge(false);
      return undefined;
    }

    let active = true;
    setPrivacyDeleteImpact({ loading: true, tripCount: null });
    getSettingsTrips()
      .then((trips) => {
        if (!active) return;
        setPrivacyDeleteImpact({
          loading: false,
          tripCount: countTripsAffectedByPrivacyZone(trips, privacyDeleteZone),
        });
      })
      .catch((error) => {
        if (!active) return;
        logSystemFailure('settings_privacy_zone_delete_impact', error, {
          zone_id: privacyDeleteZone.id,
        });
        setPrivacyDeleteImpact({ loading: false, tripCount: null });
      });

    return () => {
      active = false;
    };
  }, [privacyDeleteZone]);

  const updateCfg = (patch) => {
    const currentCfg = cfgRef.current;
    const validation = validateSettingsPatch(patch);
    if (!validation.valid) {
      toast({
        title: 'Setting not saved',
        description: validation.errors[0],
        variant: 'destructive',
      });
      return currentCfg;
    }
    const nextCfg = { ...currentCfg, ...patch };
    const touchesEcoMultipliers = Object.prototype.hasOwnProperty.call(patch, 'eco_cruise_score_multiplier') ||
      Object.prototype.hasOwnProperty.call(patch, 'eco_idle_penalty_multiplier');
    if (touchesEcoMultipliers && wouldDisableEcoScore(nextCfg)) {
      toast({
        title: 'Eco setting not saved',
        description: 'Eco scoring needs either the cruise multiplier or idle multiplier above 0.',
        variant: 'destructive',
      });
      return currentCfg;
    }
    cfgRef.current = nextCfg;
    setCfg(nextCfg);

    const persist = () => new Promise((resolve) => {
      runAfterVisiblePaint(resolve);
    }).then(() => {
      const persisted = localSettings.update(patch);
      const failedKeys = Object.keys(patch).filter((key) => !Object.is(persisted[key], patch[key]));
      if (failedKeys.length) {
        throw new Error(`${failedKeys.join(', ')} did not persist.`);
      }
      setCfg((current) => {
        const reconciled = { ...current };
        Object.keys(patch).forEach((key) => {
          if (current[key] === nextCfg[key]) reconciled[key] = persisted[key];
        });
        cfgRef.current = reconciled;
        return reconciled;
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      return persisted;
    }).catch((error) => {
      setCfg((current) => {
        const rolledBack = { ...current };
        Object.keys(patch).forEach((key) => {
          if (current[key] === nextCfg[key]) rolledBack[key] = currentCfg[key];
        });
        cfgRef.current = rolledBack;
        return rolledBack;
      });
      toast({
        title: 'Setting not saved',
        description: error?.message || 'The setting could not be persisted.',
        variant: 'destructive',
      });
      return currentCfg;
    });
    settingsPersistenceQueueRef.current = settingsPersistenceQueueRef.current.then(persist, persist);
    return nextCfg;
  };

  const updateScreenCaptureAllowed = async (allowed) => {
    try {
      if (allowed && !await requireSensitiveAuthentication('Verify to allow screenshots and screen sharing')) return;
      await setScreenCaptureAllowed(allowed);
      updateCfg({ allow_screen_capture: allowed });
    } catch (error) {
      logSystemFailure('settings_screen_capture_protection', error);
      toast({
        title: 'Screen capture setting not changed',
        description: error?.message || 'Android could not update screen capture protection.',
        variant: 'destructive',
      });
    }
  };

  const handleVerifyAuditLog = async () => {
    setAuditVerifying(true);
    try {
      const result = await verifyChain();
      recordSystemEvent('audit_chain_verification_completed', {
        status: result.valid ? 'valid' : 'tampered',
        reason: result.reason || '',
      }, {
        category: 'security',
        severity: result.valid ? 'info' : 'warn',
        title: result.valid ? 'Privacy audit log verified' : 'Privacy audit log tamper check failed',
      });
      toast({
        title: result.valid ? 'Audit log intact' : 'Audit log tampered',
        description: result.valid
          ? `${result.length} entr${result.length === 1 ? 'y' : 'ies'} verified.`
          : `Entry ${result.brokenAt}: ${result.reason}`,
        variant: result.valid ? undefined : 'destructive',
      });
    } catch (error) {
      logSystemFailure('privacy_audit_log_verify', error);
      toast({
        title: 'Audit log verification failed',
        description: error?.message || 'Road Sage could not verify the privacy audit log.',
        variant: 'destructive',
      });
    } finally {
      setAuditVerifying(false);
    }
  };

  const requireSensitiveAuthentication = async (reason) => {
    if (!isAndroid()) return true;
    try {
      const result = await authenticateDevice(reason);
      if (result.verified) return true;
      toast({
        title: 'Authentication required',
        description: result.cancelled ? 'Authentication was cancelled.' : 'Your identity could not be verified.',
        variant: 'destructive',
      });
    } catch (error) {
      logSystemFailure('settings_sensitive_action_authentication', error, { reason });
      toast({
        title: 'Authentication unavailable',
        description: error?.message || 'Set up a device screen lock, fingerprint, or secure face unlock first.',
        variant: 'destructive',
      });
    }
    return false;
  };

  const openPrivacyProtectionCheck = async (check, reason = 'Verify to review this private area') => {
    const validation = validatePrivacyRadius(check?.radius_m ?? privacyDraft.radius_m);
    if (!validation.valid) {
      setPrivacyDraftRadiusError(validation.error);
      toast({
        title: 'Privacy zone radius needs fixing',
        description: validation.error,
        variant: 'destructive',
      });
      return false;
    }
    if (!await requireSensitiveAuthentication(reason)) return false;
    setPrivacyDraftRadiusError('');
    setPrivacyProtectionCheck({
      ...check,
      radius_m: String(validation.radius),
      sensitivity: privacyDraft.sensitivity === 'high' ? 'high' : 'standard',
      durationDays: privacyDraft.durationDays,
    });
    return true;
  };

  const updateAppLockEnabled = async (enabled) => {
    if (enabled) {
      try {
        const availability = await getDeviceAuthenticationAvailability();
        if (!availability.available) {
          toast({
            title: 'Device authentication not set up',
            description: 'Set a device PIN, password, pattern, fingerprint, or secure face unlock first.',
            variant: 'destructive',
          });
          return;
        }
      } catch (error) {
        logSystemFailure('settings_app_lock_availability', error);
        toast({
          title: 'Could not check device authentication',
          description: error?.message || 'Try again after reopening Road Sage.',
          variant: 'destructive',
        });
        return;
      }
    }
    if (!await requireSensitiveAuthentication(enabled ? 'Verify to enable the Road Sage app lock' : 'Verify to disable the Road Sage app lock')) return;
    updateCfg({ app_lock_enabled: enabled });
    window.dispatchEvent(new CustomEvent(APP_LOCK_SETTING_EVENT, {
      detail: { enabled, authenticated: true },
    }));
  };

  const refreshDeviceIntegrity = async ({ showSuccess = true } = {}) => {
    if (!isAndroid()) return;
    setIntegrityChecking(true);
    try {
      const result = await checkIntegrity();
      setIntegrity(result);
      setCfg(localSettings.get());
      if (showSuccess) {
        toast({
          title: result.secure ? 'Device integrity check passed' : 'Device security concern detected',
          description: result.secure
            ? 'No root, debug, emulator, or USB debugging signals were detected.'
            : 'Privacy-zone display is allowed only if you turn it on, and new privacy-zone storage is blocked while the guard is on.',
          variant: result.secure ? undefined : 'destructive',
        });
      }
    } catch (error) {
      logSystemFailure('settings_device_integrity_check', error);
      toast({
        title: 'Device integrity check failed',
        description: error?.message || 'Road Sage could not query Android integrity signals.',
        variant: 'destructive',
      });
    } finally {
      setIntegrityChecking(false);
    }
  };

  const updateShowPrivacyCircles = (enabled) => {
    if (enabled && integrity?.secure === false) {
      toast({
        title: 'Privacy circles can reveal sensitive places',
        description: 'This device has integrity warnings. Road Sage will show only offset and expanded circles, but they can still hint at private locations.',
        variant: 'destructive',
        duration: 9000,
      });
    }
    updateCfg({ show_privacy_circles: enabled });
  };

  const showPrivacyNativeSyncFailure = (error, title = 'Privacy zone not saved') => {
    setCfg(localSettings.get());
    toast({
      title,
      description: error?.message || 'Android privacy-zone sync failed. Background auto tracking was turned off until zones sync.',
      variant: 'destructive',
      duration: 9000,
    });
  };

  const legalNoticeStatus = useMemo(() => {
    const acceptedVersion = Number(cfg.legal_notice_ack_version) || 0;
    const acceptedDate = formatLegalNoticeDate(cfg.legal_notice_acknowledged_at);

    if (acceptedVersion >= LEGAL_NOTICE_ACK_VERSION) {
      return acceptedDate
        ? `Accepted ${acceptedDate} - Version ${acceptedVersion}`
        : `Accepted - Version ${acceptedVersion}`;
    }

    if (acceptedVersion > 0) {
      return acceptedDate
        ? `Accepted ${acceptedDate} - Version ${acceptedVersion}; current version ${LEGAL_NOTICE_ACK_VERSION} needs review`
        : `Version ${acceptedVersion} accepted; current version ${LEGAL_NOTICE_ACK_VERSION} needs review`;
    }

    return `Not yet accepted - Version ${LEGAL_NOTICE_ACK_VERSION}`;
  }, [cfg.legal_notice_ack_version, cfg.legal_notice_acknowledged_at]);

  const legalNoticeNeedsReview = (Number(cfg.legal_notice_ack_version) || 0) < LEGAL_NOTICE_ACK_VERSION;

  useEffect(() => {
    setOsrmEndpointDraft(cfg.osrm_map_matching_url || '');
  }, [cfg.osrm_map_matching_url]);

  useEffect(() => {
    if (!isAndroid() || activeSettingsSection !== 'settings-privacy-data') return;
    void refreshDeviceIntegrity({ showSuccess: false });
  }, [activeSettingsSection]);

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
      const privacyRescore = isPrivacyRescoreReason(detail.reason);
      if (detail.status === 'pending') {
        setRescoreStatus(privacyRescore
          ? `Queued privacy re-score for ${detail.total || 0} trip${detail.total === 1 ? '' : 's'}.`
          : `Queued trip re-score for ${detail.total || 0} trip${detail.total === 1 ? '' : 's'}.`);
      }
      if (detail.status === 'running') {
        setRescoreStatus(privacyRescore
          ? `Updating privacy-affected trip scores ${detail.completed || 0}/${detail.total || 0}.`
          : detail.reason === 'auto_provenance'
          ? `Updating older trip scores ${detail.completed || 0}/${detail.total || 0}.`
          : `Refreshing stored trip scores ${detail.completed || 0}/${detail.total || 0}.`);
      }
      if (detail.status === 'complete') {
        setRescoreStatus(privacyRescore
          ? `${detail.completed || 0} privacy-affected trip${detail.completed === 1 ? '' : 's'} re-scored.`
          : `${detail.completed || 0} trip${detail.completed === 1 ? '' : 's'} re-scored.`);
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

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onNativePrivacySyncFailed = (event) => {
      setCfg(localSettings.get());
      toast({
        title: 'Android privacy guard not synced',
        description: event?.detail?.message || 'Background auto tracking was turned off until Android receives the privacy-zone guard.',
        variant: 'destructive',
        duration: 9000,
      });
    };
    window.addEventListener(NATIVE_PRIVACY_SYNC_FAILED_EVENT, onNativePrivacySyncFailed);
    return () => window.removeEventListener(NATIVE_PRIVACY_SYNC_FAILED_EVENT, onNativePrivacySyncFailed);
  }, []);

  const dismissHeadingEventMigrationNote = async () => {
    await setJson(TRIP_EVENT_MIGRATION_NOTE_DISMISSED_KEY, true);
    setHeadingEventMigrationNoteVisible(false);
  };

  const enableOsrmMapMatching = (enabled) => {
    if (!enabled) {
      updateCfg({ map_matching_enabled: false });
      return;
    }
    if (!cfg.osrm_map_matching_url || cfg.osrm_data_sharing_consented !== true) {
      toast({
        title: 'OSRM endpoint not ready',
        description: 'Save a trusted OSRM endpoint and confirm data sharing before route snapping can run.',
        variant: 'destructive',
      });
      return;
    }
    updateCfg({ map_matching_enabled: true });
  };

  const runOsrmEndpointHealthCheck = async (endpoint) => {
    setOsrmHealthCheckState('checking');
    const result = await checkOsrmEndpointHealth(endpoint);
    const patch = {
      osrm_health_status: result.ok ? 'connected' : 'unreachable',
      osrm_last_health_checked_at: result.checked_at,
      osrm_last_health_error: result.error || '',
      ...(result.ok ? { osrm_last_reachable_at: result.checked_at } : {}),
    };
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
        osrm_consent_invalidated_reason: '',
        osrm_consent_invalidated_at: '',
        osrm_consent_invalidated_zone_label: '',
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
    updateCfg({
      map_matching_enabled: true,
      osrm_map_matching_url: value,
      osrm_public_demo_consent_at: '',
      osrm_data_sharing_consented: true,
      osrm_data_sharing_consented_at: consentedAt,
      osrm_consent_invalidated_reason: '',
      osrm_consent_invalidated_at: '',
      osrm_consent_invalidated_zone_label: '',
      ...patch,
    });
    toast({
      title: result.ok ? 'OSRM endpoint connected' : 'OSRM endpoint saved, but unreachable',
      description: result.ok ? 'Route snapping can use this endpoint when you tap Get Road Data.' : result.error,
      variant: result.ok ? undefined : 'destructive',
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
      updateCfg({
        external_context_auto_fetch_enabled: false,
        external_context_auto_fetch_consented_at: '',
      });
      return;
    }
    const enabledLookups = [
      cfg.speed_limit_lookup_enabled !== false ? 'OpenStreetMap speed-limit' : null,
      cfg.weather_context_enabled !== false ? 'Open-Meteo weather' : null,
    ].filter(Boolean).join(' and ') || 'enabled road-data';
    const ok = typeof window === 'undefined' || window.confirm(
      `Automatic road data queues ${enabledLookups} lookups with randomized privacy delays whenever a trip is saved. OSRM route snapping still stays manual. Continue?`
    );
    if (!ok) return;
    updateCfg({
      external_context_auto_fetch_enabled: true,
      external_context_auto_fetch_consented_at: new Date().toISOString(),
    });
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

  const runVoiceSpeedMarkerTest = async () => {
    if (!isAndroid()) {
      setVoiceSpeedMarkerTestStatus('Voice speed marker listening is available on Android.');
      return;
    }
    if (voiceSpeedMarkerTestBusy) return;
    setVoiceSpeedMarkerTestBusy(true);
    setVoiceSpeedMarkerTestStatus('Listening now. Say "Road Sage speed 60" or "posted speed is 60".');
    try {
      const microphoneGranted = await requestMicrophonePermission();
      if (!microphoneGranted) {
        setVoiceSpeedMarkerTestStatus('Microphone permission is needed to test voice speed markers.');
        return;
      }
      const result = await testVoiceSpeedMarkerRecognition({ timeoutMs: 10000 });
      if (result.recognized) {
        setVoiceSpeedMarkerTestStatus(
          `Heard ${result.limitKmh} km/h${result.posted ? ' as a posted sign' : ' as an estimate'}${result.transcript ? ` from "${result.transcript}"` : ''}.`
        );
      } else if (result.transcript) {
        setVoiceSpeedMarkerTestStatus(`Heard "${result.transcript}", but it was not a speed marker phrase.`);
      } else {
        const reason = String(result.reason || '').replace(/_/g, ' ');
        setVoiceSpeedMarkerTestStatus(`No speed marker was recognized${reason ? ` (${reason})` : ''}.`);
      }
    } catch (error) {
      setVoiceSpeedMarkerTestStatus(error?.message || 'Voice speed marker test could not run.');
    } finally {
      setVoiceSpeedMarkerTestBusy(false);
    }
  };

  const runCalibration = async () => {
    setCalibLoading(true);
    try {
      const [trips, surveyLabels] = await Promise.all([
        tripService.listAll({ sort: '-start_time' }),
        calibrationLabelService.listLocalLabels(),
      ]);
      const profile = computeCalibrationProfile(trips, buildDrivingThresholds(cfg), { surveyLabels });
      await saveCalibrationProfile(profile);
      setCalibProfile(profile);
      recordSystemEvent('calibration_profile_analyzed', {
        trip_count: Array.isArray(trips) ? trips.length : 0,
        survey_label_count: Array.isArray(surveyLabels) ? surveyLabels.length : 0,
        insufficient: profile.insufficient === true,
        confidence: profile.confidence || profile.surveySummary?.confidence || null,
      }, { category: 'calibration', title: 'Calibration profile analyzed' });
    } catch (error) {
      logSystemFailure('calibration_profile_analyze_failed', error, {
        survey_label_count: calibrationLabels.length,
      });
      throw error;
    } finally {
      setCalibLoading(false);
    }
  };

  const refreshCalibrationLabels = async () => {
    try {
      const [labels, markers] = await Promise.all([
        calibrationLabelService.listLocalLabels(),
        calibrationLabelService.listTripSurveyMarkers(),
      ]);
      setCalibrationLabels(labels);
      setCalibrationMarkers(markers);
      recordSystemEvent('calibration_labels_refreshed', {
        label_count: Array.isArray(labels) ? labels.length : 0,
        marker_count: markers && typeof markers === 'object' ? Object.keys(markers).length : 0,
      }, { category: 'calibration', title: 'Survey labels refreshed' });
      return { labels, markers };
    } catch (error) {
      logSystemFailure('calibration_labels_refresh_failed', error);
      throw error;
    }
  };

  const deleteCalibrationLabel = async (labelId) => {
    try {
      await calibrationLabelService.deleteLocalLabel(labelId);
      await refreshCalibrationLabels();
      setCalibrationLabelStatus('Survey label deleted.');
      setTimeout(() => setCalibrationLabelStatus(''), 2500);
    } catch (error) {
      logSystemFailure('calibration_label_delete_action_failed', error, {
        label_id_present: Boolean(labelId),
      });
      setCalibrationLabelStatus('Could not delete survey label.');
    }
  };

  const clearCalibrationLabels = async () => {
    if (typeof window !== 'undefined' && !window.confirm('Delete all local survey labels and answered-trip markers?')) return;
    try {
      const deletedLabels = calibrationLabels.length;
      const deletedMarkers = Object.keys(calibrationMarkers).length;
      await calibrationLabelService.replaceLocalLabels([]);
      await calibrationLabelService.replaceTripSurveyMarkers({});
      await refreshCalibrationLabels();
      recordSystemEvent('calibration_labels_cleared', {
        deleted_label_count: deletedLabels,
        deleted_marker_count: deletedMarkers,
      }, { category: 'calibration', title: 'Survey labels cleared' });
      setCalibrationLabelStatus('All local survey labels cleared.');
      setTimeout(() => setCalibrationLabelStatus(''), 2500);
    } catch (error) {
      logSystemFailure('calibration_labels_clear_failed', error, {
        label_count: calibrationLabels.length,
        marker_count: Object.keys(calibrationMarkers).length,
      });
      setCalibrationLabelStatus('Could not clear survey labels.');
    }
  };

  const refreshTripScoreQueries = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['settings-trips'] }),
      qc.invalidateQueries({ queryKey: ['score-migration-summary'] }),
      qc.invalidateQueries({ queryKey: ['trip-summaries'] }),
      qc.invalidateQueries({ queryKey: ['map-trips'] }),
      qc.invalidateQueries({ queryKey: ['trips'] }),
    ]);
  };

  const runPrivacyZoneProtectionTest = async () => {
    if (privacyProtectionTestBusy) return;
    setPrivacyProtectionTestBusy(true);
    setPrivacyProtectionTest(null);
    try {
      invalidateSelfTestCache('privacy_zone_protection');
      const result = await selfTestPrivacyZoneProtection();
      setPrivacyProtectionTest(result);
      recordSystemEvent('privacy_zone_protection_self_test_completed', {
        status: result.status,
      }, {
        category: 'privacy',
        severity: result.status === 'ok' ? 'info' : 'warn',
        title: 'Privacy-zone protection self-test completed',
      });
    } catch (error) {
      logSystemFailure('privacy_zone_protection_self_test', error);
      setPrivacyProtectionTest({
        status: 'error',
        evidence: error?.message || 'The privacy-zone self-test could not finish.',
      });
    } finally {
      setPrivacyProtectionTestBusy(false);
    }
  };

  const updateHeightenedPrivacyMode = async (enabled) => {
    if (!enabled) {
      updateCfg({ heightened_privacy_mode: false });
      return;
    }

    const confirmed = typeof window === 'undefined' || window.confirm(
      'Turn on heightened privacy mode? Existing raw GPS inside every configured privacy zone will be permanently erased. Scores, distance, duration, and summaries will remain.'
    );
    if (!confirmed) return;

    updateCfg({ heightened_privacy_mode: true });
    try {
      const result = await purgeExistingGpsForHeightenedPrivacy({
        ...cfgRef.current,
        heightened_privacy_mode: true,
      });
      if (result.pointsPurged > 0 || result.eventsPurged > 0) {
        toast({
          title: 'Heightened privacy enabled',
          description: `Removed ${result.pointsPurged} stored GPS point${result.pointsPurged === 1 ? '' : 's'} and ${result.eventsPurged} event location${result.eventsPurged === 1 ? '' : 's'} from configured privacy zones.`,
        });
      }
    } catch (error) {
      logSystemFailure('heightened_privacy_existing_gps_purge', error);
      toast({
        title: 'Heightened privacy is on',
        description: 'New activity is protected, but existing GPS cleanup could not be completed. Try enabling the mode again after checking storage access.',
        variant: 'destructive',
      });
    }
  };

  const runCompletedTripRescore = async ({ onlyProvenanceMismatch = false, reason = 'manual' } = {}) => {
    setRescoreBusy(true);
    setRescoreResult(null);
    setRescoreStatus('Preparing stored trip data for re-scoring.');
    try {
      const result = await tripService.rescoreCompletedTrips({ onlyProvenanceMismatch, reason });
      await refreshTripScoreQueries();
      setRescoreResult(result);
      if (result.queued > 0) {
        setRescoreStatus(`${result.queued} trip${result.queued === 1 ? '' : 's'} queued on the server.`);
      } else if (result.completed === 0) {
        setRescoreStatus(result.skipped > 0
          ? `No eligible trips were updated. ${result.skipped} lacked retained route data.`
          : 'No trips needed re-scoring.');
      } else {
        setRescoreStatus(
          `${result.completed} trip${result.completed === 1 ? '' : 's'} updated: ` +
          `${result.changed} score${result.changed === 1 ? '' : 's'} changed, ` +
          `${result.unchanged} stayed the same` +
          `${result.skipped ? `, ${result.skipped} skipped` : ''}` +
          `${result.failed ? `, ${result.failed} failed` : ''}.`
        );
      }
      return result;
    } catch (error) {
      setRescoreStatus('Trip scores could not be updated. Your existing scores were kept.');
      toast({
        title: 'Re-score failed',
        description: error instanceof Error ? error.message : 'The trip history could not be recalculated.',
        variant: 'destructive',
      });
      return null;
    } finally {
      setRescoreBusy(false);
    }
  };

  const applyCalibration = async () => {
    const updated = await applyCalibrationProfile(calibProfile, cfg, async (next) => {
      const current = localSettings.get();
      const patch = Object.fromEntries(
        Object.entries(next).filter(([key, value]) => current[key] !== value)
      );
      const verified = Object.keys(patch).length ? localSettings.update(patch) : current;
      setCfg(verified);
    });
    await runCompletedTripRescore({ reason: 'calibration_applied' });
    setCfg(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    setCalibProfile(await loadCalibrationProfile());
  };

  const rescoreTrips = async () => {
    await getPermissionStatus().catch(() => null);
    const onlyProvenanceMismatch = (scoreMigrationSummary.mismatch_count || 0) > 0;
    setRescoreConfirmOpen(false);
    await runCompletedTripRescore({ onlyProvenanceMismatch, reason: 'manual' });
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

  const updateRetention = async (days) => {
    const currentDays = Number(cfg.data_retention_days || 0);
    if (days === currentDays) return;
    const periodLabel = days === 0 ? 'forever' : days === 365 ? '1 year' : `${days} days`;
    if (days > 0 && typeof window !== 'undefined' && !window.confirm(
      `Keep complete trips for ${periodLabel}? Trips older than ${periodLabel} will be permanently deleted from this device as soon as this setting is saved. Existing backup files are not changed.`
    )) return;

    updateCfg({ data_retention_days: days });
    await settingsPersistenceQueueRef.current;
    if (Number(localSettings.get().data_retention_days || 0) !== days) return;
    recordSystemEvent('trip_retention_setting_changed', {
      previous_days: currentDays,
      retention_days: days,
    }, { category: 'settings', title: 'Trip retention setting changed' });
    try {
      const result = await enforceTripDataRetention();
      await qc.invalidateQueries();
      toast({
        title: 'Trip retention updated',
        description: days === 0
          ? 'Complete trips will be kept until you delete them.'
          : `${result.deletedTrips} expired trip${result.deletedTrips === 1 ? '' : 's'} deleted. Future trips older than ${periodLabel} will be removed automatically.`,
      });
    } catch (error) {
      logSystemFailure('trip_data_retention_enforcement', error, { retention_days: days });
      toast({
        title: 'Retention saved, cleanup failed',
        description: 'The new retention period was saved, but expired trips could not be deleted right now.',
        variant: 'destructive',
      });
    }
  };

  const updatePrivacyLogRetention = async (hours) => {
    const previousHours = Number(cfg.privacy_log_retention_hours ?? 24);
    if (hours === previousHours) return;
    updateCfg({ privacy_log_retention_hours: hours });
    await settingsPersistenceQueueRef.current;
    if (Number(localSettings.get().privacy_log_retention_hours ?? 24) !== hours) return;
    recordSystemEvent('log_retention_setting_changed', {
      previous_hours: previousHours,
      retention_hours: hours,
    }, { category: 'settings', title: 'Privacy log retention changed' });
    toast({
      title: 'Privacy log retention updated',
      description: hours === 0
        ? 'Privacy-operation logging is off. Non-privacy System Logs are still kept for 3 days.'
        : `Privacy-operation records will be kept for ${hours} hour${hours === 1 ? '' : 's'}.`,
    });
  };

  const updateRawGpsRetention = async (days) => {
    const currentDays = Number(cfg.raw_gps_retention_days || 0);
    if (days === currentDays) return;

    if (days > 0 && typeof window !== 'undefined') {
      const periodLabel = days >= 365 && days % 365 === 0
        ? `${days / 365} year${days === 365 ? '' : 's'}`
        : `${days} days`;
      const confirmed = window.confirm(
        `Set raw GPS retention to ${periodLabel}? On the next cleanup, trips older than ${periodLabel} will permanently lose their route line on the map and playback. Scores, distance, duration, and summaries will remain. Existing backup files are not changed.`
      );
      if (!confirmed) return;
    }

    updateCfg({ raw_gps_retention_days: days });
    await settingsPersistenceQueueRef.current;
    if (Number(localSettings.get().raw_gps_retention_days || 0) !== days) return;
    recordSystemEvent('raw_gps_retention_setting_changed', {
      previous_days: currentDays,
      retention_days: days,
    }, { category: 'settings', title: 'Raw GPS retention changed' });
    toast({
      title: 'Raw GPS retention updated',
      description: days === 0
        ? 'Route coordinates will be kept with each trip until the trip is deleted.'
        : `Route coordinates older than ${days === 365 ? '1 year' : `${days} days`} will be removed during automatic cleanup or when you tap Run now.`,
    });
  };

  const runRawGpsRetentionNow = async () => {
    const retentionDays = Number(cfg.raw_gps_retention_days || 0);
    const periodLabel = retentionDays >= 365 && retentionDays % 365 === 0
      ? `${retentionDays / 365} year${retentionDays === 365 ? '' : 's'}`
      : `${retentionDays} days`;
    if (typeof window !== 'undefined' && !window.confirm(
      `Remove route coordinates from trips older than ${periodLabel} now? Their route line on the map and playback will be permanently unavailable on this device. Scores, distance, duration, and summaries will remain.`
    )) return;

    setRawGpsLifecycleBusy(true);
    try {
      const result = await enforceRawGpsRetention({ force: true });
      setRawGpsLifecycleStatus(result);
      await qc.invalidateQueries();
      recordSystemEvent('raw_gps_retention_run_completed', {
        retention_days: retentionDays,
        purged_trip_count: result.purgedTrips || 0,
        purged_point_count: result.purgedPoints || 0,
      }, { category: 'storage', title: 'Raw GPS retention run completed' });
      toast({
        title: 'Route retention enforced',
        description: result.enabled
          ? `Expired route data was removed from ${result.purgedTrips || 0} trip${result.purgedTrips === 1 ? '' : 's'}.`
          : 'Raw GPS expiration is currently off.',
      });
    } catch (error) {
      logSystemFailure('settings_raw_gps_retention_enforcement', error);
      toast({
        title: 'Route retention failed',
        description: 'Old route data could not be removed.',
        variant: 'destructive',
      });
    } finally {
      setRawGpsLifecycleBusy(false);
    }
  };

  const showPrivacyPolicy = () => {
    setLegalNoticeOpen(true);
    recordSystemEvent('legal_notice_review_opened', {
      source: 'settings_privacy_data',
    }, {
      title: 'Legal notice opened',
      category: 'settings',
    });
  };

  const acknowledgeLegalNoticeReview = () => {
    if (legalNoticeNeedsReview) {
      const acknowledgedAt = new Date().toISOString();
      updateCfg({
        legal_notice_ack_version: LEGAL_NOTICE_ACK_VERSION,
        legal_notice_acknowledged_at: acknowledgedAt,
      });
      recordSystemEvent('legal_notice_review_acknowledged', {
        notice_version: LEGAL_NOTICE_ACK_VERSION,
        acknowledged_at: acknowledgedAt,
        source: 'settings_privacy_data',
      }, {
        title: 'Legal notice reviewed',
        category: 'settings',
      });
    }
    setLegalNoticeOpen(false);
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
      if (cfg.privacy_zones_native_sync_status === NATIVE_PRIVACY_SYNC_STATUS_FAILED) {
        toast({
          title: 'Background tracking blocked',
          description: 'Re-save a privacy zone so Android receives the native privacy guard before enabling background auto tracking.',
          variant: 'destructive',
          duration: 9000,
        });
        return;
      }

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
      } catch {}
      try {
        setBatteryStatus(await getAndroidBatteryOptimizationStatus());
      } catch {}
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
      } catch {}
    }
    return latest;
  };

  useEffect(() => {
    localSettings.hydrateFromNative().then((latest) => {
      cfgRef.current = latest;
      setCfg(latest);
    });
  }, []);

  useEffect(() => {
    const permissionSections = new Set([
      'settings-tracking',
      'settings-android-permissions',
      'settings-feature-permissions',
      'settings-notifications',
      'settings-advanced-models',
      'settings-phone-use',
    ]);
    if (permissionSections.has(activeSettingsSection)) refreshPermissions();
  }, [activeSettingsSection]);

  useEffect(() => {
    if (activeSettingsSection !== 'settings-detection-thresholds' || calibProfile) return;
    loadCalibrationProfile().then(setCalibProfile);
  }, [activeSettingsSection, calibProfile]);

  useEffect(() => {
    if (activeSettingsSection !== 'settings-privacy-data') return;
    refreshCalibrationLabels().catch((error) => {
      logSystemFailure('settings_initial_calibration_labels_load_failed', error);
    });
    getLastParkedLocation().then(setParkedLocation);
    loadPrivacyZonesFromStorage().then(() => {
      const latest = localSettings.get();
      cfgRef.current = latest;
      setCfg(latest);
    }).catch((error) => {
      logSystemFailure('settings_privacy_zones_secure_load', error);
    });
  }, [activeSettingsSection]);

  const privacyZones = getPrivacyZones(cfg);
  const privacyZoneOverlaps = findOverlappingZones(privacyZones);
  const calibrationSurveySummary = useMemo(
    () => summarizeCalibrationSurveyLabels(calibrationLabels),
    [calibrationLabels]
  );
  const calibrationSurveyCoverage = useMemo(
    () => summarizeSurveyCoverage(calibrationLabels),
    [calibrationLabels]
  );
  const answeredCalibrationTrips = Object.keys(calibrationMarkers).length;
  const excludedCalibrationLabels = calibrationLabels.filter((label) => label?.eligibleForCalibration === false).length;
  const recentCalibrationLabels = calibrationLabels.slice(0, 5);

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

  const savePrivacyZone = async (location, sourceLabel, radiusValue = privacyDraft.radius_m) => {
    if (integrity?.secure === false && cfg.privacy_zone_storage_requires_secure_device !== false) {
      toast({
        title: 'Privacy zone not saved',
        description: 'This Android environment has integrity warnings. Turn off the secure-device storage guard only if you accept that rooted or debug-enabled devices can expose private places.',
        variant: 'destructive',
        duration: 9000,
      });
      return false;
    }

    const validation = validatePrivacyRadius(radiusValue);
    if (!validation.valid) {
      setPrivacyDraftRadiusError(validation.error);
      toast({
        title: 'Privacy zone radius needs fixing',
        description: validation.error,
        variant: 'destructive',
      });
      return false;
    }

    const isCorridor = privacyDraft.type === 'corridor';
    const lat = Number(location?.lat);
    const lng = Number(location?.lng);
    if (!isCorridor && (!Number.isFinite(lat) || !Number.isFinite(lng))) {
      toast({
        title: 'No location available',
        description: 'Try again after Road Sage has a current or parked location.',
        variant: 'destructive',
      });
      return false;
    }
    if (
      isCorridor &&
      (
        privacyCorridorWaypoints.length < PRIVACY_CORRIDOR_MIN_WAYPOINTS ||
        privacyCorridorWaypoints.length > PRIVACY_CORRIDOR_MAX_WAYPOINTS
      )
    ) {
      toast({
        title: 'Corridor needs more points',
        description: `Add ${PRIVACY_CORRIDOR_MIN_WAYPOINTS}-${PRIVACY_CORRIDOR_MAX_WAYPOINTS} local waypoints before saving.`,
        variant: 'destructive',
      });
      return false;
    }
    setPrivacyDraftRadiusError('');
    const durationDays = Number(privacyDraft.durationDays);
    const expiresAt = privacyDraft.durationDays === 'permanent' || !Number.isFinite(durationDays)
      ? null
      : new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    const zoneToSave = {
      id: `pz_${Date.now().toString(36)}`,
      label: privacyDraft.label || sourceLabel,
      type: isCorridor ? 'corridor' : 'circle',
      radius_m: validation.radius,
      ...(isCorridor ? {
        width_m: validation.radius,
        waypoints: privacyCorridorWaypoints,
      } : {
        lat,
        lng,
      }),
      sensitivity: privacyDraft.sensitivity === 'high' ? 'high' : 'standard',
      ...(expiresAt ? { expiresAt } : {}),
      purge_existing_gps: true,
    };
    try {
      const updated = await upsertPrivacyZone(zoneToSave, cfg);
      void invalidateRouteRiskIndex();
      setCfg(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      void enqueuePrivacyZoneRescore('privacy_zone_added', zoneToSave);
      if (isCorridor) {
        setPrivacyCorridorWaypoints([]);
        toast({
          title: 'Route corridor protected',
          description: 'Exact corridor geometry was discarded. Hashed protection coverage remains active for storage and outbound-data guards.',
        });
      } else {
        toast({
          title: 'Privacy circle protected',
          description: 'The zone is active for route storage and outbound-data guards.',
        });
      }
      return true;
    } catch (error) {
      showPrivacyNativeSyncFailure(error);
      return false;
    }
  };

  const addCurrentPrivacyZone = async () => {
    try {
      const location = await getCurrentLocation();
      await openPrivacyProtectionCheck(
        { type: 'circle', location, sourceLabel: 'Current location' },
        'Verify to review protection for your current location'
      );
    } catch (error) {
      logSystemFailure('settings_privacy_zone_current_location', error);
      toast({
        title: 'Could not get current location',
        description: error.message || 'Check location permission and GPS availability.',
        variant: 'destructive',
      });
    }
  };

  const addCurrentCorridorWaypoint = async () => {
    try {
      const current = await getCurrentLocation();
      const lat = Number(current?.lat);
      const lng = Number(current?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('No current GPS point is available.');
      setPrivacyCorridorWaypoints((points) => (
        points.length >= PRIVACY_CORRIDOR_MAX_WAYPOINTS ? points : points.concat({ lat, lng })
      ));
    } catch (error) {
      toast({
        title: 'Could not add current waypoint',
        description: error?.message || 'Check location permission and try again.',
        variant: 'destructive',
      });
    }
  };

  const useRecentTripForCorridor = async () => {
    const trips = await getSettingsTrips();
    const sourceTrip = trips.find((trip) => (
      Array.isArray(trip?.route_points) &&
      trip.route_points.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng)).length >= 2
    ));
    const waypoints = corridorWaypointsFromRoute(sourceTrip?.route_points || []);
    if (waypoints.length < PRIVACY_CORRIDOR_MIN_WAYPOINTS) {
      toast({
        title: 'No local route available',
        description: 'Save a trip with at least two route points before creating a route corridor.',
        variant: 'destructive',
      });
      return;
    }
    setPrivacyCorridorWaypoints(waypoints);
    await openPrivacyProtectionCheck(
      { type: 'corridor', waypoints, sourceLabel: 'Recent trip route' },
      'Verify to review this saved route corridor'
    );
  };

  const clearPrivacyZoneDeleteState = () => {
    setPrivacyDeleteZone(null);
    setPrivacyDeletePurge(false);
    setPrivacyDeleteBusy(false);
    setPrivacyDeleteImpact({ loading: false, tripCount: null });
  };

  const requestDeletePrivacyZone = (zone) => {
    setPrivacyDeleteZone(zone);
    setPrivacyDeletePurge(false);
  };

  const removePrivacyZoneFromSettings = async (id) => {
    const updated = await removePrivacyZone(id, cfg);
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
    return updated;
  };

  const confirmDeletePrivacyZone = async () => {
    if (!privacyDeleteZone || privacyDeleteBusy) return;
    if (!await requireSensitiveAuthentication('Verify to delete this privacy zone')) return;
    setPrivacyDeleteBusy(true);

    try {
      let purgeResult = null;
      const tripsBeforeDelete = await getSettingsTrips();
      if (privacyDeletePurge) {
        purgeResult = await purgeGpsWithinPrivacyZone(
          tripsBeforeDelete,
          privacyDeleteZone,
          (id, patch) => tripService.update(id, patch)
        );
        qc.invalidateQueries({ queryKey: ['settings-trips'] });
      }

      await removePrivacyZoneFromSettings(privacyDeleteZone.id);
      const rescoreTripIds = privacyDeletePurge
        ? purgeResult?.tripIdsAffected || []
        : tripIdsAffectedByPrivacyZone(tripsBeforeDelete, privacyDeleteZone);
      void enqueueRescoreJob({
        reason: privacyDeletePurge ? 'privacy_zone_purged' : 'privacy_zone_deleted',
        zoneId: privacyDeleteZone.id,
        tripIds: rescoreTripIds,
      }, { rescoreTrip: rescoreTripForQueue });
      recordSystemEvent('privacy_zone_deleted', {
        zone_id: privacyDeleteZone.id,
        label: privacyDeleteZone.label,
        purge_raw_gps: privacyDeletePurge,
        affected_trip_count: privacyDeleteImpact.tripCount,
        purged_trip_count: purgeResult?.tripsAffected || 0,
        purged_point_count: purgeResult?.pointsPurged || 0,
        purged_event_count: purgeResult?.eventsPurged || 0,
      }, {
        category: 'privacy',
        severity: privacyDeletePurge ? 'warn' : 'info',
        title: privacyDeletePurge ? 'Privacy zone deleted and private GPS erased' : 'Privacy zone deleted',
      });
      toast({
        title: privacyDeletePurge ? 'Privacy zone deleted and private GPS erased' : 'Privacy zone deleted',
        description: privacyDeletePurge
          ? `Erased ${purgeResult?.pointsPurged || 0} private route point(s) and ${purgeResult?.eventsPurged || 0} private event(s) from ${purgeResult?.tripsAffected || 0} trip(s).`
          : 'Historical routes through this area may now be visible.',
        variant: privacyDeletePurge ? 'destructive' : undefined,
      });
      clearPrivacyZoneDeleteState();
    } catch (error) {
      logSystemFailure('settings_privacy_zone_delete', error, {
        zone_id: privacyDeleteZone.id,
        purge_raw_gps: privacyDeletePurge,
      });
      toast({
        title: 'Privacy zone not deleted',
        description: error.message || 'Try again after Road Sage finishes loading trip history.',
        variant: 'destructive',
      });
      setPrivacyDeleteBusy(false);
    }
  };

  const updatePrivacyZoneRadius = async (zone, rawValue) => {
    const validation = validatePrivacyRadius(rawValue);
    if (!validation.valid) {
      setPrivacyZoneRadiusErrors((errors) => ({ ...errors, [zone.id]: validation.error }));
      toast({
        title: `${zone.type === 'corridor' ? 'Corridor side buffer' : 'Privacy zone radius'} needs fixing`,
        description: validation.error,
        variant: 'destructive',
      });
      return;
    }

    const radius = validation.radius;
    const updatedZone = {
      ...zone,
      radius_m: radius,
      ...(zone.type === 'corridor' ? { width_m: radius } : {}),
    };
    try {
      const updated = await upsertPrivacyZone(updatedZone, cfg);
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
      void enqueuePrivacyZoneRescore('privacy_zone_updated', [zone, updatedZone]);
    } catch (error) {
      showPrivacyNativeSyncFailure(error, zone.type === 'corridor' ? 'Corridor side buffer not saved' : 'Privacy zone radius not saved');
    }
  };

  const mergeOverlappingPrivacyZones = async (pair) => {
    const mergedZone = mergePrivacyZones(pair.a, pair.b);
    if (!mergedZone) {
      toast({
        title: 'Privacy zones not merged',
        description: 'These zones do not have enough saved geometry to merge safely.',
        variant: 'destructive',
      });
      return;
    }
    if (mergedZone.radius_m > PRIVACY_RADIUS_MAX_M) {
      toast({
        title: 'Privacy zones not merged',
        description: `The merged radius would be ${Math.round(mergedZone.radius_m)} m, above the ${PRIVACY_RADIUS_MAX_M} m maximum.`,
        variant: 'destructive',
      });
      return;
    }

    let updated;
    try {
      const withMerged = await upsertPrivacyZone(mergedZone, cfg);
      const withoutA = await removePrivacyZone(pair.a.id, withMerged);
      updated = await removePrivacyZone(pair.b.id, withoutA);
    } catch (error) {
      showPrivacyNativeSyncFailure(error, 'Privacy zones not merged');
      return;
    }
    void invalidateRouteRiskIndex();
    setCfg(updated);
    setPrivacyRadiusDrafts((drafts) => {
      const next = { ...drafts, [mergedZone.id]: String(Math.round(mergedZone.radius_m)) };
      delete next[pair.a.id];
      delete next[pair.b.id];
      return next;
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    void enqueuePrivacyZoneRescore('privacy_zone_updated', [pair.a, pair.b, mergedZone]);
    toast({
      title: 'Privacy zones merged',
      description: `"${pair.a.label}" and "${pair.b.label}" are now one ${Math.round(mergedZone.radius_m)} m zone.`,
    });
  };

  useEffect(() => {
    if (!isAndroid()) return undefined;

    const refreshAndRestartIfReady = async () => {
      await refreshSettingsFromNative({ restartIfReady: true });
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
      logSystemFailure('settings_battery_optimization_open', new Error('Battery optimization settings could not be opened.'));
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
      logSystemFailure('obd_bluetooth_pairing', error);
      setObdPairingStatus(error?.message || 'Could not connect to the OBD-II adapter.');
      await refreshPermissions();
    }
  };

  const handleDeleteAllTrips = async () => {
    if (!confirm('Delete ALL trips? This cannot be undone.')) return;
    const trips = await getSettingsTrips();
    for (const t of trips) {
      await tripService.delete(t.id);
    }
    await Promise.all([
      setJson(SAVED_FILTERS_KEY, []),
      calibrationLabelService.replaceLocalLabels([]),
      calibrationLabelService.replaceTripSurveyMarkers({}),
      clearCalibrationProfile(),
      invalidateRouteRiskIndex(),
      clearMapMatchingCache(),
      clearOsmSpeedLimitCache(),
      clearWeatherContextCache(),
      isAndroid() ? clearNativeCompletedTrips() : Promise.resolve(),
    ]);
    setCalibrationLabels([]);
    setCalibrationMarkers({});
    setCalibProfile(null);
    recordSystemEvent('trip_history_deleted', {
      deleted_trip_count: trips.length,
      cleared_saved_filters: true,
      cleared_trip_calibration: true,
      cleared_external_context_caches: true,
      cleared_native_completed_trips: isAndroid(),
    }, { category: 'storage', severity: 'warn', title: 'Trip history deleted' });
    qc.invalidateQueries();
    toast({
      title: 'Trips deleted',
      description: 'Trip records and local trip-derived caches were removed from this device.',
    });
  };

  const handleExportAll = async () => {
    if (tripExportBusy) return;
    setTripExportBusy(true);
    try {
      const trips = await getSettingsTrips();
      const completed = trips.filter(t => t.status === 'completed');
      const csv = tripsToCSV(completed);
      const result = await downloadCSV(csv, `road-sage-all-trips-${new Date().toISOString().split('T')[0]}.csv`);
      recordSystemEvent('all_trips_export_completed', {
        trip_count: completed.length,
        native: result?.native === true,
        output_format: 'csv',
      }, { category: 'storage', title: 'All trips export completed' });
      toast({
        title: 'Trip export saved',
        description: result?.native
          ? `${result.filename} with ${completed.length} completed trip${completed.length === 1 ? '' : 's'} was saved to Downloads.`
          : `${result?.filename || 'Trip CSV'} with ${completed.length} completed trip${completed.length === 1 ? '' : 's'} is downloading.`,
      });
    } catch (error) {
      logSystemFailure('all_trips_export', error);
      toast({
        title: 'Trip export failed',
        description: error?.message || 'Road Sage could not export the trip CSV.',
        variant: 'destructive',
      });
    } finally {
      setTripExportBusy(false);
    }
  };

  const handleExportEverything = async () => {
    if (portabilityExportBusy) return;
    setPortabilityExportBusy(true);
    try {
      const result = await exportDataPortabilityBundle();
      recordSystemEvent('data_portability_export_completed', {
        trip_count: result.bundle?.trips?.length || 0,
        vehicle_count: result.bundle?.vehicles?.length || 0,
        privacy_zone_count: result.bundle?.privacyZones?.length || 0,
        score_history_count: result.bundle?.scoreHistory?.length || 0,
        native: result.native === true,
        output_format: 'json',
      }, { category: 'storage', title: 'Data portability export completed' });
      toast({
        title: 'Data export saved',
        description: result.native
          ? `${result.filename} was saved to Downloads.`
          : `${result.filename} is downloading.`,
      });
    } catch (error) {
      toast({
        title: 'Data export failed',
        description: error?.message || 'Road Sage could not export your data.',
        variant: 'destructive',
      });
    } finally {
      setPortabilityExportBusy(false);
    }
  };

  const handleEraseAllLocalData = async () => {
    if (erasureBusy) return;
    const confirmation = typeof window === 'undefined'
      ? ''
      : window.prompt('This erases trips, settings, privacy logs, zones, and local keys from this device. Type ERASE ROAD SAGE to continue.');
    if (confirmation !== 'ERASE ROAD SAGE') return;
    setErasureBusy(true);
    recordSystemEvent('local_data_erasure_confirmed', {}, {
      category: 'storage',
      severity: 'warn',
      title: 'Local data erasure confirmed',
      message: 'This entry is removed with the rest of local data if erasure succeeds.',
    });
    try {
      const result = await eraseAllLocalDataAndDownloadReceipt();
      if (typeof window !== 'undefined') {
        window.alert(`${result.filename} was exported. Road Sage will now reload so erased in-memory data is not reused.`);
        window.location.reload();
      }
    } catch (error) {
      if (error?.dataErased === true && typeof window !== 'undefined') {
        window.alert('All local Road Sage data was erased, but the proof-of-erasure receipt could not be saved. Road Sage will reload now.');
        window.location.reload();
        return;
      }
      setErasureBusy(false);
      toast({
        title: 'Erasure failed',
        description: error?.message || 'Road Sage could not finish erasing local data.',
        variant: 'destructive',
      });
    }
  };

  const backupExportPassphraseChecks = backupPasswordRequirements(backupExportPassphrase);
  const backupExportPassphraseStrong = Object.values(backupExportPassphraseChecks).every(Boolean);
  const backupExportPassphraseReady = backupExportPassphraseStrong &&
    backupExportPassphrase === backupExportConfirm;
  const backupExportReady = backupExportPlaintext || backupExportPassphraseReady;

  const showBackupExportToast = (result) => {
    recordSystemEvent('backup_export_user_notified', {
      encrypted: result?.encrypted === true,
      native: result?.native === true,
      native_fallback: result?.nativeFallback === true,
      output_format: result?.encrypted ? 'encrypted' : 'json',
    }, { category: 'storage', title: 'Backup export notification shown' });
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
    setBackupExportPassphrase('');
    setBackupExportConfirm('');
    setBackupExportPlaintext(false);
    setBackupExportPasswordVisible(false);
    setBackupExportConfirmVisible(false);
    setBackupExportOpen(true);
    recordSystemEvent('backup_export_dialog_opened', {
      default_output_format: 'encrypted',
    }, { category: 'storage', title: 'Backup export dialog opened' });
  };

  const performExportBackup = async () => {
    if (!backupExportReady || backupExportBusy) return;
    if (backupExportPlaintext && !await requireSensitiveAuthentication('Verify to export a readable backup')) return;
    setBackupExportBusy(true);
    recordSystemEvent('backup_export_confirmed', {
      output_format: backupExportPlaintext ? 'json' : 'encrypted',
      encrypted: !backupExportPlaintext,
    }, {
      category: 'storage',
      severity: backupExportPlaintext ? 'warn' : 'info',
      title: backupExportPlaintext ? 'Readable backup export confirmed' : 'Encrypted backup export confirmed',
    });
    try {
      await yieldToPaint();
      const [trips, vehicles] = await Promise.all([
        getSettingsTrips(),
        getSettingsVehicles(),
      ]);
      const result = await exportDriveSenseBackup({
        trips,
        vehicles,
        settings: cfg,
        passphrase: backupExportPlaintext ? null : backupExportPassphrase,
      });
      setBackupExportOpen(false);
      setBackupExportPasswordVisible(false);
      setBackupExportConfirmVisible(false);
      showBackupExportToast(result);
    } catch (error) {
      logSystemFailure('backup_export', error);
      toast({
        title: 'Could not export backup',
        description: error.message || 'Try again with a different backup password.',
        variant: 'destructive',
      });
    } finally {
      setBackupExportBusy(false);
    }
  };

  const finishImportBackup = async (
    file,
    { passphrase = null, acknowledgeTruncation = false, allowUnverifiedSignedBackup = false } = {}
  ) => {
    let result = await importDriveSenseBackup(file, {
      passphrase,
      acknowledgeTruncation,
      allowUnverifiedSignedBackup,
    });
    if (result.requiresAcknowledgement) {
      const affected = result.truncatedNoteTripCount;
      if (!confirm(`This backup contains notes longer than the supported limit. Importing will truncate notes on ${affected} trip${affected === 1 ? '' : 's'}. Continue?`)) return null;
      result = await importDriveSenseBackup(file, {
        passphrase,
        acknowledgeTruncation: true,
        allowUnverifiedSignedBackup,
      });
    }
    setCfg(localSettings.get());
    applyThemeMode(localSettings.get().dark_mode);
    await qc.invalidateQueries();
    toast({
      title: 'Import complete',
      description: result.truncatedFields
        ? `${result.trips} trips and ${result.vehicles} vehicles merged. ${result.warnings.join(' ')}`
        : result.signatureRecovered
        ? `${result.trips} trips and ${result.vehicles} vehicles merged from a readable backup whose old signature could not be verified. Settings were not imported.`
        : !result.savedFiltersRestored && result.savedFilters
        ? `${result.trips} trips and ${result.vehicles} vehicles merged, but saved filters could not be restored.`
        : result.privacy_zones_need_reconfiguration
        ? `${result.trips} trips and ${result.vehicles} vehicles merged. Re-add ${result.privacy_zones_need_reconfiguration} privacy zone${result.privacy_zones_need_reconfiguration === 1 ? '' : 's'} because backups do not store private coordinates.`
        : `${result.trips} trips, ${result.vehicles} vehicles, and ${result.savedFilters || 0} saved filters merged.`,
      variant: result.truncatedFields || result.signatureRecovered || (!result.savedFiltersRestored && result.savedFilters) || result.privacy_zones_need_reconfiguration ? 'destructive' : undefined,
    });
    setBackupImportOpen(false);
    setPendingBackupImportFile(null);
    setBackupImportPassphrase('');
    setBackupImportError('');
    setBackupImportPasswordVisible(false);
    recordSystemEvent('backup_import_user_notified', {
      trip_count: result.trips,
      vehicle_count: result.vehicles,
      saved_filter_count: result.savedFilters || 0,
      warning_count: result.truncatedFields || 0,
      privacy_zones_need_reconfiguration: result.privacy_zones_need_reconfiguration || 0,
    }, { category: 'storage', title: 'Backup import notification shown' });
    return result;
  };

  const handleImportPassphraseSubmit = async () => {
    if (!pendingBackupImportFile || backupImportPassphrase.length < BACKUP_PASSPHRASE_MIN_LENGTH || backupImportBusy) return;
    setBackupImportBusy(true);
    try {
      recordSystemEvent('backup_import_password_submitted', {
        encrypted: true,
        byte_count: Number(pendingBackupImportFile?.size) || 0,
      }, { category: 'storage', title: 'Backup password submitted' });
      await yieldToPaint();
      await finishImportBackup(pendingBackupImportFile, { passphrase: backupImportPassphrase });
    } catch (error) {
      if (error?.code === BACKUP_WRONG_PASSWORD_CODE) {
        setBackupImportError(BACKUP_WRONG_PASSWORD_CODE);
        recordSystemEvent('backup_import_wrong_password_notice_shown', {
          encrypted: true,
          byte_count: Number(pendingBackupImportFile?.size) || 0,
        }, {
          category: 'storage',
          severity: 'warn',
          title: 'Backup wrong password message shown',
        });
        return;
      }
      if (error?.code === BACKUP_SIGNATURE_INVALID_CODE) {
        const recover = confirm('This backup was readable, but its signature could not be verified. This can happen after reinstalling the app because the old verification key was deleted. Import trips and vehicles anyway? Settings will not be imported.');
        if (recover) {
          await finishImportBackup(pendingBackupImportFile, {
            passphrase: backupImportPassphrase,
            allowUnverifiedSignedBackup: true,
          });
        }
        return;
      }
      logSystemFailure('backup_import', error, {
        byte_count: Number(pendingBackupImportFile?.size) || 0,
      });
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
      recordSystemEvent('backup_import_rejected', {
        reason: 'file_too_large',
        byte_count: Number(file.size) || 0,
        max_bytes: MAX_BACKUP_BYTES,
      }, { category: 'storage', severity: 'warn', title: 'Backup import rejected' });
      toast({
        title: 'Could not import backup',
        description: BACKUP_TOO_LARGE_MESSAGE,
        variant: 'destructive',
      });
      return;
    }
    if (!confirm('Import this Road Sage backup? Trips and vehicles with matching IDs will be updated, and new ones will be added.')) return;

    try {
      await finishImportBackup(file);
    } catch (error) {
      if (error?.code === BACKUP_PASSWORD_REQUIRED_CODE || error?.code === BACKUP_WRONG_PASSWORD_CODE) {
        setPendingBackupImportFile(file);
        setBackupImportPassphrase('');
        setBackupImportError(error.code);
        setBackupImportPasswordVisible(false);
        setBackupImportOpen(true);
        recordSystemEvent('backup_import_unlock_dialog_opened', {
          encrypted: true,
          byte_count: Number(file?.size) || 0,
          reason: error.code,
        }, {
          category: 'storage',
          severity: 'warn',
          title: 'Backup unlock dialog opened',
        });
        return;
      }
      if (error?.code === BACKUP_SIGNATURE_INVALID_CODE) {
        const recover = confirm('This backup was readable, but its signature could not be verified. This can happen after reinstalling the app because the old verification key was deleted. Import trips and vehicles anyway? Settings will not be imported.');
        if (recover) {
          await finishImportBackup(file, { allowUnverifiedSignedBackup: true });
        }
        return;
      }
      logSystemFailure('backup_import', error, {
        byte_count: Number(file?.size) || 0,
      });
      toast({
        title: 'Could not import backup',
        description: error.message || 'Make sure the file is a Road Sage backup file.',
        variant: 'destructive',
      });
    }
  };

  const effectiveTrackingMode = cfg.tracking_paused ? 'manual' : cfg.tracking_mode;
  const obdSupport = getObdBluetoothSupport();
  const motionSupport = getMotionSensorSupport();
  const locationFeatureStatus = permissionStatus?.foregroundLocation === 'granted' ? 'granted' : permissionStatus?.foregroundLocation;
  const notificationFeatureStatus = permissionStatus?.notifications === 'granted' ? 'granted' : permissionStatus?.notifications;
  const settingsSearchQuery = settingsSearch.trim().toLowerCase();
  const settingsSections = SETTINGS_SECTIONS;
  const activeSettingsSectionMeta = settingsSections.find((section) => section.id === activeSettingsSection);
  const settingSearchResults = useMemo(
    () => searchSettingsSections(settingsSections, settingsSearchQuery),
    [settingsSearchQuery]
  );
  const showSettingsSection = (sectionId) => {
    setActiveSettingsSection(sectionId);
    clearSettingsSearch();
  };
  const scrollSettingSection = (sectionId, targetLabel = '') => {
    showSettingsSection(sectionId);
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const normalizedTargetLabel = String(targetLabel || '').trim().toLowerCase();
        const settingTarget = normalizedTargetLabel
          ? Array.from(document.querySelectorAll('[data-setting-label]')).find(
              (element) => element instanceof HTMLElement &&
                String(element.dataset.settingLabel || '').trim().toLowerCase() === normalizedTargetLabel
            )
          : null;
        (settingTarget || document.getElementById(sectionId))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  };
  const rescoreTotal = Number(rescoreProgress?.total) || 0;
  const rescoreCompleted = Number(rescoreProgress?.completed) || 0;
  const rescoreProgressPct = rescoreTotal > 0
    ? Math.min(100, Math.round((rescoreCompleted / rescoreTotal) * 100))
    : 0;
  const autoRescoreVisible = scoreMigrationSummary.auto_rescore_recommended || rescoreProgress?.reason === 'auto_provenance';
  const rescoreOnlyProvenanceMismatch = (scoreMigrationSummary.mismatch_count || 0) > 0;
  const rescoreCandidateCount = rescoreOnlyProvenanceMismatch
    ? Number(scoreMigrationSummary.mismatch_rescore_eligible_count) || 0
    : Number(scoreMigrationSummary.rescore_eligible_count) || 0;
  const rescoreIneligibleCount = rescoreOnlyProvenanceMismatch
    ? Number(scoreMigrationSummary.mismatch_rescore_ineligible_count) || 0
    : Number(scoreMigrationSummary.rescore_ineligible_count) || 0;
  const privacyRescoreActive = isPrivacyRescoreReason(rescoreProgress?.reason) &&
    (rescoreProgress?.status === 'pending' || rescoreProgress?.status === 'running');
  const privacyNativeSyncFailed = cfg.privacy_zones_native_sync_status === NATIVE_PRIVACY_SYNC_STATUS_FAILED;
  const integrityThreats = Array.isArray(integrity?.threats) ? integrity.threats : [];
  const integrityThreatDetected = integrity?.secure === false || integrityThreats.length > 0;
  const privacyZoneStorageBlocked = integrityThreatDetected && cfg.privacy_zone_storage_requires_secure_device !== false;
  const privacyHealthStatus = privacyNativeSyncFailed
    ? 'Android sync blocked'
    : integrityThreatDetected
    ? 'Device integrity warning'
    : privacyRescoreActive
    ? `${Math.max(0, rescoreTotal - rescoreCompleted)} trip${Math.max(0, rescoreTotal - rescoreCompleted) === 1 ? '' : 's'} re-scoring`
    : privacyZoneOverlaps.length
    ? `${privacyZoneOverlaps.length} overlap${privacyZoneOverlaps.length === 1 ? '' : 's'} to review`
    : 'Protected';
  const voiceDeliveryStatus = getVoiceAlertDeliveryStatus({
    settings: cfg,
    isAndroidPlatform: isAndroid(),
    nativeStatus: nativeTrackingStatus,
    tracking: false,
  });

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

      {privacyRescoreActive && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold">Updating privacy-affected trip scores</div>
              <div className="mt-1 text-xs">
                Re-scoring {Math.max(0, rescoreTotal - rescoreCompleted)} trip{Math.max(0, rescoreTotal - rescoreCompleted) === 1 ? '' : 's'} affected by the privacy-zone change.
              </div>
            </div>
            <div className="shrink-0 font-mono text-xs">{rescoreProgressPct}%</div>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-900/50">
            <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${rescoreProgressPct}%` }} />
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-3 shadow-sm">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={settingsSearchInput}
            onChange={(event) => updateSettingsSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                clearSettingsSearch();
                return;
              }
              if (event.key === 'Enter' && settingSearchResults[0]) {
                event.preventDefault();
                scrollSettingSection(settingSearchResults[0].sectionId, settingSearchResults[0].targetLabel);
              }
            }}
            placeholder="Search settings, permissions, tracking, privacy..."
            aria-label="Search settings"
            aria-controls={settingsSearchQuery ? 'settings-search-results' : undefined}
            className="w-full rounded-xl border border-border bg-background py-2.5 pl-9 pr-10 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          {settingsSearchInput && (
            <button
              type="button"
              onClick={clearSettingsSearch}
              aria-label="Clear settings search"
              className="absolute right-2 top-1/2 rounded-lg p-1 text-muted-foreground hover:bg-secondary hover:text-foreground -translate-y-1/2"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {settingsSearchQuery && (
          <div id="settings-search-results" className="mt-3" aria-live="polite">
            <div className="mb-2 flex items-center justify-between gap-3 px-1">
              <span className="text-xs font-semibold text-foreground">
                {settingSearchResults.length} result{settingSearchResults.length === 1 ? '' : 's'}
              </span>
              <InlineRefreshBadge visible={isSettingsSearchPending} label="Updating search" />
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {settingSearchResults.length > 0 ? settingSearchResults.map((item) => (
                <button
                  key={`${item.kind}-${item.sectionId}-${item.label}`}
                  type="button"
                  onClick={() => scrollSettingSection(item.sectionId, item.targetLabel)}
                  className="min-h-[70px] rounded-xl border border-border bg-background px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold leading-snug text-foreground">{item.label}</span>
                      <span className="mt-0.5 block text-[11px] font-medium text-primary">
                        {item.kind === 'setting' ? item.section : 'Settings area'}
                      </span>
                    </span>
                    <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  </span>
                  <span className="mt-1.5 block text-xs leading-snug text-muted-foreground">{item.detail}</span>
                </button>
              )) : (
                <div className="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted-foreground md:col-span-2">
                  No matching settings found.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

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

      <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start lg:gap-6">
        <aside className="hidden lg:block">
          <div className="sticky top-4 border-r border-border/70 pr-4">
            <div className="mb-4 px-2">
              <div className="text-sm font-semibold">Settings areas</div>
              <div className="mt-0.5 text-xs text-muted-foreground">Choose an area to configure.</div>
            </div>
            <SettingsAreaNavigation
              sections={settingsSections}
              activeId={activeSettingsSection}
              onSelect={showSettingsSection}
              variant="sidebar"
            />
          </div>
        </aside>

        <div className="min-w-0">
          {activeSettingsSection === 'overview' ? (
            <>
              <div className="lg:hidden">
                <div className="mb-3 px-1">
                  <div className="text-sm font-semibold">Settings areas</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">Choose an area to configure.</div>
                </div>
                <SettingsAreaNavigation
                  sections={settingsSections}
                  activeId={activeSettingsSection}
                  onSelect={scrollSettingSection}
                  variant="mobile"
                />
              </div>
              <div className="hidden min-h-[22rem] items-center justify-center border border-border bg-card p-8 text-center shadow-sm lg:flex">
                <div className="max-w-sm">
                  <div className="mx-auto grid h-11 w-11 place-items-center rounded-lg bg-secondary text-muted-foreground">
                    <SlidersHorizontal className="h-5 w-5" />
                  </div>
                  <div className="mt-3 text-base font-semibold">Select a settings area</div>
                </div>
              </div>
            </>
          ) : (
      <div data-settings-content="true" className="border border-border bg-card p-4 shadow-sm sm:p-5">
        <div data-settings-shell="true" className="mb-4 flex items-start gap-3 border-b border-border/60 pb-4">
          <button
            type="button"
            onClick={() => setActiveSettingsSection('overview')}
            aria-label="Back to settings areas"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground hover:bg-secondary hover:text-foreground lg:hidden"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <div className="text-lg font-semibold">{activeSettingsSectionMeta?.title || 'Settings'}</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{activeSettingsSectionMeta?.detail}</div>
          </div>
        </div>

        <SettingsSection id="settings-tracking" activeId={activeSettingsSection}>{() => (<>
        {/* Tracking */}
        <SectionTitle id="settings-tracking">Tracking</SectionTitle>
        <div className="space-y-1">
          <div>
            <div className="text-sm font-medium mb-2 px-1">Tracking Mode</div>
            <div className="space-y-2">
              {[
                { id: 'manual', label: 'Manual Only', sub: 'Start/stop manually; keep app open unless Background GPS is active' },
                { id: 'auto_detect', label: 'Auto-Detect', sub: 'Detects driving when app is open' },
                { id: 'background_auto', label: 'Background Auto', sub: 'Uses background location when enabled' },
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
              const stopped = await stopNativeAutoTrackingSafely('Auto tracking could not be turned off');
              if (!stopped) return;
              updateCfg({ auto_tracking_enabled: false, tracking_mode: 'manual' });
            }} />
          </SettingRow>
          <SettingRow
            icon={Shield}
            label="Background Tracking"
            sublabel={cfg.tracking_paused ? 'Paused until Pause All Tracking is turned off' : nativeTrackingStatus?.enabled ? 'Native background auto tracking is running' : 'Keeps recording while minimized with a persistent notification; force-closing can still stop Android tracking'}
          >
            <Toggle value={!cfg.tracking_paused && cfg.background_tracking_enabled} onChange={async v => {
              if (v) {
                await enableTrackingMode('background_auto');
                return;
              }
              const stopped = await stopNativeAutoTrackingSafely('Background tracking could not be turned off');
              if (!stopped) return;
              updateCfg({ background_tracking_enabled: false, auto_tracking_enabled: false, tracking_mode: 'manual' });
              await refreshPermissions();
            }} />
          </SettingRow>
        </div>

        </>)}</SettingsSection>

        <SettingsSection id="settings-android-permissions" activeId={activeSettingsSection}>{() => (<>
        {/* Android Permissions */}
        <SectionTitle id="settings-android-permissions">Android Permissions</SectionTitle>
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
            ...(isAndroid() ? [{ key: 'microphone', label: 'Microphone', sub: getPermissionExplanation('microphone'), action: requestMicrophonePermission }] : []),
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
            sublabel={batteryStatus?.batteryOptimizationIgnored ? 'Battery optimization is already unrestricted for Road Sage' : 'Open Android battery settings and allow unrestricted background activity'}
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

        </>)}</SettingsSection>

        <SettingsSection id="settings-feature-permissions" activeId={activeSettingsSection}>{() => (<>
        {/* Feature Permission Check */}
        <SectionTitle id="settings-feature-permissions">Feature Permissions</SectionTitle>
        <div className="space-y-1">
          {[
            {
              label: 'Trip history, search, tags, notes, favorites, calendar, weekly summary, goals, costs',
              sub: 'No new Android permission prompt. These features use local trips, vehicles, and settings already stored on this device.',
              value: 'none',
            },
            {
              label: 'Route comparison, commute detection, road types, parking reminder, repeated event areas',
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
              sub: 'Only needed if you choose Background Auto. Android asks separately for Background Location, Activity, and Notifications. It can collect location while minimized or in the background, but force-closing can still stop tracking.',
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
              label: 'Posted speed data, weather, optional OSRM matching, and offline route previews',
              sub: 'Uses open-source map/weather data over the network or cached local route data. OSRM route matching stays off unless you add an endpoint.',
              value: 'none',
            },
            {
              label: 'Live voice alerts and rule-based driving coach summaries',
              sub: 'Voice alerts use speech output. Voice speed marker testing uses the microphone only when you tap Test marker.',
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

        </>)}</SettingsSection>

        <SettingsSection id="settings-appearance" activeId={activeSettingsSection}>{() => (<>
        {/* Appearance */}
        <SectionTitle id="settings-appearance">Appearance</SectionTitle>
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

        </>)}</SettingsSection>

        <SettingsSection id="settings-economics" activeId={activeSettingsSection}>{() => (<>
        {/* Economics */}
        <SectionTitle id="settings-economics">Economics</SectionTitle>
        <div className="space-y-1">
          <SettingRow
            icon={Banknote}
            label="Currency symbol"
            sublabel="Used for fuel, energy, maintenance, and report cost totals"
          >
            <select
              value={cfg.currencySymbol || '$'}
              onChange={e => updateCfg({ currencySymbol: e.target.value })}
              className="w-24 rounded-lg border border-border bg-background px-2 py-1 text-right text-xs outline-none focus:border-primary"
            >
              {CURRENCY_SYMBOL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            icon={Leaf}
            label="Average vehicle CO2 baseline"
            sublabel="kg CO2 per 100 km used for fleet-average estimate comparisons"
          >
            <input
              type="number"
              min="0"
              max="50"
              step="0.1"
              value={numberDraftValue(cfg.co2_baseline_kg_per_100km, 12)}
              placeholder="12"
              onChange={e => updateOptionalNumberDraft(updateCfg, 'co2_baseline_kg_per_100km', e.target.value)}
              className="w-24 rounded-lg border border-border bg-background px-2 py-1 text-right text-xs outline-none focus:border-primary"
            />
          </SettingRow>
          <SettingRow
            icon={Zap}
            label="Default EV efficiency"
            sublabel="kWh per 100 km used when an electric vehicle has no profile value"
          >
            <input
              type="number"
              min="5"
              max="40"
              step="0.1"
              value={numberDraftValue(cfg.default_ev_kwh_per_100km, 18)}
              placeholder="18"
              onChange={e => updateOptionalNumberDraft(updateCfg, 'default_ev_kwh_per_100km', e.target.value)}
              className="w-24 rounded-lg border border-border bg-background px-2 py-1 text-right text-xs outline-none focus:border-primary"
            />
          </SettingRow>
          <SettingRow
            icon={Zap}
            label="Grid CO2 intensity"
            sublabel="kg CO2 per kWh used for electric-vehicle trip emissions"
          >
            <input
              type="number"
              min="0"
              max="2"
              step="0.001"
              value={numberDraftValue(cfg.grid_co2_kg_per_kwh, 0.04)}
              placeholder="0.04"
              onChange={e => updateOptionalNumberDraft(updateCfg, 'grid_co2_kg_per_kwh', e.target.value)}
              className="w-24 rounded-lg border border-border bg-background px-2 py-1 text-right text-xs outline-none focus:border-primary"
            />
          </SettingRow>
          <SettingRow
            icon={Leaf}
            label="Tree-year equivalent"
            sublabel="kg CO2 per tree per year used in carbon impact summaries"
          >
            <input
              type="number"
              min="1"
              max="100"
              step="0.1"
              value={numberDraftValue(cfg.tree_co2_kg_per_year, 21)}
              placeholder="21"
              onChange={e => updateOptionalNumberDraft(updateCfg, 'tree_co2_kg_per_year', e.target.value)}
              className="w-24 rounded-lg border border-border bg-background px-2 py-1 text-right text-xs outline-none focus:border-primary"
            />
          </SettingRow>
        </div>

        </>)}</SettingsSection>

        <SettingsSection id="settings-notifications" activeId={activeSettingsSection}>{() => (<>
        {/* Notifications */}
        <SectionTitle id="settings-notifications">Notifications</SectionTitle>
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
              <p className="mt-2 px-1 text-xs text-muted-foreground">During quiet hours, safety alerts can still come through unless that channel is disabled.</p>
            </div>

            <div className="rounded-2xl bg-secondary/40 p-3">
              <div className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">While Driving</div>
              {[
                { key: 'notif_safety_alerts_enabled', label: 'Safety alerts channel', sub: 'Urgent warnings while driving' },
                { key: 'notif_phone_use_alert_enabled', label: 'Phone use warning', sub: 'Immediate warning for confirmed Android Usage Access detections' },
                { key: 'notif_heading_drift_alert_enabled', label: 'Attention pattern warning', sub: 'Beta GPS heading patterns and long-drive break alerts' },
                { key: 'notif_speeding_alert_enabled', label: 'Speeding alert', sub: 'Sustained speeding warnings' },
                { key: 'danger_zone_alerts_enabled', label: 'Repeated event area alerts', sub: 'Warn when approaching your own repeated driving-event locations' },
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
                { key: 'achievement_notifications', label: 'Milestones', sub: 'Notify when a milestone unlocks' },
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

        </>)}</SettingsSection>

        <SettingsSection id="settings-driving-goals" activeId={activeSettingsSection}>{() => (<>
        {/* Driving Goals */}
        <SectionTitle id="settings-driving-goals">Driving Goals</SectionTitle>
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
            { key: 'ubi_optimal_annual_km', label: 'UBI optimal annual km', min: 3000, max: 30000, step: 500 },
            { key: 'ubi_mileage_score_spread_km', label: 'UBI mileage spread km', min: 2000, max: 20000, step: 500 },
          ].map(({ key, label, min, max, step }) => (
            <div key={key} className="px-1">
              <div className="flex justify-between text-xs mb-1.5">
                <span className="flex items-center gap-2 font-medium">
                  {label}
                  {calibrationEntryForSetting(key)?.calibration_status === CALIBRATION_STATUSES.PROVISIONAL && <CalibrationStatusTag />}
                </span>
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
              {key.startsWith('ubi_') && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Used only for the UBI-style mileage score assumption.
                </p>
              )}
            </div>
          ))}
        </div>

        </>)}</SettingsSection>

        <SettingsSection id="settings-night-window" activeId={activeSettingsSection}>{() => (<>
        {/* Night Driving Window */}
        <SectionTitle id="settings-night-window">Night Driving Window</SectionTitle>
        <p className="text-xs text-muted-foreground px-1 mb-3">
          Used for night-trip labels, goals, and safety scoring.
        </p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'sunset', label: 'Sunset', sub: 'GPS-based' },
              { id: 'custom', label: 'Custom', sub: `${cfg.night_start_time || NIGHT_START_TIME} to ${cfg.night_end_time || NIGHT_END_TIME}` },
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
                  value={cfg.night_start_time || NIGHT_START_TIME}
                  disabled={cfg.night_detection_mode !== 'custom'}
                  onChange={e => updateCfg({ night_start_time: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
                />
              </label>
              <label className="text-xs font-medium">
                End
                <input
                  type="time"
                  value={cfg.night_end_time || NIGHT_END_TIME}
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
                Sunset mode uses each trip point's date and GPS position; if GPS coordinates are missing, Road Sage falls back to the custom window.
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

        </>)}</SettingsSection>

        <SettingsSection id="settings-detection-thresholds" activeId={activeSettingsSection}>{() => (<>
        {/* Detection Features */}
        <SectionTitle id="settings-detection-thresholds">Detection Features</SectionTitle>
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
        <div className="mb-3 rounded-2xl bg-secondary/40 p-3">
          <SettingRow
            icon={Route}
            label="Use lane changes in Safety score"
            sublabel="Detection still runs when off; this only controls Safety score impact"
          >
            <Toggle
              value={cfg.lane_change_score_enabled !== false}
              onChange={v => updateCfg({ lane_change_score_enabled: v })}
            />
          </SettingRow>
          <div className="px-1 pb-2 text-xs leading-relaxed text-muted-foreground">
            Detected lane changes remain visible on trips when this is off, but lane-changing will not lower Safety. Does not detect slow traffic below 65 km/h, curved-road lane changes, turn-signal use, or following-vehicle gaps. GPS-only detection may see 30-40% false positives in testing conditions; IMU-fused detection is closer to 10-15%. IMU calibration needs at least two GPS-confirmed harsh-brake events, so early trip segments may stay GPS-only.
          </div>
        </div>
        <div className="mb-4 rounded-2xl border border-border bg-secondary/30 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Threshold calibration</div>
              <div className="mt-1 text-xs text-muted-foreground">Analyse your driving and event feedback to suggest personalized detection thresholds.</div>
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
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 [overflow-wrap:anywhere] dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-100">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 font-semibold">{PENALTY_SCALE_CALIBRATION.label}</div>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {PENALTY_SCALE_CALIBRATION.calibration_status === CALIBRATION_STATUSES.PROVISIONAL && <CalibrationStatusTag />}
                <span className="font-mono">{String(PENALTY_SCALE_CALIBRATION.value)}</span>
              </div>
            </div>
            <div className="mt-1">{PENALTY_SCALE_CALIBRATION.calibration_note}</div>
            <div className="mt-2 text-amber-800 dark:text-amber-200">
              Status: {calibrationStatusLabel(PENALTY_SCALE_CALIBRATION.calibration_status)}
              {PENALTY_SCALE_CALIBRATION.affected_metrics.length > 0 && (
                <> - Affects {PENALTY_SCALE_CALIBRATION.affected_metrics.join(', ')}</>
              )}
            </div>
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
              {calibProfile.feedbackSummary?.total > 0 && (
                <div className="rounded-xl bg-card p-3 text-xs text-muted-foreground">
                  Used {calibProfile.feedbackSummary.total} event review{calibProfile.feedbackSummary.total === 1 ? '' : 's'} to nudge thresholds away from events marked wrong.
                </div>
              )}
              {calibProfile.surveySummary?.total > 0 && (
                <div className="rounded-xl bg-card p-3 text-xs text-muted-foreground">
                  <div className="font-semibold text-foreground">Survey calibration signal</div>
                  <div className="mt-1">
                    Used {calibProfile.surveySummary.usable} usable survey label{calibProfile.surveySummary.usable === 1 ? '' : 's'}
                    {calibProfile.surveySummary.averageScoreDelta != null && (
                      <>. Driver target differs from app score by {calibProfile.surveySummary.averageScoreDelta > 0 ? '+' : ''}{calibProfile.surveySummary.averageScoreDelta} points on average</>
                    )}.
                  </div>
                  <div className="mt-1">{calibProfile.surveySummary.recommendation}</div>
                  {calibProfile.surveyThresholdSignals?.length > 0 && (
                    <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
                      {calibProfile.surveyThresholdSignals.map((signal) => (
                        <div key={signal.thresholdKey}>
                          {signal.responseCount} consistent {signal.issueType.replace(/_/g, ' ')} reviews influenced this suggestion.
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className="rounded-full bg-secondary px-2 py-0.5 font-semibold">Confidence: {calibProfile.surveySummary.confidence}</span>
                    <span className="rounded-full bg-secondary px-2 py-0.5 font-semibold">Accurate: {calibProfile.surveySummary.scoreAccuracy?.accurate || 0}</span>
                    <span className="rounded-full bg-secondary px-2 py-0.5 font-semibold">Too high: {calibProfile.surveySummary.scoreAccuracy?.tooHigh || 0}</span>
                    <span className="rounded-full bg-secondary px-2 py-0.5 font-semibold">Too low: {calibProfile.surveySummary.scoreAccuracy?.tooLow || 0}</span>
                  </div>
                  {calibProfile.surveySummary.topContextTags?.length > 0 && (
                    <div className="mt-2">
                      Common tags: {calibProfile.surveySummary.topContextTags.map((item) => item.tag.replace(/_/g, ' ')).join(', ')}
                    </div>
                  )}
                </div>
              )}
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
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setRescoreConfirmOpen(true)}
              disabled={rescoreBusy}
              className="rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary"
            >
              {rescoreBusy
                ? 'Updating historical scores...'
                : scoreMigrationSummary.mismatch_count > 0
                ? 'Update outdated scores'
                : 'Recalculate historical scores'}
            </button>
            {rescoreStatus && <span className="text-xs text-muted-foreground">{rescoreStatus}</span>}
          </div>
          {rescoreResult && (
            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
              <div className="font-semibold">Historical score update complete</div>
              <div className="mt-1">
                {rescoreResult.completed} updated · {rescoreResult.changed} changed · {rescoreResult.unchanged} unchanged
                {rescoreResult.skipped ? ` · ${rescoreResult.skipped} skipped` : ''}
                {rescoreResult.failed ? ` · ${rescoreResult.failed} failed` : ''}
              </div>
              {rescoreResult.changes?.slice(0, 4).map((change) => (
                <div key={change.id} className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-card/70 px-2 py-1">
                  <span className="truncate">{change.nickname || (change.start_time ? new Date(change.start_time).toLocaleDateString() : 'Trip')}</span>
                  <span className="shrink-0 font-mono">
                    {change.before.overall ?? '—'} → {change.after.overall ?? '—'}
                  </span>
                </div>
              ))}
              {rescoreResult.changes?.length > 4 && (
                <div className="mt-1">+{rescoreResult.changes.length - 4} more changed scores</div>
              )}
            </div>
          )}
          {(rescoreProgress?.status === 'running' || autoRescoreVisible) && (
            <div className="mt-3 rounded-xl border border-border bg-card p-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold">
                    {rescoreProgress?.status === 'running' ? 'Re-scoring trip history' : 'Automatic re-score ready'}
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    {rescoreProgress?.status === 'running'
                      ? `${rescoreCompleted}/${rescoreTotal} completed`
                      : `${scoreMigrationSummary.recent_mismatch_count} of ${scoreMigrationSummary.recent_completed_count} recent trips use older scoring inputs.`}
                  </div>
                </div>
                <div className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {rescoreProgress?.status === 'running' ? `${rescoreProgressPct}%` : `>${Math.round((scoreMigrationSummary.auto_rescore_threshold_ratio || AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO) * 100)}%`}
                </div>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${rescoreProgress?.status === 'running' ? rescoreProgressPct : Math.min(100, Math.round((scoreMigrationSummary.recent_mismatch_ratio || 0) * 100))}%` }}
                />
              </div>
              <div className="mt-2 text-muted-foreground">
                Older scores are recalculated with scoring version {scoreMigrationSummary.scoring_version || SCORING_VERSION} before they are mixed into recent baselines.
              </div>
            </div>
          )}
          {(scoreMigrationSummary.mismatch_count > 0 || scoreMigrationSummary.unavailable_score_count > 0) && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-100">
              {scoreMigrationSummary.mismatch_count > 0 && (
                <>
                  <div className="font-semibold">Scoring model update available</div>
                  <div className="mt-1">
                    {scoreMigrationSummary.mismatch_count} completed trip{scoreMigrationSummary.mismatch_count === 1 ? '' : 's'} {scoreMigrationSummary.trips.some((item) => item.status === 'unknown_legacy_unrescored') ? 'are marked unknown legacy until re-scored for' : 'used a different scoring model than'} version {scoreMigrationSummary.scoring_version || SCORING_VERSION}. Re-score only when you want those stored scores updated.
                  </div>
                  <div className="mt-2 space-y-1">
                    {scoreMigrationSummary.trips.slice(0, 4).map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-2 rounded-lg bg-card/70 px-2 py-1">
                        <span className="truncate">{item.nickname || new Date(item.start_time).toLocaleDateString()}</span>
                        <span className="shrink-0 text-amber-700 dark:text-amber-200">v{item.scoring_version || 'unknown'}</span>
                      </div>
                    ))}
                    {scoreMigrationSummary.trips.length > 4 && (
                      <div className="text-amber-700 dark:text-amber-200">+{scoreMigrationSummary.trips.length - 4} more</div>
                    )}
                  </div>
                </>
              )}
              {scoreMigrationSummary.unavailable_score_count > 0 && (
                <div className={scoreMigrationSummary.mismatch_count > 0 ? 'mt-3 border-t border-amber-200 pt-3 dark:border-amber-800/50' : ''}>
                  {scoreMigrationSummary.unavailable_score_count} trip{scoreMigrationSummary.unavailable_score_count === 1 ? '' : 's'} currently have unavailable overall scores and will show a placeholder until re-scored.
                </div>
              )}
            </div>
          )}
          <details className="mt-3 rounded-xl border border-border bg-card p-3 text-xs [overflow-wrap:anywhere]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-semibold">
              <span className="min-w-0">Calibration registry</span>
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                <CalibrationStatusTag />
                {PROVISIONAL_SCORING_CONSTANTS.length}
              </span>
            </summary>
            <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
              {PROVISIONAL_SCORING_CONSTANTS.map((entry) => (
                <div key={entry.key} className="rounded-lg bg-secondary/60 p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 font-semibold">{entry.label}</span>
                    <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                      {entry.calibration_status === CALIBRATION_STATUSES.PROVISIONAL && <CalibrationStatusTag />}
                      <span className="font-mono text-primary">{typeof entry.value === 'object' ? 'policy' : String(entry.value)}</span>
                    </span>
                  </div>
                  <div className="mt-1 text-muted-foreground">{entry.calibration_note}</div>
                  {entry.affected_metrics.length > 0 && (
                    <div className="mt-1 text-muted-foreground">
                      Affects {entry.affected_metrics.join(', ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </details>
        </div>
        <div className="space-y-4">
          {[
            { key: 'threshold_harsh_brake_ms2', label: 'Harsh Braking', unit: 'm/s²', min: 2, max: 8, step: 0.5 },
            { key: 'threshold_rapid_accel_ms2', label: 'Rapid Acceleration', unit: 'm/s²', min: 1.5, max: 6, step: 0.5 },
            { key: 'threshold_stop_start_decel_ms2', label: 'Stop-Start Decel', unit: 'm/s²', min: 1.5, max: 5, step: 0.25 },
            { key: 'threshold_sharp_turn_g_low', label: 'Sharp Turn Low', unit: 'g', min: 0.2, max: 0.6, step: 0.05 },
            { key: 'threshold_sharp_turn_g_medium', label: 'Sharp Turn Medium', unit: 'g', min: 0.25, max: 0.8, step: 0.05 },
            { key: 'threshold_sharp_turn_g_high', label: 'Sharp Turn High', unit: 'g', min: 0.35, max: 1.0, step: 0.05 },
            { key: 'threshold_speeding_kmh', label: 'Speeding (fallback)', unit: 'km/h', min: 80, max: 160, step: 5 },
            { key: 'threshold_idle_seconds', label: 'Idle Event', unit: 's', min: 90, max: 300, step: 30 },
            { key: 'threshold_eco_cruise_min_kmh', label: 'Eco Cruise Min', unit: 'km/h', min: 20, max: 90, step: 5 },
            { key: 'threshold_eco_cruise_max_kmh', label: 'Eco Cruise Max', unit: 'km/h', min: 80, max: 140, step: 5 },
            { key: 'eco_min_moving_kmh', label: 'Eco Moving Floor', unit: 'km/h', min: 0, max: 30, step: 1 },
            { key: 'eco_cruise_score_multiplier', label: 'Eco Cruise Multiplier', unit: 'x', min: 50, max: 200, step: 5 },
            { key: 'eco_idle_penalty_multiplier', label: 'Eco Idle Multiplier', unit: 'x', min: 0, max: 300, step: 5 },
            { key: 'eco_idle_max_penalty', label: 'Eco Idle Cap', unit: 'pts', min: 0, max: 50, step: 1 },
            { key: 'min_speed_harsh_brake_kmh', label: 'Harsh Brake Min Speed', unit: 'km/h', min: 5, max: 60, step: 5 },
            { key: 'min_speed_rapid_accel_kmh', label: 'Rapid Accel Min Speed', unit: 'km/h', min: 0, max: 40, step: 5 },
          ].map(({ key, label, unit, min, max, step }) => (
            <div key={key} className="px-1">
              <div className="flex justify-between text-xs mb-1.5">
                <span className="font-medium">{label}</span>
                <span className="flex items-center gap-2 text-primary font-semibold">
                  {calibrationEntryForSetting(key)?.calibration_status === CALIBRATION_STATUSES.PROVISIONAL && (
                    <CalibrationStatusTag />
                  )}
                  {(ecoScoreWarning(key) || (thresholdEditingEnabled && sliderWarning(cfg[key], min, max))) && (
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${ecoScoreWarning(key) ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-200' : 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200'}`}>
                      {ecoScoreWarning(key) || sliderWarning(cfg[key], min, max)}
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
              sublabel={cfg.advanced_safety_detection_enabled === false ? 'Heading events are still collected as diagnostic-only; score-affecting advanced safety signals are off' : 'Low-confidence GPS safety signatures can contribute to score context'}
            >
              <Toggle
                value={cfg.advanced_safety_detection_enabled !== false}
                onChange={v => updateCfg({ advanced_safety_detection_enabled: v })}
              />
            </SettingRow>
            <div className="space-y-4">
              {[
                { key: 'threshold_manoeuvre_alert_brake_ms2', label: 'Brake-Turn Alert Braking', unit: 'm/s²', min: 2.5, max: 5.0, step: 0.5, help: 'Braking threshold for a low-confidence combined brake-and-turn manoeuvre alert; it cannot detect object proximity.' },
                { key: 'threshold_manoeuvre_alert_turn_degs', label: 'Brake-Turn Alert Heading Rate', unit: 'deg/s', min: 15, max: 60, step: 5, help: 'Heading-change threshold for a low-confidence combined brake-and-turn manoeuvre alert.' },
                { key: 'threshold_heading_drift_std_degs', label: 'Attention Pattern Beta Threshold', unit: 'degrees', min: 5, max: 15, step: 1, help: 'GPS-only heading-drift sensitivity. Heading events are visible as diagnostic-only when Advanced Safety is off; enabling it allows eligible advanced safety context to affect scoring.' },
                { key: 'threshold_phone_proxy_oscillations', label: 'Phone Proxy Sensitivity', unit: 'oscillations', min: 6, max: 8, step: 1, help: 'Diagnostic only: GPS micro-steering patterns are not phone-use evidence and do not affect scores.' },
                { key: 'threshold_speed_creep_kmh', label: 'Speed Creep Alert', unit: 'km/h', min: 5, max: 25, step: 5, help: 'How much speed can rise on straight highway sections before Road Sage logs speed creep.' },
                { key: 'threshold_overtake_accel_ms2', label: 'Overtake Detection Sensitivity (Beta)', unit: 'm/s²', min: 3.0, max: 5.0, step: 0.5, help: 'Diagnostic only: requires prior straight highway travel and an out-and-back heading pattern; it does not affect scores or coaching.' },
              ].map(({ key, label, unit, min, max, step, help }) => (
                <div key={key} className={`px-1 ${cfg.advanced_safety_detection_enabled === false ? 'opacity-60' : ''}`}>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="font-medium">{label}</span>
                    <span className="flex items-center gap-2 text-primary font-semibold">
                      {calibrationEntryForSetting(key)?.calibration_status === CALIBRATION_STATUSES.PROVISIONAL && (
                        <CalibrationStatusTag />
                      )}
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
              <p className="px-1 text-xs text-muted-foreground">
                Commute route matching groups start/end locations within approximately {COMMUTE_MATCH_RADIUS_M} m.
              </p>
            </div>
          </div>
        </div>

        </>)}</SettingsSection>

        <SettingsSection id="settings-advanced-models" activeId={activeSettingsSection}>{() => (<>
        {/* Advanced Models */}
        <SectionTitle id="settings-advanced-models">Advanced Models</SectionTitle>
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
            icon={Target}
            label="Historical context estimate"
            sublabel="Estimate current context from your history, repeated event areas, and time"
          >
            <Toggle
              value={cfg.predictive_route_risk_enabled !== false}
              onChange={v => updateCfg({ predictive_route_risk_enabled: v })}
            />
          </SettingRow>
          <SettingRow
            icon={Volume2}
            label="Live voice alerts"
            sublabel={isAndroid()
              ? 'Manual Android trips use a native background service for speech. Alerts can continue while minimized, but force-closing the app can stop them.'
              : 'Speaks during active trips for live coaching, phone use, speeding, heading drift beta, long-drive, repeated-event-area, and incident alerts'}
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  runVoiceTest();
                }}
                className="rounded-lg bg-secondary px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
              >
                Test
              </button>
              <Toggle
                value={cfg.voice_alerts_enabled !== false}
                onChange={v => updateCfg({ voice_alerts_enabled: v })}
              />
            </div>
          </SettingRow>
          {voiceTestStatus && (
            <div className="px-1 pb-3 text-xs text-muted-foreground">
              {voiceTestStatus}
            </div>
          )}
          <div className="px-1 pb-3 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{voiceDeliveryStatus.label}:</span> {voiceDeliveryStatus.detail}
          </div>
          <SettingRow
            icon={Mic}
            label="Voice speed marker test"
            sublabel="Always-on trip listening is paused because Android speech recognition reopens the mic repeatedly. Use this parked test to check phrases like Road Sage speed 60."
          >
            <div className="flex items-center gap-2">
              {isAndroid() && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    runVoiceSpeedMarkerTest();
                  }}
                  disabled={voiceSpeedMarkerTestBusy}
                  className="rounded-lg bg-secondary px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60"
                >
                  {voiceSpeedMarkerTestBusy ? 'Listening...' : 'Test marker'}
                </button>
              )}
            </div>
          </SettingRow>
          {voiceSpeedMarkerTestStatus && (
            <div className="px-1 pb-3 text-xs text-muted-foreground">
              {voiceSpeedMarkerTestStatus}
            </div>
          )}
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

        </>)}</SettingsSection>

        <SettingsSection id="settings-phone-use" activeId={activeSettingsSection}>{() => (<>
        {/* Phone Use Detection */}
        <SectionTitle id="settings-phone-use">Phone Use Detection</SectionTitle>
        <div className="rounded-2xl bg-secondary/40 p-3">
          <SettingRow
            icon={Smartphone}
            label="Usage Access status"
            sublabel={
              permissionStatus?.phoneUsageAccess === 'granted'
                ? 'Phone-use scoring can use confirmed Android Usage Access evidence'
                : 'Phone-use scoring is unavailable until Android Usage Access is enabled'
            }
          >
            <div className="flex items-center gap-2">
              <PermissionBadge value={isAndroid() ? permissionStatus?.phoneUsageAccess : 'unavailable'} />
              {isAndroid() && permissionStatus?.phoneUsageAccess !== 'granted' && (
                <button
                  className="text-xs font-semibold text-primary"
                  onClick={async e => {
                    e.stopPropagation();
                    await openAndroidUsageAccessSettings();
                    await refreshPermissions();
                  }}
                >
                  Enable
                </button>
              )}
            </div>
          </SettingRow>
          <SettingRow
            icon={Focus}
            label="Detect phone use while driving"
            sublabel="Use Android Usage Access for scoring; retain GPS proxy counts for diagnostics only"
          >
            <Toggle
              value={cfg.phone_use_detection_enabled !== false}
              onChange={v => updateCfg({ phone_use_detection_enabled: v })}
            />
          </SettingRow>
          <div className={`${cfg.phone_use_detection_enabled === false ? 'pointer-events-none opacity-50' : ''}`}>
            <SettingRow
              label="Phone use live alert"
              sublabel="Send an immediate warning only for Android Usage Access detections"
            >
              <Toggle
                value={cfg.phone_use_live_alert_enabled !== false}
                onChange={v => updateCfg({ phone_use_live_alert_enabled: v, notif_phone_use_alert_enabled: v })}
                disabled={cfg.phone_use_detection_enabled === false}
              />
            </SettingRow>
            <div className="px-1 py-3 border-b border-border/50">
              <div className="mb-2 text-sm font-medium">Detection sensitivity</div>
              <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
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
                    className={`min-w-0 rounded-xl border p-2 text-left transition-all disabled:opacity-50 ${
                      (cfg.phone_use_sensitivity || 'medium') === option.id
                        ? 'border-primary bg-primary/5 text-primary'
                        : 'border-border text-muted-foreground hover:border-primary/40'
                    }`}
                  >
                    <div className="text-xs font-semibold">{option.label}</div>
                    <div className="mt-0.5 break-words text-[11px] leading-tight">{option.sub}</div>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Threshold: {(cfg.phone_use_sensitivity || 'medium') === 'low'
                  ? scoringValue('PHONE_LOW_SENSITIVITY_CONFIDENCE_THRESHOLD').toFixed(2)
                  : (cfg.phone_use_sensitivity || 'medium') === 'high'
                    ? scoringValue('PHONE_HIGH_SENSITIVITY_CONFIDENCE_THRESHOLD').toFixed(2)
                    : scoringValue('PHONE_CONFIDENCE_THRESHOLD').toFixed(2)} confidence.
              </p>
            </div>
            <SettingRow label="Show on trip map" sublabel="Mark suspected phone-use windows on route maps">
              <Toggle
                value={cfg.phone_use_show_on_map !== false}
                onChange={v => updateCfg({ phone_use_show_on_map: v })}
                disabled={cfg.phone_use_detection_enabled === false}
              />
            </SettingRow>
            <SettingRow label="Include in trip score" sublabel="Apply confirmed Android Usage Access phone-use penalties to Safety">
              <Toggle
                value={cfg.phone_use_affects_score !== false}
                onChange={v => updateCfg({ phone_use_affects_score: v })}
                disabled={cfg.phone_use_detection_enabled === false}
              />
            </SettingRow>
            <div className="mt-3 flex items-start gap-2 rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              Usage Access is needed for accurate phone detection. Without it, no phone-use score is shown; GPS proxy counts appear in diagnostics only.
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
                  { key: 'phone_micro_steer_count', label: 'Micro-steer count', min: 6, max: 8, step: 1, unit: 'turns' },
                  { key: 'phone_creep_rate_kmh_s', label: 'Speed creep rate', min: 0.5, max: 4, step: 0.25, unit: 'km/h/s' },
                  { key: 'phone_lane_drift_deg', label: 'Lane drift angle', min: 3, max: 18, step: 1, unit: 'deg' },
                  { key: 'phone_coupling_threshold', label: 'Coupling threshold', min: 0.05, max: 0.4, step: 0.05, unit: '' },
                  { key: 'phone_confidence_threshold', label: 'Confidence threshold', min: 0.15, max: 0.8, step: 0.05, unit: '' },
                  { key: 'phone_min_window_s', label: 'Minimum window', min: 2, max: 12, step: 1, unit: 's' },
                ].map(({ key, label, min, max, step, unit }) => (
                  <div key={key}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="flex items-center gap-2 font-medium">
                        {label}
                        {calibrationEntryForSetting(key)?.calibration_status === CALIBRATION_STATUSES.PROVISIONAL && <CalibrationStatusTag />}
                      </span>
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

        </>)}</SettingsSection>

        <SettingsSection id="settings-speed-warning" activeId={activeSettingsSection}>{() => (<>
        {/* Speed & Road Data */}
        <SectionTitle id="settings-speed-warning">Speed & Road Data</SectionTitle>
        <SettingsSubheading>Live speed check</SettingsSubheading>
        <SettingRow
          icon={Bell}
          label="Live speed check"
          sublabel={cfg.speed_warning_enabled === false ? 'Live speed checks are disabled' : 'Coach during a trip when speed exceeds the current posted or estimated limit plus margin'}
        >
          <Toggle
            value={cfg.speed_warning_enabled !== false}
            onChange={v => updateCfg({ speed_warning_enabled: v })}
          />
        </SettingRow>
        <SettingsSubheading>Online road data</SettingsSubheading>
        <SettingRow
          icon={Gauge}
          label="Manage your saved road speeds"
          sublabel="Open the private in-app map to add, review, update, or remove road-section speeds. These edits stay local and re-score matching stored trips."
          onClick={() => navigate('/speed-limits')}
        />
        <SettingRow
          icon={Gauge}
          label="Speed limits from OpenStreetMap"
          sublabel="On: Get Road Data can add posted OSM maxspeed limits. If OSM has no maxspeed, the app may use a clearly labeled estimate."
        >
          <Toggle
            value={cfg.speed_limit_lookup_enabled !== false}
            onChange={v => updateCfg({ speed_limit_lookup_enabled: v })}
          />
        </SettingRow>
        <SettingRow
          icon={Gauge}
          label="Fallback estimate country"
          sublabel={`Regional default estimates are not proof of the posted speed limit. Posted signs, school zones, construction zones, temporary limits, municipal bylaws, and road-specific exceptions can override them. Current estimate profile: ${SPEED_LIMIT_DEFAULT_COUNTRY_LABELS[speedLimitDefaultCountryKey(cfg)] || 'Global'}.`}
        >
          <select
            className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
            value={String(cfg.configurable_country_defaults || cfg.country_code || 'global').split('-')[0].toLowerCase()}
            onChange={event => {
              const value = event.target.value;
              const country = value === 'global' ? '' : value.toUpperCase();
              const regions = country ? regionDefaultOptions(country) : [];
              const combined = regions.length ? `${country}-${regions[0]}` : value;
              updateCfg({
                country_code: country,
                configurable_country_defaults: combined,
              });
            }}
          >
            <option value="global">Global</option>
            <option value="ca">Canada</option>
            <option value="us">United States</option>
            <option value="gb">United Kingdom</option>
            <option value="de">Germany</option>
            <option value="au">Australia</option>
            <option value="fr">France</option>
          </select>
        </SettingRow>
        {(() => {
          const [countryCode, provinceCode] = String(cfg.configurable_country_defaults || cfg.country_code || 'global').toUpperCase().split('-');
          const options = regionDefaultOptions(countryCode);
          if (!options.length) return null;
          return (
            <SettingRow
              icon={MapPin}
              label="Province/State"
              sublabel="Used for regional default estimates when posted speed data is unavailable. More reliable than GPS-only inference, but still an estimate unless confirmed by posted data."
            >
              <select
                className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
                value={provinceCode || options[0]}
                onChange={event => updateCfg({
                  country_code: countryCode,
                  configurable_country_defaults: `${countryCode}-${event.target.value}`,
                })}
              >
                {options.map((option) => (
                  <option key={option} value={option}>{REGION_LABELS[option] || option}</option>
                ))}
              </select>
            </SettingRow>
          );
        })()}
        <SettingsSubheading>Estimated speed guidance</SettingsSubheading>
        <SettingRow
          icon={Gauge}
          label="Use estimated speed guidance"
          sublabel="Shows helpful speed guidance when posted limits are unavailable. Estimates are not legal speed limits."
        >
          <Toggle value={cfg.speed_estimates_enabled !== false} onChange={v => updateCfg({ speed_estimates_enabled: v })} />
        </SettingRow>
        <SettingRow
          icon={Volume2}
          label="Speak posted speed warnings"
        >
          <Toggle value={cfg.speak_posted_speed_warnings !== false} onChange={v => updateCfg({ speak_posted_speed_warnings: v })} />
        </SettingRow>
        <SettingRow
          icon={Volume2}
          label="Speak estimated speed checks"
          sublabel="On by default. Road Sage speaks gentle speed checks for estimated limits using check-posted-signs wording."
        >
          <Toggle value={cfg.speak_estimated_speed_checks === true} onChange={v => updateCfg({ speak_estimated_speed_checks: v })} />
        </SettingRow>
        <SettingRow
          icon={Gauge}
          label="Estimated speed check margin (km/h)"
          sublabel="Voice only. Estimated, regional, learned, and GPS-inferred checks speak only after this many km/h over the estimated limit; visual checks still use confidence-based margins."
        >
          <input
            type="number"
            min={0}
            max={60}
            step={1}
            value={numberDraftValue(cfg.estimated_voice_margin_kmh, 12)}
            placeholder="12"
            onChange={event => updateOptionalNumberDraft(updateCfg, 'estimated_voice_margin_kmh', event.target.value)}
            className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-sm"
          />
        </SettingRow>
        <SettingRow
          icon={Droplets}
          label="Weather from Open-Meteo"
          sublabel="On: Get Road Data can add trip weather using one privacy-safe point and date. Off: no weather score adjustment."
        >
          <Toggle
            value={cfg.weather_context_enabled !== false}
            onChange={v => updateCfg({ weather_context_enabled: v })}
          />
        </SettingRow>
        <SettingRow
          icon={Info}
          label="Auto-fetch enabled road data"
          sublabel="Off: saved trips stay local until you tap Get Road Data. On: future trips fetch only enabled speed-limit and weather lookups after a private delay. OSRM is never automatic."
        >
          <Toggle
            value={isExternalContextAutoFetchEnabled(cfg)}
            onChange={updateExternalContextAutoFetch}
          />
        </SettingRow>
        <SettingsSubheading>Optional route-line cleanup</SettingsSubheading>
        <SettingRow
          icon={Route}
          label="Optional: snap route to roads (OSRM)"
          sublabel="Manual only. This does not add speed limits or weather; it only cleans up a wobbly GPS line after you save a trusted OSRM endpoint."
        >
          <Toggle
            value={cfg.map_matching_enabled !== false && Boolean(cfg.osrm_map_matching_url) && cfg.osrm_data_sharing_consented === true}
            onChange={enableOsrmMapMatching}
          />
        </SettingRow>
        <SettingRow
          icon={Shield}
          label="Privacy-zone OSRM guard"
          sublabel="Always on. Privacy-zone interiors and boundary points are never sent to OSRM; route matching is blocked when an endpoint is inside or within 100 m of a privacy zone."
        >
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
            Always on
          </span>
        </SettingRow>
        <div className="px-1 py-3 border-b border-border/50">
          <div className="flex justify-between gap-3 text-xs mb-1.5">
            <span className="font-medium">OSRM timeout</span>
            <span className="text-primary font-semibold">
              {Math.round((Number(cfg.osrm_timeout_ms) || 12000) / 1000)} sec
            </span>
          </div>
          <input
            type="range"
            min={5}
            max={30}
            step={1}
            value={Math.round((Number(cfg.osrm_timeout_ms) || 12000) / 1000)}
            onChange={event => updateCfg({ osrm_timeout_ms: Number(event.target.value) * 1000 })}
            className="w-full accent-primary"
          />
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>5 sec</span>
            <span>30 sec</span>
          </div>
        </div>
        <div className="px-1 py-3 border-b border-border/50">
          <div className="mb-1 text-xs font-medium">Trusted OSRM endpoint</div>
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.85fr)] lg:items-stretch">
            <input
              value={osrmEndpointDraft}
              onChange={event => setOsrmEndpointDraft(event.target.value)}
              placeholder="https://your-osrm.example"
              className="w-full rounded-xl border border-border bg-card px-3 py-2 text-xs disabled:opacity-50"
            />
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>
                OSRM receives sampled public GPS segments. Leave this blank unless you trust the server.
              </span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={requestSaveOsrmEndpoint}
              disabled={osrmHealthCheckState === 'checking'}
              className="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              {osrmHealthCheckState === 'checking' ? 'Checking...' : 'Save endpoint'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOsrmEndpointDraft('');
                saveOsrmEndpoint('', true);
              }}
              disabled={!cfg.osrm_map_matching_url && !osrmEndpointDraft}
              className="rounded-lg bg-secondary px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Turn off + clear
            </button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Blank keeps route snapping off. Example only: {PUBLIC_OSRM_DEMO_URL}. The public demo is not saved or used by Road Sage because it receives route points and has no service reliability promise.</p>
          <div className="mt-2 rounded-xl bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
            {cfg.osrm_health_status === 'connected' && cfg.osrm_last_reachable_at
              ? `Connected. OSRM last reachable: ${new Date(cfg.osrm_last_reachable_at).toLocaleString()}.`
              : cfg.osrm_health_status === 'unreachable'
                ? `Unreachable${cfg.osrm_last_health_error ? `: ${cfg.osrm_last_health_error}` : '.'}`
                : cfg.map_matching_enabled === false
              ? 'Off: Get Road Data will not contact OSRM, and map/playback use the original GPS line.'
                : cfg.osrm_map_matching_url
                  ? isPublicOsrmDemoUrl(cfg.osrm_map_matching_url)
                    ? 'Blocked: the public OSRM demo cannot be used as a route-snapping endpoint.'
                    : cfg.osrm_data_sharing_consented === true
                      ? 'On: Get Road Data excludes privacy zones, sends sampled public GPS segments to this OSRM link, and stores snapped road points if OSRM matches them.'
                      : 'Consent needed: save this endpoint and confirm OSRM data sharing before route snapping can run.'
                : 'Needs link: route snapping is on, but Get Road Data will skip OSRM until an endpoint is set.'}
          </div>
        </div>
        <div className="mx-1 mb-3 rounded-2xl border border-border bg-card p-3 text-xs text-muted-foreground">
          <div className="font-semibold text-foreground">What leaves the app</div>
          <div className="mt-2 grid gap-2">
            <div><span className="font-semibold text-foreground">Local road-speed edits:</span> nothing is sent to OpenStreetMap. The speed, evidence type, road name, and note stay on this device.</div>
            <div><span className="font-semibold text-foreground">OSM map viewing:</span> tile coordinates for the visible map area plus your IP address and normal network metadata go to the tile provider.</div>
            <div><span className="font-semibold text-foreground">OSM speed lookup:</span> privacy-filtered public-road bounding boxes plus normal network metadata go to an Overpass service. Saved corrections and notes are not included.</div>
            <div><span className="font-semibold text-foreground">Weather:</span> one privacy-safe route point and trip date go to Open-Meteo when enabled and requested.</div>
            <div><span className="font-semibold text-foreground">OSRM:</span> sampled public GPS coordinate pairs go only to the endpoint you save and approve; privacy-zone interiors are excluded.</div>
          </div>
        </div>
        <div className="mx-1 mb-3 rounded-2xl border border-border bg-card p-3 text-xs text-muted-foreground">
          <div className="font-semibold text-foreground">On/off examples</div>
          <div className="mt-2 grid gap-2">
            <div>
              <span className="font-semibold text-foreground">Speed limits {cfg.speed_limit_lookup_enabled === false ? 'OFF' : 'ON'}:</span>{' '}
              {cfg.speed_limit_lookup_enabled === false
                ? 'a 100 km/h highway trip is judged against GPS/fallback rules; OpenStreetMap is not contacted.'
                : `after you confirm Get Road Data, privacy-filtered public road boxes are sent to OpenStreetMap so the trip can show road names and posted maxspeed limits. Missing maxspeed tags use the ${String(cfg.country_code || cfg.configurable_country_defaults || 'global').toUpperCase()} estimate profile, not an official traffic-law lookup.`}
            </div>
            <div>
              <span className="font-semibold text-foreground">Weather {cfg.weather_context_enabled === false ? 'OFF' : 'ON'}:</span>{' '}
              {cfg.weather_context_enabled === false
                ? 'Open-Meteo is not contacted; rain, snow, fog, or ice do not change the score.'
                : 'after you confirm Get Road Data, one non-private route point plus the trip date is sent to Open-Meteo for rain, snow, fog, or freezing risk.'}
            </div>
            <div>
              <span className="font-semibold text-foreground">Snap route to roads {cfg.map_matching_enabled === false ? 'OFF' : cfg.osrm_map_matching_url && cfg.osrm_data_sharing_consented === true ? 'ON' : 'NEEDS CONSENT'}:</span>{' '}
              {cfg.map_matching_enabled === false
                ? 'skips OSRM; map/playback keep the original GPS line.'
                : cfg.osrm_map_matching_url
                  ? isPublicOsrmDemoUrl(cfg.osrm_map_matching_url)
                    ? 'blocked because the public OSRM demo is reference text only.'
                    : cfg.osrm_data_sharing_consented === true
                      ? 'excludes privacy zones, sends sampled public GPS segments to your trusted OSRM endpoint, and may make map/playback follow roads more cleanly.'
                      : 'will be skipped until OSRM data-sharing consent is saved.'
                  : 'will be skipped until an OSRM endpoint is added.'}
            </div>
            <div>
              <span className="font-semibold text-foreground">Auto-fetch {isExternalContextAutoFetchEnabled(cfg) ? 'ON' : 'OFF'}:</span>{' '}
              {isExternalContextAutoFetchEnabled(cfg)
                ? 'future saved trips fetch only enabled speed-limit and weather lookups after a randomized privacy delay. OSRM still waits for manual Get Road Data.'
                : 'nothing is sent automatically after saving a trip; the user must tap Get Road Data for that trip.'}
            </div>
          </div>
        </div>
        <div className="px-1">
          <div className="flex justify-between text-xs mb-1.5">
            <span className="font-medium">Warn when over limit by</span>
            <span className="text-primary font-semibold">+{cfg.threshold_speed_over_kmh ?? 5} km/h</span>
          </div>
          <input
            type="range" min={5} max={30} step={5}
            value={cfg.threshold_speed_over_kmh ?? 5}
            disabled={cfg.speed_warning_enabled === false}
            onChange={e => updateCfg({ threshold_speed_over_kmh: parseFloat(e.target.value) })}
            className="w-full accent-primary disabled:opacity-45"
          />
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>+5 km/h (strict)</span>
            <span>+30 km/h (lenient)</span>
          </div>
        </div>

        </>)}</SettingsSection>

        <SettingsSection id="settings-privacy-data" activeId={activeSettingsSection}>{() => (<>
        {/* Privacy */}
        <SectionTitle id="settings-privacy-data">Privacy & Data</SectionTitle>
        <div>
          <SettingRow
            icon={Shield}
            label="Legal, safety, data & privacy notice"
            sublabel={`Same required notice shown on first launch and after notice updates. Review legal limits, safety responsibilities, consent, app-close tracking rules, speed-limit trust, data sharing, exports, backups, and privacy controls anytime. ${legalNoticeStatus}.`}
            onClick={showPrivacyPolicy}
          >
            <div className="flex items-center gap-2">
              {legalNoticeNeedsReview && (
                <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-100">
                  Review
                </span>
              )}
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </div>
          </SettingRow>
          <SettingRow
            icon={Shield}
            label="Privacy Intelligence"
            sublabel="See outbound data records, active protections, privacy-zone counters, and audit-chain health"
            onClick={() => navigate('/privacy-intelligence')}
          >
            <div className="flex items-center gap-2">
              {privacyHealthStatus !== 'Healthy' && (
                <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-100">
                  Review
                </span>
              )}
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </div>
          </SettingRow>
          <SettingRow
            icon={Shield}
            label="Heightened privacy mode"
            sublabel={`One switch for sensitive sessions. ${HEIGHTENED_PRIVACY_MODE_EFFECTS.join(' ')}`}
          >
            <Toggle
              value={cfg.heightened_privacy_mode === true}
              onChange={updateHeightenedPrivacyMode}
            />
          </SettingRow>
          {cfg.heightened_privacy_mode === true && (
            <div className="mx-1 mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
              <div className="font-semibold">Heightened privacy mode is active</div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {HEIGHTENED_PRIVACY_MODE_EFFECTS.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          <SettingRow
            icon={Clock}
            label="Request timing obfuscation"
            sublabel={cfg.heightened_privacy_mode === true ? 'Forced on while heightened privacy mode is active.' : 'Randomizes automatic post-trip request timing. Manual Get Road Data runs immediately.'}
          >
            <Toggle
              value={cfg.heightened_privacy_mode === true || cfg.request_obfuscation_enabled !== false}
              onChange={(value) => updateCfg({ request_obfuscation_enabled: value })}
              disabled={cfg.heightened_privacy_mode === true}
            />
          </SettingRow>
          <SettingRow
            icon={Route}
            label="Decoy traffic"
            sublabel="Off by default. Optional decoys use only the existing Open-Meteo endpoint and a neutral location."
          >
            <select
              value={cfg.decoy_traffic_mode || 'off'}
              onChange={(event) => updateCfg({ decoy_traffic_mode: event.target.value })}
              disabled={cfg.request_obfuscation_enabled === false}
              className="max-w-[12rem] rounded-lg border border-input bg-background px-2 py-1.5 text-xs"
            >
              <option value="off">Off (recommended)</option>
              <option value="first_party">Open-Meteo only</option>
            </select>
          </SettingRow>
          {isAndroid() && (
            <SettingRow
              icon={Lock}
              label="Require authentication to open Road Sage"
              sublabel="Uses fingerprint, secure face unlock, or your device screen lock. Locks again after 5 minutes in the background."
            >
              <OptimisticCheckbox
                checked={cfg.app_lock_enabled === true}
                onCheckedChange={(checked) => updateAppLockEnabled(checked === true)}
                aria-label="Require authentication to open Road Sage"
              />
            </SettingRow>
          )}
          {isAndroid() && (
            <SettingRow
              icon={Smartphone}
              label="Allow screenshots and screen sharing"
              sublabel="Off by default. Turning this on can expose trip maps and private location history to other apps."
            >
              <OptimisticCheckbox
                checked={cfg.allow_screen_capture === true}
                onCheckedChange={(checked) => updateScreenCaptureAllowed(checked === true)}
                aria-label="Allow screenshots and screen sharing"
              />
            </SettingRow>
          )}
          {isAndroid() && (
            <div className={`my-3 rounded-xl border p-3 text-sm ${
              integrityThreatDetected
                ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100'
                : 'border-green-200 bg-green-50 text-green-900 dark:border-green-900/60 dark:bg-green-950/25 dark:text-green-100'
            }`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-semibold">
                    {integrityThreatDetected ? <AlertTriangle className="h-4 w-4" /> : <Shield className="h-4 w-4" />}
                    Device integrity
                  </div>
                  <div className="mt-1 text-xs leading-relaxed">
                    {integrityThreatDetected
                      ? 'This device has signals that may allow other apps or users with elevated privileges to read private location data despite encryption.'
                      : 'No root, debug, emulator, or USB debugging signals are currently reported by Android.'}
                  </div>
                  {integrityThreatDetected && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {integrityThreats.map((threat) => (
                        <span key={threat} className="rounded-full bg-card/90 px-2 py-1 text-[11px] font-semibold">
                          {formatRaspThreat(threat)}
                        </span>
                      ))}
                    </div>
                  )}
                  {integrityThreatDetected && (
                    <div className="mt-2 text-xs">
                      Privacy zones still mask trips. If you turn on privacy circles below, Road Sage will show offset, expanded outlines, but those outlines can still hint at private places on a debug or modified device.
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => refreshDeviceIntegrity()}
                  disabled={integrityChecking}
                  className="shrink-0 rounded-lg border border-current/20 bg-card/80 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                >
                  {integrityChecking ? 'Checking...' : 'Check again'}
                </button>
              </div>
            </div>
          )}
          {isAndroid() && (
            <SettingRow
              icon={Shield}
              label="Block new privacy zones on compromised devices"
              sublabel="On by default. Existing zones keep masking, but new zone storage is refused when root, debug, emulator, or USB debugging signals are detected."
            >
              <OptimisticCheckbox
                checked={cfg.privacy_zone_storage_requires_secure_device !== false}
                onCheckedChange={(checked) => updateCfg({ privacy_zone_storage_requires_secure_device: checked === true })}
                aria-label="Block new privacy zones on compromised devices"
              />
            </SettingRow>
          )}
          <div className="my-3 rounded-xl border border-border bg-secondary/30 p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="text-sm font-semibold">Survey labels</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {calibrationLabels.length} saved label{calibrationLabels.length === 1 ? '' : 's'} - {answeredCalibrationTrips} answered trip{answeredCalibrationTrips === 1 ? '' : 's'}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={clearCalibrationLabels}
                  disabled={calibrationLabels.length === 0}
                  className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground disabled:opacity-50"
                >
                  Clear labels
                </button>
              </div>
            </div>

            <div className="mt-3 rounded-lg border border-border bg-background/70 p-3 text-xs text-muted-foreground">
              <div className="font-semibold text-foreground">What survey answers do</div>
              <div className="mt-1">
                Survey answers stay on this device. They do not upload anywhere, change past trip scores, or automatically tune detection thresholds.
              </div>
              <div className="mt-2">
                The app uses them as local calibration notes: Settings can compare your rating with the app score, show whether scores feel too harsh or too generous, track coverage gaps like city/highway/night trips, preserve the labels in backup/export, and log survey actions in System Logs.
              </div>
            </div>

            {calibrationLabels.length > 0 ? (
              <div className="mt-3 space-y-3">
                <div className="grid gap-2 text-xs sm:grid-cols-4">
                  <div className="rounded-lg bg-card p-2">
                    <div className="font-semibold text-foreground">{calibrationSurveySummary.usable}</div>
                    <div className="text-muted-foreground">Usable labels</div>
                  </div>
                  <div className="rounded-lg bg-card p-2">
                    <div className="font-semibold text-foreground">
                      {calibrationSurveySummary.averageScoreDelta != null
                        ? `${calibrationSurveySummary.averageScoreDelta > 0 ? '+' : ''}${calibrationSurveySummary.averageScoreDelta}`
                        : 'N/A'}
                    </div>
                    <div className="text-muted-foreground">Avg score delta</div>
                  </div>
                  <div className="rounded-lg bg-card p-2">
                    <div className="font-semibold text-foreground">{answeredCalibrationTrips}</div>
                    <div className="text-muted-foreground">Answered trips</div>
                  </div>
                  <div className="rounded-lg bg-card p-2">
                    <div className="font-semibold text-foreground">{excludedCalibrationLabels}</div>
                    <div className="text-muted-foreground">Excluded labels</div>
                  </div>
                </div>

                <div className="rounded-lg bg-card p-3 text-xs text-muted-foreground">
                  <div className="font-semibold text-foreground">Coverage</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {Object.entries(calibrationSurveyCoverage.buckets).map(([bucket, count]) => (
                      <span key={bucket} className="rounded-full bg-secondary px-2 py-1 font-semibold capitalize">
                        {bucket.replace(/([A-Z])/g, ' $1')}: {count}
                      </span>
                    ))}
                  </div>
                  {calibrationSurveyCoverage.missingCoreBuckets.length > 0 && (
                    <div className="mt-2">
                      Missing core coverage: {calibrationSurveyCoverage.missingCoreBuckets.join(', ')}.
                    </div>
                  )}
                  {calibrationSurveyCoverage.weakBuckets.length > 0 && (
                    <div className="mt-1">
                      Thin coverage: {calibrationSurveyCoverage.weakBuckets.join(', ')}.
                    </div>
                  )}
                </div>

                <div className="overflow-hidden rounded-lg border border-border text-xs">
                  {recentCalibrationLabels.map((label) => (
                    <div key={label.id || label.labelId} className="grid grid-cols-[1fr_auto] gap-2 border-b border-border/50 p-2 last:border-0">
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-foreground">
                          Rating {label.surveyLabel?.overallDriveRating ?? 'N/A'} - {calibrationLabelDate(label)}
                        </div>
                        <div className="mt-0.5 truncate text-muted-foreground">
                          Local only - {label.eligibleForCalibration === false ? 'excluded from calibration' : 'eligible for analysis'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => deleteCalibrationLabel(label.id)}
                        className="rounded-lg border border-border px-2 py-1 font-semibold text-muted-foreground"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
                {calibrationLabelStatus && (
                  <div className="text-xs font-medium text-muted-foreground">{calibrationLabelStatus}</div>
                )}
              </div>
            ) : (
              <div className="mt-3 text-xs text-muted-foreground">
                No survey labels saved yet. Quick ratings on Trip Detail will appear here.
              </div>
            )}
          </div>
          <div className="my-3 rounded-2xl border border-border bg-secondary/30 p-3">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <MapPin className="h-4 w-4 text-primary" />
                  Privacy Zones
                  {privacyZoneOverlaps.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-100">
                      <AlertTriangle className="h-3 w-3" />
                      {privacyZoneOverlaps.length} overlap{privacyZoneOverlaps.length === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Mask sensitive places from maps, CSV exports, and backups. Local trip totals are not randomized; privacy-protected exports add small random noise to aggregate values.
                </div>
              </div>
              <span className="rounded-full bg-card px-2 py-1 text-xs font-semibold">{privacyZones.length}</span>
            </div>
            <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-[minmax(0,1fr)_150px]">
              <input
                value={privacyDraft.label}
                onChange={(event) => setPrivacyDraft((draft) => ({ ...draft, label: event.target.value }))}
                className="min-w-0 rounded-xl border border-border bg-card px-3 py-2 text-sm"
                placeholder="Home, work, school"
              />
              <label className="text-[11px] font-medium text-muted-foreground">
                {privacyDraft.type === 'corridor' ? 'Buffer each side (m)' : 'Radius (m)'}
                <input
                  type="number"
                  inputMode="numeric"
                  min={PRIVACY_RADIUS_MIN_M}
                  max={PRIVACY_RADIUS_MAX_M}
                  step="10"
                  value={privacyDraft.radius_m}
                  onChange={(event) => {
                    const { value } = event.target;
                    setPrivacyDraftRadiusError('');
                    setPrivacyDraft((draft) => ({
                      ...draft,
                      radius_m: value,
                    }));
                  }}
                  onBlur={commitPrivacyDraftRadius}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur();
                    }
                  }}
                  className={`mt-1 w-full min-w-0 rounded-xl border bg-card px-3 py-2 text-sm text-foreground ${privacyDraftRadiusError ? 'border-red-500 focus:outline-red-500' : 'border-border'}`}
                  aria-label={privacyDraft.type === 'corridor' ? 'Privacy corridor buffer on each side in meters' : 'Privacy zone radius in meters'}
                />
              </label>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="text-[11px] font-medium text-muted-foreground">
                Zone shape
                <select
                  value={privacyDraft.type}
                  onChange={(event) => {
                    const type = event.target.value === 'corridor' ? 'corridor' : 'circle';
                    setPrivacyDraft((draft) => ({ ...draft, type }));
                    setSuggestedPrivacyLocation(null);
                  }}
                  className="mt-1 w-full rounded-lg border border-border bg-card px-2 py-2 text-xs text-foreground"
                  aria-label="Privacy zone shape"
                >
                  <option value="circle">Circle</option>
                  <option value="corridor">Route corridor</option>
                </select>
              </label>
              <label className="text-[11px] font-medium text-muted-foreground">
                Sensitivity
                <select
                  value={privacyDraft.sensitivity}
                  onChange={(event) => setPrivacyDraft((draft) => ({
                    ...draft,
                    sensitivity: event.target.value === 'high' ? 'high' : 'standard',
                  }))}
                  className="mt-1 w-full rounded-lg border border-border bg-card px-2 py-2 text-xs text-foreground"
                  aria-label="Privacy zone sensitivity"
                >
                  <option value="standard">Standard</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label className="text-[11px] font-medium text-muted-foreground">
                Duration
                <select
                  value={privacyDraft.durationDays}
                  onChange={(event) => setPrivacyDraft((draft) => ({ ...draft, durationDays: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-border bg-card px-2 py-2 text-xs text-foreground"
                  aria-label="Privacy zone duration"
                >
                  <option value="permanent">Permanent</option>
                  <option value="1">24 hours</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                </select>
              </label>
            </div>
            <div className={`mt-1 flex justify-end text-[11px] font-medium ${privacyDraftRadiusError ? 'text-red-500' : 'text-muted-foreground'}`}>
              Allowed {privacyDraft.type === 'corridor' ? 'side buffer' : 'radius'}: {PRIVACY_RADIUS_MIN_M}-{PRIVACY_RADIUS_MAX_M} m
            </div>
            {privacyDraftRadiusError && (
              <div className="mt-1 text-right text-[11px] font-medium text-red-500">
                {privacyDraftRadiusError}
              </div>
            )}
            <div className="mt-2 rounded-xl bg-card px-3 py-2 text-xs text-muted-foreground">
              {privacyDraft.type === 'corridor'
                ? `${privacyDraft.radius_m || PRIVACY_RADIUS_DEFAULT_M} m is protected on each side of the route (about ${(Number(privacyDraft.radius_m) || PRIVACY_RADIUS_DEFAULT_M) * 2} m total, plus rounded ends).`
                : `${privacyDraft.radius_m || PRIVACY_RADIUS_DEFAULT_M} m is measured outward from the selected center point.`}
              {' '}Values outside {PRIVACY_RADIUS_MIN_M}-{PRIVACY_RADIUS_MAX_M} m are rejected. Zone creation does not send typed labels or addresses to a geocoder.
            </div>
            <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100">
              Existing raw GPS inside this zone is erased when the zone is saved. High sensitivity also blocks OSRM route sharing whenever a route touches the zone.
            </div>
            {privacyDraft.type === 'corridor' && (
              <div className="mt-2 rounded-xl border border-border bg-background/60 p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold">Local corridor waypoints</div>
                    <div className="mt-0.5 text-muted-foreground">
                      {privacyCorridorWaypoints.length}/{PRIVACY_CORRIDOR_MAX_WAYPOINTS} points. They form one protected route in the order added.
                    </div>
                  </div>
                  {privacyCorridorWaypoints.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setPrivacyCorridorWaypoints([])}
                      className="rounded-lg border border-border px-2 py-1 font-semibold"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 min-[640px]:grid-cols-3">
                  <button
                    type="button"
                    onClick={addCurrentCorridorWaypoint}
                    disabled={privacyCorridorWaypoints.length >= PRIVACY_CORRIDOR_MAX_WAYPOINTS}
                    className="rounded-lg border border-border bg-card px-2.5 py-2 text-left font-semibold disabled:opacity-50"
                  >
                    <span className="block">Add my location</span>
                    <span className="mt-0.5 block font-normal text-muted-foreground">Appends your live GPS position as the next route point.</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const lat = Number(parkedLocation?.lat);
                      const lng = Number(parkedLocation?.lng);
                      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
                      setPrivacyCorridorWaypoints((points) => (
                        points.length >= PRIVACY_CORRIDOR_MAX_WAYPOINTS ? points : points.concat({ lat, lng })
                      ));
                    }}
                    disabled={!parkedLocation || privacyCorridorWaypoints.length >= PRIVACY_CORRIDOR_MAX_WAYPOINTS}
                    className="rounded-lg border border-border bg-card px-2.5 py-2 text-left font-semibold disabled:opacity-50"
                  >
                    <span className="block">Add parked location</span>
                    <span className="mt-0.5 block font-normal text-muted-foreground">Appends the last locally saved parking position.</span>
                  </button>
                  <button
                    type="button"
                    onClick={useRecentTripForCorridor}
                    className="rounded-lg border border-border bg-card px-2.5 py-2 text-left font-semibold"
                  >
                    <span className="block">Use latest saved trip</span>
                    <span className="mt-0.5 block font-normal text-muted-foreground">Replaces these points with a sampled copy of the newest local route.</span>
                  </button>
                </div>
                {privacyCorridorWaypoints.length < PRIVACY_CORRIDOR_MIN_WAYPOINTS && (
                  <div className="mt-2 rounded-lg border border-dashed border-border bg-card px-3 py-2 font-medium text-muted-foreground">
                    Add at least {PRIVACY_CORRIDOR_MIN_WAYPOINTS} route points to check corridor protection. Use Add my location twice from two places, add your parked location, or use the latest saved trip.
                  </div>
                )}
                {privacyCorridorWaypoints.length >= PRIVACY_CORRIDOR_MIN_WAYPOINTS && (
                  <button
                    type="button"
                    onClick={() => void openPrivacyProtectionCheck({
                      type: 'corridor',
                      waypoints: privacyCorridorWaypoints,
                      sourceLabel: 'Selected corridor points',
                    }, 'Verify to review these selected corridor points')}
                    className="mt-2 w-full rounded-lg bg-primary px-3 py-2 font-semibold text-primary-foreground"
                  >
                    Check protected corridor
                  </button>
                )}
              </div>
            )}
            <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
              <div className="font-semibold">What protection actually does</div>
              <div className="mt-1 opacity-85">
                GPS points and driving events inside the zone are removed before local route storage and excluded from OSRM, weather, and road-data requests. Existing saved GPS inside a saved or changed zone is erased immediately; Option 2 is still available when deleting a zone to purge again before removal.
              </div>
            </div>
            <div className="mt-2 rounded-xl border border-border bg-background/60 p-3 text-xs">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">Privacy-zone protection self-test</div>
                  <div className="mt-1 text-muted-foreground">
                    Uses synthetic coordinates only. Verifies private GPS is redacted before storage and a synthetic outbound request is blocked with zero bytes sent.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={runPrivacyZoneProtectionTest}
                  disabled={privacyProtectionTestBusy}
                  className="rounded-lg border border-border bg-card px-3 py-2 font-semibold disabled:opacity-50"
                >
                  {privacyProtectionTestBusy ? 'Testing...' : 'Run privacy self-test'}
                </button>
              </div>
              {privacyProtectionTest && (
                <div className={`mt-2 rounded-lg px-3 py-2 font-medium ${
                  privacyProtectionTest.status === 'ok'
                    ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100'
                    : 'bg-red-100 text-red-900 dark:bg-red-950/50 dark:text-red-100'
                }`}>
                  {privacyProtectionTest.status === 'ok' ? 'Verified: ' : 'Needs attention: '}
                  {privacyProtectionTest.evidence}
                </div>
              )}
            </div>
            <div className="mt-2 rounded-xl border border-border bg-background/60 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-semibold">Privacy Health</div>
                  <div className="mt-0.5 text-muted-foreground">
                    {privacyZones.length} zone{privacyZones.length === 1 ? '' : 's'} - all excluded from OSRM - {privacyZoneOverlaps.length} overlap{privacyZoneOverlaps.length === 1 ? '' : 's'}
                  </div>
                </div>
                <span className={`rounded-full px-2 py-1 font-semibold ${
                  privacyNativeSyncFailed
                    ? 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-100'
                    : integrityThreatDetected
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-100'
                    : privacyRescoreActive
                    ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-100'
                    : privacyZoneOverlaps.length
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-100'
                      : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100'
                }`}>
                  {privacyHealthStatus}
                </span>
              </div>
              {privacyNativeSyncFailed && (
                <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100">
                  Android did not receive the latest privacy zones, so background auto tracking is off until zones sync successfully.
                </div>
              )}
              {integrityThreatDetected && (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                  Device integrity warnings are active. Privacy-zone display circles are allowed only if you turn them on, and new zone storage is blocked while the secure-device guard is on.
                </div>
              )}
              {privacyRescoreActive && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-900/50">
                  <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${rescoreProgressPct}%` }} />
                </div>
              )}
            </div>
            {privacyZoneOverlaps.length > 0 && (
              <div className="mt-2 space-y-2">
                {privacyZoneOverlaps.map((pair) => (
                  <div
                    key={`${pair.a.id || pair.a.label}_${pair.b.id || pair.b.label}`}
                    className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
                  >
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <div>
                        <span className="font-semibold">Privacy zones overlap: </span>
                        "{pair.a.label}" and "{pair.b.label}" overlap by about {Math.round(pair.overlapMeters)} m.
                        Points covered by both zones use the zone they are deepest inside. Consider merging them or adjusting radii.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => mergeOverlappingPrivacyZones(pair)}
                      className="mt-2 rounded-lg border border-amber-300 bg-white/70 px-2.5 py-1.5 font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
                    >
                      Merge zones
                    </button>
                  </div>
                ))}
              </div>
            )}
            <SettingRow
              icon={Eye}
              label="Show circle-zone outlines on trip maps"
              sublabel={integrityThreatDetected ? 'Allowed with warning. Offset circle outlines can still hint at private places on a debug or modified device. Saved corridors stay hidden.' : 'Off by default. Shows offset circle outlines only; saved corridors stay hidden because their exact route geometry is not retained.'}
            >
              <OptimisticCheckbox
                checked={cfg.show_privacy_circles === true}
                onCheckedChange={(checked) => updateShowPrivacyCircles(checked === true)}
                aria-label="Show circle privacy zone outlines on trip maps"
              />
            </SettingRow>
            {suggestedPrivacyLocation && (
              <div className="mt-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-100">
                <div className="font-semibold">Frequent-stop suggestion ready</div>
                <div className="mt-1 opacity-85">
                  Review the label and {privacyDraft.radius_m} m radius above, then run the protection check. Its coordinates remain local.
                </div>
              </div>
            )}
            {privacyDraft.type !== 'corridor' && (
              <div className={`mt-2 grid gap-2 ${suggestedPrivacyLocation ? 'grid-cols-1 min-[420px]:grid-cols-3' : 'grid-cols-2'}`}>
              {suggestedPrivacyLocation && (
                <button
                  type="button"
                  onClick={() => void openPrivacyProtectionCheck({
                    type: 'circle',
                    location: suggestedPrivacyLocation,
                    sourceLabel: 'Suggested private place',
                    clearSuggestionOnSave: true,
                  }, 'Verify to review this suggested private place')}
                  disabled={privacyZoneStorageBlocked}
                  title={privacyZoneStorageBlocked ? 'Blocked by the secure-device privacy-zone guard. Use the help below to enable adding zones.' : 'Add the suggested privacy zone'}
                  className="flex items-center justify-center gap-1.5 rounded-xl bg-sky-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                >
                  <MapPin className="h-3.5 w-3.5" />
                  Check Suggested
                </button>
              )}
              <button
                type="button"
                onClick={addCurrentPrivacyZone}
                disabled={privacyZoneStorageBlocked}
                title={privacyZoneStorageBlocked ? 'Blocked by the secure-device privacy-zone guard. Use the help below to enable adding zones.' : 'Add a privacy zone at your current location'}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
              >
                <LocateFixed className="h-3.5 w-3.5" />
                Check Current
              </button>
              <button
                type="button"
                onClick={() => void openPrivacyProtectionCheck(
                  { type: 'circle', location: parkedLocation, sourceLabel: 'Parked location' },
                  'Verify to review protection for your parked location'
                )}
                disabled={!parkedLocation || privacyZoneStorageBlocked}
                title={privacyZoneStorageBlocked ? 'Blocked by the secure-device privacy-zone guard. Use the help below to enable adding zones.' : !parkedLocation ? 'No parked location is saved yet.' : 'Add a privacy zone at your parked location'}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-semibold disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                Check Parked
              </button>
              </div>
            )}
            {privacyZoneStorageBlocked && (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                <div className="font-semibold">Add Current is disabled by the secure-device guard.</div>
                <div className="mt-1">
                  This debug/USB setup can expose private places more easily. To enable adding zones, either fix the warnings and tap Check again, or allow new privacy zones on this device.
                </div>
                <label className="mt-2 flex items-start gap-2 rounded-lg bg-card/70 p-2 font-medium">
                  <OptimisticCheckbox
                    checked={false}
                    onCheckedChange={(checked) => {
                      if (checked === true) updateCfg({ privacy_zone_storage_requires_secure_device: false });
                    }}
                    aria-label="Allow adding privacy zones on this device despite integrity warnings"
                    className="mt-0.5"
                  />
                  <span>
                    I understand the risk. Allow adding privacy zones on this device.
                  </span>
                </label>
              </div>
            )}
            {privacyZones.length > 0 && (
              <div className="mt-3 space-y-2">
                {privacyZones.map((zone) => (
                  <div key={zone.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-card px-3 py-2 text-xs">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{zone.label}</div>
                      <div className="text-muted-foreground">
                        {zone.type === 'corridor' ? 'Route corridor' : 'Circle'} - {Math.round(zone.radius_m)} m {zone.type === 'corridor' ? 'buffer each side' : 'radius'} - {zone.sensitivity === 'high' ? 'high sensitivity' : 'standard'}
                        {zone.expiresAt ? ` - expires ${new Date(zone.expiresAt).toLocaleString()}` : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={PRIVACY_RADIUS_MIN_M}
                        max={PRIVACY_RADIUS_MAX_M}
                        step="10"
                        value={privacyRadiusDrafts[zone.id] ?? String(Math.round(zone.radius_m))}
                        onChange={(event) => {
                          const { value } = event.target;
                          setPrivacyRadiusDrafts((drafts) => ({ ...drafts, [zone.id]: value }));
                          setPrivacyZoneRadiusErrors((errors) => {
                            if (!errors[zone.id]) return errors;
                            const next = { ...errors };
                            delete next[zone.id];
                            return next;
                          });
                        }}
                        onBlur={(event) => updatePrivacyZoneRadius(zone, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur();
                          }
                        }}
                        className={`h-8 w-20 rounded-lg border bg-background px-2 text-right text-xs font-semibold ${privacyZoneRadiusErrors[zone.id] ? 'border-red-500 focus:outline-red-500' : 'border-border'}`}
                        aria-label={`${zone.type === 'corridor' ? 'Buffer on each side' : 'Radius'} in meters for ${zone.label}`}
                        title={`Allowed ${zone.type === 'corridor' ? 'side buffer' : 'radius'}: ${PRIVACY_RADIUS_MIN_M}-${PRIVACY_RADIUS_MAX_M} m`}
                      />
                      <button
                        type="button"
                        onClick={() => requestDeletePrivacyZone(zone)}
                        className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-red-500"
                        aria-label={`Delete ${zone.label} privacy zone`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {privacyZoneRadiusErrors[zone.id] && (
                      <div className="basis-full text-right text-[11px] font-medium text-red-500">
                        {privacyZoneRadiusErrors[zone.id]}
                      </div>
                    )}
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
            <span className="text-xs font-semibold text-muted-foreground">
              {tripExportBusy ? 'Preparing...' : 'CSV'}
            </span>
          </SettingRow>
          <SettingRow
            icon={Download}
            label="Export Everything"
            sublabel="Versioned JSON portability bundle with trips, settings, privacy zones, vehicles, and score history"
            onClick={handleExportEverything}
          >
            <span className="text-xs font-semibold text-muted-foreground">
              {portabilityExportBusy ? 'Preparing...' : 'JSON'}
            </span>
          </SettingRow>
          <SettingRow
            icon={Download}
            label="Export Full Backup"
            sublabel="Complete backup with trips, route points, events, vehicles, settings, and saved road-speed rules"
            onClick={handleExportBackup}
          >
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </SettingRow>
          <SettingRow
            icon={Upload}
            label="Import Backup"
            sublabel="Restore an encrypted or JSON Road Sage backup into local storage"
            onClick={() => importInputRef.current?.click()}
          >
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </SettingRow>
          <SettingRow
            icon={Trash2}
            label="Erase All Local Data"
            sublabel="Overwrite/remove local Road Sage stores and export a proof-of-erasure receipt. Last app action before reload."
            onClick={handleEraseAllLocalData}
          >
            <span className="rounded-full border border-red-200 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
              {erasureBusy ? 'Erasing...' : 'Erase'}
            </span>
          </SettingRow>
          <SettingRow
            icon={Info}
            label="Data Retention"
            sublabel="Delete the entire trip after this period"
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
            icon={Shield}
            label="Privacy Log Retention"
            sublabel="How long to keep privacy zone operation records"
          >
            <select
              value={Number(cfg.privacy_log_retention_hours ?? 24)}
              onChange={(event) => updatePrivacyLogRetention(Number(event.target.value))}
              className="bg-card border border-border rounded-lg text-xs px-2 py-1"
            >
              <option value={0}>Off</option>
              <option value={1}>1 hour</option>
              <option value={24}>24 hours</option>
              <option value={72}>3 days</option>
            </select>
          </SettingRow>
          <SettingRow
            icon={MapPin}
            label="Raw GPS Retention"
            sublabel="Remove route coordinates while keeping scores, distance, duration, and other summaries"
          >
            <div className="flex flex-wrap items-center justify-end gap-2">
              <select
                value={Number(cfg.raw_gps_retention_days || 0)}
                onChange={(event) => updateRawGpsRetention(Number(event.target.value))}
                className="bg-card border border-border rounded-lg text-xs px-2 py-1"
              >
                <option value={0}>Off</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={180}>180 days</option>
                <option value={365}>1 year</option>
              </select>
              <button
                type="button"
                onClick={runRawGpsRetentionNow}
                disabled={rawGpsLifecycleBusy || !Number(cfg.raw_gps_retention_days)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
              >
                {rawGpsLifecycleBusy ? 'Running...' : 'Run now'}
              </button>
              <span className="w-full text-right text-[11px] text-muted-foreground">
                Last run: {rawGpsLifecycleStatus?.lastRunAt
                  ? new Date(rawGpsLifecycleStatus.lastRunAt).toLocaleString()
                  : 'Never'}. Existing backup files are not changed.
              </span>
            </div>
          </SettingRow>
          <SettingRow
            icon={Check}
            label="Verify Audit Log"
            sublabel="Check the tamper-evident chain for privacy and OSRM decisions"
          >
            <button
              type="button"
              onClick={handleVerifyAuditLog}
              disabled={auditVerifying}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              {auditVerifying ? 'Checking...' : 'Verify'}
            </button>
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
          {cfg.osrm_consent_invalidated_reason === 'privacy_zone_changed' && (
            <div className="mx-1 mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div>
                  <div className="font-semibold">OSRM consent needs review</div>
                  <div className="mt-1">
                    {cfg.osrm_consent_invalidated_zone_label || 'A privacy zone'} changed. OSRM is paused until you review the endpoint and consent again. Zones marked excluded are removed from OSRM requests.
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={requestSaveOsrmEndpoint}
                  className="rounded-lg bg-amber-900 px-3 py-1.5 font-semibold text-white dark:bg-amber-200 dark:text-amber-950"
                >
                  Review consent
                </button>
                <button
                  type="button"
                  onClick={() => updateCfg({
                    map_matching_enabled: false,
                    osrm_data_sharing_consented: false,
                    osrm_data_sharing_consented_at: '',
                    osrm_consent_invalidated_reason: '',
                    osrm_consent_invalidated_at: '',
                    osrm_consent_invalidated_zone_label: '',
                  })}
                  className="rounded-lg border border-amber-400 px-3 py-1.5 font-semibold"
                >
                  Keep OSRM off
                </button>
              </div>
            </div>
          )}
        </div>
        </>)}</SettingsSection>
      </div>
          )}
        </div>
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept={BACKUP_IMPORT_ACCEPT}
        className="hidden"
        onChange={handleImportBackup}
      />

      <Dialog open={rescoreConfirmOpen} onOpenChange={(open) => {
        if (!rescoreBusy) setRescoreConfirmOpen(open);
      }}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>
              {rescoreOnlyProvenanceMismatch ? 'Update outdated trip scores?' : 'Recalculate historical trip scores?'}
            </DialogTitle>
            <DialogDescription>
              Road Sage will recalculate {rescoreCandidateCount} eligible completed trip{rescoreCandidateCount === 1 ? '' : 's'} immediately using the current scoring model and detection settings.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 rounded-xl border border-border bg-secondary/40 p-3 text-sm">
            <div>Stored Safety, Smoothness, Eco and Overall scores may increase, decrease or stay the same.</div>
            <div>Reviewed events marked wrong will be removed from scoring.</div>
            {rescoreIneligibleCount > 0 && (
              <div className="text-amber-700 dark:text-amber-300">
                {rescoreIneligibleCount} trip{rescoreIneligibleCount === 1 ? '' : 's'} will be skipped because retained route data is unavailable or the trip is summary-only.
              </div>
            )}
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setRescoreConfirmOpen(false)}
              disabled={rescoreBusy}
              className="rounded-xl border border-border px-4 py-2 text-sm font-semibold"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={rescoreTrips}
              disabled={rescoreBusy || rescoreCandidateCount === 0}
              className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {rescoreBusy ? 'Updating...' : `Update ${rescoreCandidateCount} trip${rescoreCandidateCount === 1 ? '' : 's'}`}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(privacyProtectionCheck)} onOpenChange={(open) => { if (!open) setPrivacyProtectionCheck(null); }}>
        <DialogContent className="grid max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden rounded-2xl p-4 sm:max-h-[88dvh] sm:w-full sm:p-6">
          <DialogHeader className="pr-8">
            <DialogTitle>
              Protection check: {privacyProtectionCheck?.type === 'corridor' ? 'route corridor' : 'privacy circle'}
            </DialogTitle>
            <DialogDescription>
              This authenticated check uses local geometry only. It verifies the circle radius or corridor side buffer, storage purge, outbound blocking, export masking, sensitivity, and duration before saving.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto pr-1">
            {privacyProtectionCheck && (
              <div className="space-y-3">
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                Sensitive location check. Android screenshots and screen sharing are temporarily blocked while this window is open, even if screenshots are allowed elsewhere.
              </div>
              <PrivacyZoneProtectionCheck
                type={privacyProtectionCheck.type}
                location={privacyProtectionCheck.location}
                waypoints={privacyProtectionCheck.waypoints}
                distanceM={Number(privacyProtectionCheck.radius_m) || PRIVACY_RADIUS_DEFAULT_M}
                sensitivity={privacyProtectionCheck.sensitivity}
                durationDays={privacyProtectionCheck.durationDays}
              />
              </div>
            )}
          </div>
          <DialogFooter className="border-t border-border pt-3">
            <button
              type="button"
              onClick={() => setPrivacyProtectionCheck(null)}
              className="rounded-xl border border-border px-4 py-2 text-sm font-semibold"
            >
              Go back
            </button>
            <button
              type="button"
              onClick={async () => {
                const check = privacyProtectionCheck;
                if (!check) return;
                const savedZone = check.type === 'corridor'
                  ? await savePrivacyZone(null, check.sourceLabel || 'Private route', check.radius_m)
                  : await savePrivacyZone(check.location, check.sourceLabel || 'Private place', check.radius_m);
                if (!savedZone) return;
                if (check.clearSuggestionOnSave) setSuggestedPrivacyLocation(null);
                setPrivacyProtectionCheck(null);
              }}
              className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              Save protection
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(privacyDeleteZone)} onOpenChange={(open) => {
        if (privacyDeleteBusy) return;
        if (!open) clearPrivacyZoneDeleteState();
      }}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Delete "{privacyDeleteZone?.label || 'privacy zone'}"?</DialogTitle>
            <DialogDescription>
              Choose what should happen to stored trips that passed through this private area.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-semibold">Option 1: Delete Zone Only</div>
                  <div className="mt-1">
                    This removes the privacy mask but keeps stored GPS inside this area. Older maps, playback, and exports may show this place again.
                    {privacyDeleteImpact.loading
                      ? ' Counting affected trips...'
                      : privacyDeleteImpact.tripCount != null
                        ? ` This affects ${privacyDeleteImpact.tripCount} recorded trip${privacyDeleteImpact.tripCount === 1 ? '' : 's'}.`
                        : ' Affected trip count is unavailable right now.'}
                  </div>
                </div>
              </div>
            </div>
            <label className="flex items-start gap-3 rounded-xl border border-border bg-secondary/30 p-3 text-sm">
              <OptimisticCheckbox
                checked={privacyDeletePurge}
                onCheckedChange={(checked) => setPrivacyDeletePurge(checked === true)}
                disabled={privacyDeleteBusy}
                className="mt-0.5"
                aria-label="Permanently delete raw GPS within this zone"
              />
              <span>
                <span className="font-semibold">Option 2: Erase Private GPS First</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Before deleting the zone, permanently remove stored route points and driving-event coordinates inside this radius. Trips keep privacy gap placeholders instead of the hidden location.
                </span>
              </span>
            </label>
            {privacyDeletePurge && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                Use this if you do not want old trips to reveal this place after the zone is removed. This cannot be undone, and affected trips will be marked for rescoring.
              </div>
            )}
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={clearPrivacyZoneDeleteState}
              disabled={privacyDeleteBusy}
              className="rounded-lg border border-border px-3 py-2 text-sm font-semibold disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDeletePrivacyZone}
              disabled={!privacyDeleteZone || privacyDeleteBusy}
              className={`rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
                privacyDeletePurge
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-amber-700 hover:bg-amber-800'
              }`}
            >
              {privacyDeleteBusy
                ? 'Deleting...'
                : privacyDeletePurge
                  ? 'Erase GPS & Delete Zone'
                  : 'Delete Zone Only'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={backupExportOpen} onOpenChange={(open) => {
        if (backupExportBusy) return;
        setBackupExportOpen(open);
        if (!open) {
          recordSystemEvent('backup_export_dialog_closed', {
            completed: false,
          }, { category: 'storage', title: 'Backup export dialog closed' });
          setBackupExportPassphrase('');
          setBackupExportConfirm('');
          setBackupExportPlaintext(false);
          setBackupExportPasswordVisible(false);
          setBackupExportConfirmVisible(false);
        }
      }}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Export Full Backup</DialogTitle>
            <DialogDescription>
              Protect this backup with a password before saving it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs leading-relaxed text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100">
              Backup timestamps near privacy zones may be slightly shifted to protect routines. Trip history inside Road Sage keeps the exact times.
            </div>
            <label className="block text-sm font-medium">
              Password
              <div className="relative mt-1">
                <input
                  type={backupExportPasswordVisible ? 'text' : 'password'}
                  value={backupExportPassphrase}
                  onChange={(event) => setBackupExportPassphrase(event.target.value)}
                  disabled={backupExportPlaintext || backupExportBusy}
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-border bg-card py-2 pl-3 pr-10 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setBackupExportPasswordVisible((visible) => !visible)}
                  disabled={backupExportPlaintext || backupExportBusy}
                  className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-secondary disabled:opacity-50"
                  aria-label={backupExportPasswordVisible ? 'Hide backup password' : 'Show backup password'}
                  title={backupExportPasswordVisible ? 'Hide backup password' : 'Show backup password'}
                >
                  {backupExportPasswordVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>
            <label className="block text-sm font-medium">
              Confirm password
              <div className="relative mt-1">
                <input
                  type={backupExportConfirmVisible ? 'text' : 'password'}
                  value={backupExportConfirm}
                  onChange={(event) => setBackupExportConfirm(event.target.value)}
                  disabled={backupExportPlaintext || backupExportBusy}
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-border bg-card py-2 pl-3 pr-10 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setBackupExportConfirmVisible((visible) => !visible)}
                  disabled={backupExportPlaintext || backupExportBusy}
                  className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-secondary disabled:opacity-50"
                  aria-label={backupExportConfirmVisible ? 'Hide confirm password' : 'Show confirm password'}
                  title={backupExportConfirmVisible ? 'Hide confirm password' : 'Show confirm password'}
                >
                  {backupExportConfirmVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>
            {!backupExportPlaintext && (
              <div className="rounded-xl border border-border bg-secondary/30 p-3 text-xs">
                {[
                  { ready: backupExportPassphraseChecks.minLength, label: `At least ${BACKUP_PASSPHRASE_MIN_LENGTH} characters` },
                  { ready: backupExportPassphraseChecks.capital, label: 'One capital letter' },
                  { ready: backupExportPassphraseChecks.special, label: 'One special character' },
                  { ready: backupExportPassphrase.length > 0 && backupExportPassphrase === backupExportConfirm, label: 'Passwords match' },
                ].map((item) => (
                  <div key={item.label} className={`flex items-center gap-2 py-0.5 font-medium ${item.ready ? 'text-green-600' : 'text-muted-foreground'}`}>
                    {item.ready ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                    <span>{item.label}</span>
                  </div>
                ))}
              </div>
            )}
            <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
              <OptimisticCheckbox
                checked={backupExportPlaintext}
                onCheckedChange={(checked) => {
                  const plaintext = checked === true;
                  setBackupExportPlaintext(plaintext);
                  recordSystemEvent(plaintext ? 'backup_plaintext_export_opt_in' : 'backup_plaintext_export_opt_out', {
                    output_format: plaintext ? 'json' : 'encrypted',
                  }, {
                    category: 'storage',
                    severity: plaintext ? 'warn' : 'info',
                    title: plaintext ? 'Readable backup option selected' : 'Encrypted backup option selected',
                  });
                }}
                disabled={backupExportBusy}
                className="mt-0.5"
              />
              <span>Export readable JSON instead. Anyone with the file can read trip and route data.</span>
            </label>
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
              {backupExportBusy ? 'Saving...' : backupExportPlaintext ? 'Save JSON' : 'Save Encrypted'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={backupImportOpen} onOpenChange={(open) => {
        if (backupImportBusy) return;
        setBackupImportOpen(open);
        if (!open) {
          recordSystemEvent('backup_import_unlock_dialog_closed', {
            completed: false,
            had_pending_file: Boolean(pendingBackupImportFile),
          }, { category: 'storage', title: 'Backup unlock dialog closed' });
          setPendingBackupImportFile(null);
          setBackupImportPassphrase('');
          setBackupImportError('');
          setBackupImportPasswordVisible(false);
        }
      }}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Unlock Backup</DialogTitle>
            <DialogDescription>
              Enter the password used when this backup was exported.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {backupImportError === BACKUP_WRONG_PASSWORD_CODE && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                Wrong password. Try again.
              </div>
            )}
            {backupImportError === BACKUP_PASSWORD_REQUIRED_CODE && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                This backup is encrypted.
              </div>
            )}
            <label className="block text-sm font-medium">
              Password
              <div className="relative mt-1">
                <input
                  type={backupImportPasswordVisible ? 'text' : 'password'}
                  value={backupImportPassphrase}
                  onChange={(event) => setBackupImportPassphrase(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleImportPassphraseSubmit();
                  }}
                  disabled={backupImportBusy}
                  autoComplete="current-password"
                  className="w-full rounded-lg border border-border bg-card py-2 pl-3 pr-10 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setBackupImportPasswordVisible((visible) => !visible)}
                  disabled={backupImportBusy}
                  className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-secondary disabled:opacity-50"
                  aria-label={backupImportPasswordVisible ? 'Hide backup password' : 'Show backup password'}
                  title={backupImportPasswordVisible ? 'Hide backup password' : 'Show backup password'}
                >
                  {backupImportPasswordVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
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
              onClick={handleImportPassphraseSubmit}
              disabled={backupImportPassphrase.length < BACKUP_PASSPHRASE_MIN_LENGTH || backupImportBusy}
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
            <OptimisticCheckbox
              checked={osrmConsentChecked}
              onCheckedChange={(checked) => setOsrmConsentChecked(checked === true)}
              className="mt-0.5"
            />
            <span>I understand and accept that sampled public GPS coordinate pairs, with privacy-zone interiors excluded, will be sent to this OSRM endpoint when I tap Get Road Data.</span>
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

      <LegalNoticeDialog
        open={legalNoticeOpen}
        onOpenChange={setLegalNoticeOpen}
        onAcknowledge={acknowledgeLegalNoticeReview}
        reviewMode
        actionLabel={legalNoticeNeedsReview ? 'Mark reviewed' : 'Close'}
      />

      {/* About */}
      <div className="bg-secondary/50 rounded-2xl p-4 text-xs text-muted-foreground space-y-1">
        <div className="font-semibold text-foreground text-sm">Road Sage</div>
        <div>Version 1.0.0 (Capacitor Android)</div>
        <div>Map: OpenStreetMap + Leaflet (free, open-source)</div>
        <div>Data: Stored locally by default - No ads - Background tracking and external road data are opt-in</div>
        <div>{LEGAL_DISCLAIMER_SHORT}</div>
      </div>
    </div>
  );
}
