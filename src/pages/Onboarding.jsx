import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, Bell, Car, Check, ChevronRight, CloudSun, Globe2, Layers, MapPin, Play, Route, Search, Shield } from 'lucide-react';
import { localSettings } from '@/lib/trackingStore';
import {
  getPermissionStatus,
  requestActivityRecognitionPermission,
  requestBackgroundLocationPermission,
  requestForegroundLocationPermission,
  requestNotificationPermission,
} from '@/lib/permissions';
import { getMotionSensorSupport, requestMotionSensorPermission } from '@/lib/sensorFusionModel';
import { isAndroid } from '@/lib/nativePlatform';
import { getAndroidBatteryOptimizationStatus, openAndroidBatteryOptimizationSettings, openAndroidUsageAccessSettings, startNativeAutoTracking } from '@/lib/activityRecognition';
import { useNavigate } from 'react-router-dom';
import { setJson } from '@/lib/mobileStorage';
import { ONBOARDING_COMPLETED_KEY } from '@/lib/appConstants';
import { logError } from '@/lib/errorReporting';
import { notifyUserError, notifyUserMessage, notifyUserSuccess } from '@/lib/userFeedback';

const STEPS = [
  {
    id: 'welcome',
    icon: Car,
    title: 'Welcome to Road Sage',
    subtitle: 'Your intelligent driving companion',
    description: 'Road Sage tracks your driving trips, analyzes your habits, and helps you become a safer, more efficient driver. All data stays on your device.',
    color: 'gradient-primary',
    textColor: 'text-white',
  },
  {
    id: 'location',
    icon: MapPin,
    title: 'Location Access',
    subtitle: 'Required for trip tracking',
    description: 'Road Sage needs your GPS location to track routes, calculate speed, and detect driving events. Location is only used when you are actively tracking a trip.',
    color: 'gradient-success',
    textColor: 'text-white',
    permissionType: 'location',
  },
  {
    id: 'data_leaving',
    icon: Shield,
    title: 'Data Leaving App',
    subtitle: 'Your choice',
    description: 'Choose which optional external context Road Sage may request. Everything here starts off.',
    color: 'bg-gradient-to-br from-emerald-500 to-cyan-700',
    textColor: 'text-white',
  },
  {
    id: 'activity',
    icon: Activity,
    title: 'Motion & Activity',
    subtitle: 'For smarter trip detection',
    description: 'Road Sage can use motion sensors and Android activity to confirm harsh events, improve auto tracking, and support possible incident detection.',
    color: 'bg-gradient-to-br from-purple-500 to-purple-700',
    textColor: 'text-white',
  },
  {
    id: 'notifications',
    icon: Bell,
    title: 'Notifications',
    subtitle: 'Optional but recommended',
    description: 'Get notified when a trip starts or ends, receive your weekly driving report, and get reminders to stay safe on long drives. You can turn these off at any time.',
    color: 'bg-gradient-to-br from-orange-400 to-orange-600',
    textColor: 'text-white',
  },
  {
    id: 'tracking_mode',
    icon: Shield,
    title: 'Tracking Mode',
    subtitle: 'You are in control',
    description: 'Choose how Road Sage detects your trips. You can change this at any time in Settings.',
    color: 'bg-gradient-to-br from-slate-700 to-slate-900',
    textColor: 'text-white',
    isChoice: true,
  },
];

const TRACKING_OPTIONS = [
  {
    id: 'manual',
    title: 'Manual Only',
    description: 'Tap "Start Trip" to begin tracking. No background activity.',
    icon: Play,
    recommended: false,
  },
  {
    id: 'auto_detect',
    title: 'Auto-Detect',
    description: 'App detects when you start driving while open in foreground.',
    icon: Search,
    recommended: true,
  },
  {
    id: 'background_auto',
    title: 'Background Auto',
    description: 'Tracks trips automatically, even when app is closed. Uses more battery.',
    icon: Globe2,
    recommended: false,
    warning: 'Uses more battery. Requires background location permission.',
  },
];

const DATA_LEAVING_OPTIONS = [
  {
    id: 'maps',
    title: 'Maps',
    icon: Layers,
    leaves: 'Visible map tile areas and network metadata.',
    receiver: 'OpenStreetMap tile hosts.',
  },
  {
    id: 'road_weather',
    title: 'Road/weather context',
    icon: CloudSun,
    leaves: 'Route-area boxes for road data and one privacy-guarded point/date for weather.',
    receiver: 'OpenStreetMap Overpass and Open-Meteo.',
  },
  {
    id: 'route_snapping',
    title: 'Route snapping',
    icon: Route,
    leaves: 'Sampled GPS coordinate pairs from selected trips after endpoint setup.',
    receiver: 'Your verified OSRM endpoint.',
  },
];

const SETUP_REQUEST_TIMEOUT_MS = 25_000;
const SETUP_PROMPT_SETTLE_MS = 650;
const ONBOARDING_DRAFT_KEY = 'road_sage_onboarding_draft_v1';

function readOnboardingDraft() {
  for (const storage of [sessionStorage, localStorage]) {
    try {
      const draft = JSON.parse(storage.getItem(ONBOARDING_DRAFT_KEY) || 'null');
      if (draft && typeof draft === 'object') return draft;
    } catch {
      // Try the other storage.
    }
  }
  return null;
}

function writeOnboardingDraft(draft) {
  const serialized = JSON.stringify(draft);
  for (const storage of [sessionStorage, localStorage]) {
    try {
      storage.setItem(ONBOARDING_DRAFT_KEY, serialized);
    } catch {
      // The other storage may still be available.
    }
  }
}

function clearOnboardingDraft() {
  for (const storage of [sessionStorage, localStorage]) {
    try {
      storage.removeItem(ONBOARDING_DRAFT_KEY);
    } catch {
      // Best-effort cleanup.
    }
  }
}

function setupTimeoutError(label) {
  const error = new Error(`${label} did not finish. You can retry the row or continue and finish it later in Settings.`);
  error.code = 'setup_timeout';
  return error;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function withSetupTimeout(taskFactory, label, timeoutMs = SETUP_REQUEST_TIMEOUT_MS) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(setupTimeoutError(label)), timeoutMs);
  });

  return Promise.race([taskFactory(), timeout]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId);
  });
}

function permissionRequestGranted(result) {
  return result === true || result?.granted === true;
}

function SetupChecklistRow({ label, detail, ready, onAction, actionLabel = 'Set up', disabled = false }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>
      </div>
      {ready ? (
        <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
          <Check className="h-3 w-3" />
          Ready
        </span>
      ) : (
        <button
          type="button"
          onClick={onAction}
          disabled={disabled}
          className="flex-shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export default function Onboarding({ onComplete }) {
  const [step, setStep] = useState(0);
  const [trackingMode, setTrackingMode] = useState(isAndroid() ? 'background_auto' : 'auto_detect');
  const [locationGranted, setLocationGranted] = useState(false);
  const [motionGranted, setMotionGranted] = useState(getMotionSensorSupport().status === 'granted');
  const [activityGranted, setActivityGranted] = useState(false);
  const [notificationsGranted, setNotificationsGranted] = useState(false);
  const [backgroundGranted, setBackgroundGranted] = useState(false);
  const [batteryReady, setBatteryReady] = useState(!isAndroid());
  const [usageAccessGranted, setUsageAccessGranted] = useState(false);
  const [dataLeavingChoices, setDataLeavingChoices] = useState({
    maps: false,
    road_weather: false,
    route_snapping: false,
  });
  const [roadDataAutoFetch, setRoadDataAutoFetch] = useState(() => localSettings.get().external_context_auto_fetch_enabled === true);
  const [requesting, setRequesting] = useState(false);
  const [completionPending, setCompletionPending] = useState(false);
  const [setupStatus, setSetupStatus] = useState('');
  const mountedRef = useRef(false);
  const permissionRequestInFlightRef = useRef(false);
  const navigate = useNavigate();

  const currentStep = STEPS[step];
  const isLast = step === STEPS.length - 1;

  const refreshSetupStatus = async () => {
    const status = await getPermissionStatus(null, { force: true });
    const battery = isAndroid() ? await getAndroidBatteryOptimizationStatus().catch(() => null) : null;
    setLocationGranted(status.foregroundLocation === 'granted');
    setNotificationsGranted(status.notifications === 'granted');
    setMotionGranted(status.motionSensors === 'granted');
    setActivityGranted(!isAndroid() || status.activityRecognition === 'granted');
    setBackgroundGranted(!isAndroid() || status.backgroundLocation === 'granted');
    setBatteryReady(!isAndroid() || battery?.batteryOptimizationIgnored === true);
    setUsageAccessGranted(!isAndroid() || status.phoneUsageAccess === 'granted');
    return status;
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const finishRequesting = () => {
    if (mountedRef.current) setRequesting(false);
  };

  const runPermissionRequest = async (label, requestFn, {
    busyMessage = `Opening ${label.toLowerCase()} prompt...`,
    timeoutMessage = `${label} is taking longer than Android normally allows. Wait for any visible system dialog to finish, then retry this row.`,
  } = {}) => {
    if (permissionRequestInFlightRef.current) {
      const error = new Error('Another Android permission prompt is already in progress.');
      error.code = 'permission_request_busy';
      throw error;
    }

    permissionRequestInFlightRef.current = true;
    if (mountedRef.current) setSetupStatus(busyMessage);
    try {
      const result = await withSetupTimeout(requestFn, label);
      await delay(SETUP_PROMPT_SETTLE_MS);
      return result;
    } catch (error) {
      if (error?.code === 'setup_timeout' && mountedRef.current) {
        setSetupStatus(timeoutMessage);
      }
      throw error;
    } finally {
      permissionRequestInFlightRef.current = false;
    }
  };

  const persistOnboardingComplete = async () => {
    await localSettings.setAsync({
      ...localSettings.get(),
      onboarding_completed: true,
      tracking_mode: trackingMode,
      auto_tracking_enabled: trackingMode !== 'manual',
      background_tracking_enabled: trackingMode === 'background_auto',
      map_tiles_enabled: dataLeavingChoices.maps === true,
      map_tiles_first_prompt_seen: true,
      speed_limit_lookup_enabled: dataLeavingChoices.road_weather === true,
      weather_context_enabled: dataLeavingChoices.road_weather === true,
      external_context_auto_fetch_enabled: roadDataAutoFetch === true && dataLeavingChoices.road_weather === true,
      map_matching_enabled: dataLeavingChoices.route_snapping === true,
    });

    const serializedMarker = JSON.stringify(true);
    try {
      localStorage.setItem(ONBOARDING_COMPLETED_KEY, serializedMarker);
    } catch (error) {
      logError('onboarding_completion_local_marker_save', error);
    }

    let markerSaveError = null;
    try {
      await setJson(ONBOARDING_COMPLETED_KEY, true);
    } catch (error) {
      markerSaveError = error;
      logError('onboarding_completion_marker_save', error);
    }

    try {
      const encryptedPlugin = globalThis.Capacitor?.Plugins?.EncryptedCapacitorPlugin;
      if (encryptedPlugin?.set) {
        await encryptedPlugin.set({ key: ONBOARDING_COMPLETED_KEY, value: serializedMarker });
      }
    } catch (error) {
      logError('onboarding_completion_native_marker_save', error);
    }

    if (markerSaveError) throw markerSaveError;
  };

  const handleLocationRequest = async () => {
    setRequesting(true);
    try {
      const granted = await runPermissionRequest('Location permission', requestForegroundLocationPermission);
      setLocationGranted(granted);
      if (granted) localSettings.update({ location_permission_granted: true });
      await refreshSetupStatus().catch((err) => {
        notifyUserError('onboarding_refresh_after_location_permission', err, {
          title: 'Setup status not refreshed',
          description: 'Location permission was handled, but Road Sage could not refresh the setup checklist yet.',
        });
      });
      (granted ? notifyUserSuccess : notifyUserMessage)('onboarding_location_permission', {
        title: granted ? 'Location access ready' : 'Location still off',
        description: granted
          ? 'Road Sage can now record route, speed, and distance data.'
          : 'Location permission was not granted. You can enable it from device settings.',
      });
    } catch (error) {
      setSetupStatus('Location setup did not finish. Retry location or continue and finish it later in Settings.');
      notifyUserError('onboarding_location_permission', error, {
        title: 'Location setup failed',
        description: 'Road Sage could not request location permission. Open device settings and try again.',
      });
    } finally {
      finishRequesting();
    }
  };

  const handleMotionActivityRequest = async () => {
    setRequesting(true);
    try {
      const motionOk = await runPermissionRequest('Motion sensor permission', requestMotionSensorPermission);
      const activityOk = isAndroid()
        ? await runPermissionRequest('Physical Activity permission', requestActivityRecognitionPermission)
        : true;
      setMotionGranted(motionOk);
      setActivityGranted(activityOk);
      if (activityOk) localSettings.update({ activity_permission_granted: true });
      await refreshSetupStatus().catch((err) => {
        notifyUserError('onboarding_refresh_after_motion_activity_permission', err, {
          title: 'Setup status not refreshed',
          description: 'Motion setup was handled, but Road Sage could not refresh the setup checklist yet.',
        });
      });
      (motionOk && activityOk ? notifyUserSuccess : notifyUserMessage)('onboarding_motion_activity_permission', {
        title: motionOk && activityOk ? 'Motion access ready' : 'Motion setup incomplete',
        description: motionOk && activityOk
          ? 'Motion and activity signals can now improve trip detection.'
          : 'Some motion or activity permission is still off. You can retry from the checklist.',
      });
    } catch (error) {
      setSetupStatus('Motion setup did not finish. Retry motion/activity or continue and finish it later in Settings.');
      notifyUserError('onboarding_motion_activity_permission', error, {
        title: 'Motion setup failed',
        description: 'Road Sage could not request motion or activity permission.',
      });
    } finally {
      finishRequesting();
    }
  };

  const handleNotificationRequest = async () => {
    setRequesting(true);
    try {
      const granted = await runPermissionRequest('Notification permission', requestNotificationPermission);
      setNotificationsGranted(granted);
      if (granted) localSettings.update({ notification_permission_granted: true });
      await refreshSetupStatus().catch((err) => {
        notifyUserError('onboarding_refresh_after_notification_permission', err, {
          title: 'Setup status not refreshed',
          description: 'Notification setup was handled, but Road Sage could not refresh the setup checklist yet.',
        });
      });
      (granted ? notifyUserSuccess : notifyUserMessage)('onboarding_notification_permission', {
        title: granted ? 'Notifications enabled' : 'Notifications still off',
        description: granted
          ? 'Trip, safety, and reminder notifications can now be shown.'
          : 'Notification permission was not granted. You can enable it later from device settings.',
      });
    } catch (error) {
      setSetupStatus('Notification setup did not finish. Retry notifications or continue and finish it later in Settings.');
      notifyUserError('onboarding_notification_permission', error, {
        title: 'Notification setup failed',
        description: 'Road Sage could not request notification permission.',
      });
    } finally {
      finishRequesting();
    }
  };

  const handleBackgroundLocationRequest = async () => {
    setRequesting(true);
    try {
      const status = await refreshSetupStatus().catch(() => null);
      if (isAndroid() && status?.foregroundLocation !== 'granted') {
        setSetupStatus('Grant foreground location first, then retry background location.');
        notifyUserMessage('onboarding_background_location_requires_location', {
          title: 'Location needed first',
          description: 'Android requires foreground location before background location can be enabled.',
        });
        return;
      }
      if (isAndroid() && status?.notifications !== 'granted') {
        setSetupStatus('Enable notifications first, then retry background location.');
        notifyUserMessage('onboarding_background_location_requires_notifications', {
          title: 'Notifications needed first',
          description: 'Android requires a persistent notification for background tracking.',
        });
        return;
      }

      const result = await runPermissionRequest('Background location permission', requestBackgroundLocationPermission, {
        busyMessage: 'Opening background location setup...',
        timeoutMessage: 'Background location setup is still in Android. Return here after updating Location to "Allow all the time".',
      });
      const granted = permissionRequestGranted(result);
      setBackgroundGranted(granted);
      await refreshSetupStatus().catch((err) => {
        notifyUserError('onboarding_refresh_after_background_location_permission', err, {
          title: 'Setup status not refreshed',
          description: 'Background location setup was handled, but Road Sage could not refresh the setup checklist yet.',
        });
      });
      if (result?.reason === 'partial_grant') {
        setSetupStatus('Tap Enable again and choose "Allow all the time" to enable background tracking.');
      } else if (result?.reason === 'denied') {
        setSetupStatus('Background location was not granted. Retry this row to finish background tracking setup.');
      }
      (granted ? notifyUserSuccess : notifyUserMessage)('onboarding_background_location_permission', {
        title: granted ? 'Background tracking ready' : 'Background tracking still off',
        description: granted
          ? 'Road Sage can now support background trip capture.'
          : 'Background location was not granted. Auto tracking may need manual starts.',
      });
    } catch (error) {
      setSetupStatus('Background location setup did not finish. Retry the row or finish it later in Settings.');
      notifyUserError('onboarding_background_location_permission', error, {
        title: 'Background tracking setup failed',
        description: 'Road Sage could not request background location permission.',
      });
    } finally {
      finishRequesting();
    }
  };

  const handleBatterySetup = async () => {
    setRequesting(true);
    try {
      await runPermissionRequest('Battery optimization settings', openAndroidBatteryOptimizationSettings, {
        busyMessage: 'Opening battery settings...',
        timeoutMessage: 'Battery settings are still opening. Return here after allowing unrestricted background activity.',
      });
      await refreshSetupStatus().catch((err) => {
        notifyUserError('onboarding_refresh_after_battery_settings', err, {
          title: 'Setup status not refreshed',
          description: 'Battery settings opened, but Road Sage could not refresh the setup checklist yet.',
        });
      });
      notifyUserSuccess('onboarding_battery_settings', {
        title: 'Battery settings opened',
        description: 'Return to Road Sage after allowing unrestricted background activity.',
      });
    } catch (error) {
      notifyUserError('onboarding_battery_settings', error, {
        title: 'Battery settings not opened',
        description: 'Road Sage could not open Android battery optimization settings.',
      });
    } finally {
      finishRequesting();
    }
  };

  const handleUsageAccessSetup = async () => {
    setRequesting(true);
    try {
      await runPermissionRequest('Phone Usage Access settings', openAndroidUsageAccessSettings, {
        busyMessage: 'Opening Phone Usage Access settings...',
        timeoutMessage: 'Phone Usage Access settings are still opening. Return here after allowing Road Sage.',
      });
      await refreshSetupStatus().catch((err) => {
        notifyUserError('onboarding_refresh_after_usage_access_settings', err, {
          title: 'Setup status not refreshed',
          description: 'Usage access settings opened, but Road Sage could not refresh the setup checklist yet.',
        });
      });
      notifyUserSuccess('onboarding_usage_access_settings', {
        title: 'Usage access settings opened',
        description: 'Return to Road Sage after allowing phone-use evidence access.',
      });
    } catch (error) {
      notifyUserError('onboarding_usage_access_settings', error, {
        title: 'Usage access settings not opened',
        description: 'Road Sage could not open Android usage access settings. You can finish this later in Settings.',
      });
    } finally {
      finishRequesting();
    }
  };

  const enableRoadDataAutoFetch = () => {
    localSettings.update({
      external_context_auto_fetch_enabled: true,
      speed_limit_lookup_enabled: true,
      weather_context_enabled: true,
    });
    setRoadDataAutoFetch(true);
    notifyUserSuccess('onboarding_road_data_auto_fetch', {
      title: 'Road data enabled',
      description: 'New trips can fetch OpenStreetMap speed-limit context and Open-Meteo weather automatically.',
    });
  };

  const requestTrackingModePermissions = async (mode = trackingMode) => {
    const results = {};
    const recommendedItems = [
      {
        key: 'location',
        statusKey: 'foregroundLocation',
        label: 'Location permission',
        request: requestForegroundLocationPermission,
        required: true,
      },
      {
        key: 'notifications',
        statusKey: 'notifications',
        label: 'Notification permission',
        request: requestNotificationPermission,
        required: true,
      },
      {
        key: 'motion',
        statusKey: 'motionSensors',
        label: 'Motion sensor permission',
        request: requestMotionSensorPermission,
        optional: true,
        required: true,
      },
      {
        key: 'activity',
        statusKey: 'activityRecognition',
        label: 'Physical Activity permission',
        request: requestActivityRecognitionPermission,
        required: isAndroid(),
      },
      {
        key: 'backgroundLocation',
        statusKey: 'backgroundLocation',
        label: 'Background location permission',
        request: requestBackgroundLocationPermission,
        required: mode === 'background_auto',
      },
    ].filter((item) => item.required);

    for (const item of recommendedItems) {
      const status = await refreshSetupStatus().catch(() => null);
      if (status?.[item.statusKey] === 'granted') {
        results[item.key] = true;
        continue;
      }

      if (item.key === 'backgroundLocation' && isAndroid()) {
        if (status?.foregroundLocation !== 'granted') {
          results.backgroundLocation = false;
          setSetupStatus('Background location waits until foreground location is granted.');
          break;
        }
        if (status?.notifications !== 'granted') {
          results.backgroundLocation = false;
          setSetupStatus('Background location waits until notifications are enabled.');
          break;
        }
      }

      setSetupStatus(`Step ${Object.keys(results).length + 1} of ${recommendedItems.length}: ${item.label}`);
      const result = await runPermissionRequest(item.label, item.request);
      results[item.key] = permissionRequestGranted(result);
      if (item.key === 'backgroundLocation' && result?.reason === 'partial_grant') {
        setSetupStatus('Tap background location again and choose "Allow all the time" to enable background tracking.');
      }
      if (!results[item.key] && !item.optional) break;
    }

    await refreshSetupStatus().catch(() => null);
    return results;
  };

  const handleRecommendedSetup = async ({ autoOpenUsageAccess = false } = {}) => {
    setRequesting(true);
    setSetupStatus('Requesting location, notifications, motion, activity, and background tracking permissions...');
    try {
      const recommendedMode = isAndroid() ? 'background_auto' : 'auto_detect';
      setTrackingMode(recommendedMode);
      await requestTrackingModePermissions(recommendedMode);
      await refreshSetupStatus().catch((err) => {
        notifyUserError('onboarding_refresh_after_recommended_setup', err, {
          title: 'Setup status not refreshed',
          description: 'Core prompts completed, but Road Sage could not refresh the setup checklist yet.',
          extra: { mode: recommendedMode },
        });
      });
      setSetupStatus(isAndroid()
        ? 'Core prompts complete. Finish any Android settings rows that still show setup.'
        : 'Core prompts complete.');
      const latest = await refreshSetupStatus().catch(() => null);
      if (recommendedMode === 'background_auto' && latest?.backgroundLocation === 'granted') {
        await startNativeAutoTracking().catch((err) => {
          logError('native_auto_tracking_start_onboarding', err, { mode: recommendedMode });
        });
      }
      notifyUserSuccess('onboarding_recommended_setup', {
        title: 'Recommended setup checked',
        description: isAndroid()
          ? 'Road Sage asked for one Android permission at a time. Finish any remaining rows from the checklist.'
          : 'Core permissions are ready for trip tracking.',
      });
      if (autoOpenUsageAccess && isAndroid()) {
        setSetupStatus('Phone Usage Access stays manual so Android does not open another settings screen automatically.');
      }
    } catch (error) {
      setSetupStatus('Recommended setup could not finish. Use the checklist rows below to finish setup.');
      notifyUserError('onboarding_recommended_setup', error, {
        title: 'Recommended setup failed',
        description: 'Road Sage could not complete the recommended permission setup. Use the checklist rows below to retry each item.',
      });
    } finally {
      finishRequesting();
    }
  };

  useEffect(() => {
    refreshSetupStatus().catch((err) => {
      logError('onboarding_initial_status_refresh', err);
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshSetupStatus().catch((err) => {
        logError('onboarding_visible_status_refresh', err);
      });
    };
    const onFocus = () => refreshSetupStatus().catch((err) => {
      logError('onboarding_focus_status_refresh', err);
    });
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    try {
      const draft = readOnboardingDraft();
      if (!draft || typeof draft !== 'object') return;
      if (TRACKING_OPTIONS.some((option) => option.id === draft.trackingMode)) {
        setTrackingMode(draft.trackingMode);
      }
      if (draft.dataLeavingChoices && typeof draft.dataLeavingChoices === 'object') {
        setDataLeavingChoices((current) => ({
          ...current,
          maps: draft.dataLeavingChoices.maps === true,
          road_weather: draft.dataLeavingChoices.road_weather === true,
          route_snapping: draft.dataLeavingChoices.route_snapping === true,
        }));
      }
      const nextStep = Number(draft.step);
      if (Number.isInteger(nextStep)) setStep(Math.min(Math.max(0, nextStep), STEPS.length - 1));
    } catch {
      // Draft recovery is best-effort.
    }
  }, []);

  useEffect(() => {
    try {
      writeOnboardingDraft({
        trackingMode,
        dataLeavingChoices,
        step,
      });
    } catch {
      // Draft persistence is best-effort.
    }
  }, [trackingMode, dataLeavingChoices, step]);

  const handleNext = async () => {
    if (requesting) return;

    if (isLast) {
      setRequesting(true);
      setCompletionPending(true);
      setSetupStatus('Finalizing setup...');
      try {
        const latest = await refreshSetupStatus().catch(() => null);
        let persistFailed = false;
        try {
          await persistOnboardingComplete();
          clearOnboardingDraft();
        } catch (error) {
          persistFailed = true;
          logError('onboarding_complete_persist', error);
          notifyUserError('onboarding_complete_persist', error, {
            title: 'Setup saved with a warning',
            description: 'Road Sage could not confirm every startup marker. You can keep using the app, and setup will be checked again on next launch.',
          });
        }
        if (trackingMode === 'background_auto' && latest?.backgroundLocation === 'granted') {
          await startNativeAutoTracking().catch((err) => {
            logError('native_auto_tracking_start_onboarding_complete', err, { mode: trackingMode });
          });
        }
        notifyUserSuccess('onboarding_complete', {
          title: 'Road Sage is ready',
          description: persistFailed
            ? 'Setup can continue now. Road Sage logged a startup marker warning for the next launch.'
            : trackingMode === 'background_auto' && latest?.backgroundLocation !== 'granted'
            ? 'Your preferences were saved. Finish background location from Settings when you are ready.'
            : 'Your tracking preferences were saved.',
        });
        onComplete?.();
        navigate('/');
      } catch (error) {
        notifyUserError('onboarding_complete_save', error, {
          title: 'Could not save setup',
          description: 'Road Sage could not save onboarding completion. Please try Get Started again.',
        });
      } finally {
        if (mountedRef.current) setCompletionPending(false);
        finishRequesting();
      }
      return;
    }

    // Request location permission when on location step
    if (currentStep.id === 'location' && !locationGranted) {
      await handleLocationRequest();
    }

    setStep(s => s + 1);
  };

  const handleSkip = () => {
    if (requesting) return;
    setStep(s => s + 1);
  };

  const Icon = currentStep.icon;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      {/* Progress dots */}
      <div className="flex gap-2 mb-8">
        {STEPS.map((_, i) => (
          <div
            key={i}
            className={`h-1.5 rounded-full transition-all duration-300 ${
              i === step ? 'w-8 bg-primary' : i < step ? 'w-3 bg-primary/50' : 'w-3 bg-border'
            }`}
          />
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -30 }}
          transition={{ duration: 0.25 }}
          className="w-full max-w-sm"
        >
          {/* Icon card */}
          <div className={`w-24 h-24 rounded-3xl ${currentStep.color} flex items-center justify-center mx-auto mb-8 shadow-2xl`}>
            <Icon className={`w-12 h-12 ${currentStep.textColor}`} />
          </div>

          {/* Text */}
          <div className="text-center mb-8">
            <div className="text-xs text-primary font-semibold uppercase tracking-widest mb-2">
              {currentStep.subtitle}
            </div>
            <h1 className="text-3xl font-grotesk font-bold mb-4 leading-tight">
              {currentStep.title}
            </h1>
            <p className="text-muted-foreground leading-relaxed">
              {currentStep.description}
            </p>
          </div>

          {/* Location permission status */}
          {currentStep.id === 'location' && (
            <div className="mb-6">
              {locationGranted ? (
                <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-950/30 rounded-xl text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800/50">
                  <Check className="w-4 h-4" />
                  <span className="text-sm font-medium">Location access granted</span>
                </div>
              ) : (
                <button
                  onClick={handleLocationRequest}
                  disabled={requesting}
                  className="w-full p-3 bg-primary/10 hover:bg-primary/20 text-primary rounded-xl text-sm font-medium transition-colors border border-primary/20"
                >
                  {requesting ? 'Requesting...' : 'Grant Location Access'}
                </button>
              )}
            </div>
          )}

          {currentStep.id === 'activity' && (
            <div className="mb-6 space-y-2">
              {motionGranted && (!isAndroid() || activityGranted) ? (
                <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-950/30 rounded-xl text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800/50">
                  <Check className="w-4 h-4" />
                  <span className="text-sm font-medium">Motion and activity access ready</span>
                </div>
              ) : (
                <button
                  onClick={handleMotionActivityRequest}
                  disabled={requesting}
                  className="w-full p-3 bg-primary/10 hover:bg-primary/20 text-primary rounded-xl text-sm font-medium transition-colors border border-primary/20"
                >
                  {requesting ? 'Requesting...' : isAndroid() ? 'Enable Motion & Activity' : 'Enable Motion Sensors'}
                </button>
              )}
              <p className="text-xs text-muted-foreground text-center">
                Android may not show a separate motion prompt, but Physical Activity is requested for auto tracking.
              </p>
            </div>
          )}

          {currentStep.id === 'notifications' && (
            <div className="mb-6">
              {notificationsGranted ? (
                <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-950/30 rounded-xl text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800/50">
                  <Check className="w-4 h-4" />
                  <span className="text-sm font-medium">Notifications enabled</span>
                </div>
              ) : (
                <button
                  onClick={handleNotificationRequest}
                  disabled={requesting}
                  className="w-full p-3 bg-primary/10 hover:bg-primary/20 text-primary rounded-xl text-sm font-medium transition-colors border border-primary/20"
                >
                  {requesting ? 'Requesting...' : 'Enable Notifications'}
                </button>
              )}
            </div>
          )}

          {/* Tracking mode choices */}
          {currentStep.isChoice && (
            <div className="space-y-3 mb-6">
              <button
                type="button"
                onClick={() => handleRecommendedSetup()}
                disabled={requesting}
                className="w-full rounded-2xl border border-primary/30 bg-primary/10 p-3 text-left text-sm font-semibold text-primary disabled:opacity-50"
              >
                {requesting ? 'Requesting permissions...' : 'Enable all recommended permissions'}
                {setupStatus && <span className="mt-1 block text-xs font-normal text-muted-foreground">{setupStatus}</span>}
              </button>
              {isAndroid() && (
                <button
                  type="button"
                  onClick={handleUsageAccessSetup}
                  disabled={requesting}
                  className="w-full rounded-2xl border border-border bg-card p-3 text-left text-sm font-semibold text-foreground disabled:opacity-50"
                >
                  Open Phone Usage Access
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">Needed only for real Android app-use detection while driving.</span>
                </button>
              )}
              {TRACKING_OPTIONS.map(opt => (
                (() => {
                  const OptionIcon = opt.icon;
                  return (
                <button
                  key={opt.id}
                  onClick={() => setTrackingMode(opt.id)}
                  className={`w-full p-4 rounded-2xl border-2 text-left transition-all ${
                    trackingMode === opt.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-card hover:border-border/80'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-secondary">
                      <OptionIcon className="h-4 w-4 text-primary" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-sm">{opt.title}</span>
                        {opt.recommended && (
                          <span className="max-w-full whitespace-normal rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium leading-tight text-primary">
                            Recommended
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
                      {opt.warning && (
                        <div className="flex items-center gap-1 mt-1 text-xs text-orange-500">
                          {opt.warning}
                        </div>
                      )}
                    </div>
                    {trackingMode === opt.id && (
                      <Check className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                    )}
                  </div>
                </button>
                  );
                })()
              ))}
              <div className="space-y-2 rounded-2xl bg-secondary/40 p-3">
                <div className="text-xs font-bold uppercase tracking-normal text-muted-foreground">Setup checklist</div>
                <SetupChecklistRow
                  label="Location"
                  detail="Required for routes, speed, distance, and parking."
                  ready={locationGranted}
                  onAction={handleLocationRequest}
                  disabled={requesting}
                />
                <SetupChecklistRow
                  label="Motion and activity"
                  detail={isAndroid() ? 'Confirms driving and powers Android auto detection.' : 'Improves movement and incident detection where available.'}
                  ready={motionGranted && activityGranted}
                  onAction={handleMotionActivityRequest}
                  disabled={requesting}
                />
                <SetupChecklistRow
                  label="Notifications"
                  detail="Shows trip, safety, reminder, and report updates."
                  ready={notificationsGranted}
                  onAction={handleNotificationRequest}
                  disabled={requesting}
                />
                {isAndroid() && trackingMode === 'background_auto' && (
                  <>
                    <SetupChecklistRow
                      label="Background location"
                      detail="Needed for automatic trip capture while the app sleeps."
                      ready={backgroundGranted}
                      onAction={handleBackgroundLocationRequest}
                      disabled={requesting}
                    />
                    <SetupChecklistRow
                      label="Battery unrestricted"
                      detail="Helps Android keep background auto tracking alive."
                      ready={batteryReady}
                      onAction={handleBatterySetup}
                      actionLabel="Open"
                      disabled={requesting}
                    />
                  </>
                )}
                {isAndroid() && (
                  <SetupChecklistRow
                    label="Phone Usage Access"
                    detail="Optional, but makes phone-use detection measured instead of inferred."
                    ready={usageAccessGranted}
                    onAction={handleUsageAccessSetup}
                    actionLabel="Open"
                    disabled={requesting}
                  />
                )}
                <SetupChecklistRow
                  label="Automatic road data"
                  detail="Optional. Sends route-area boxes to OpenStreetMap and a privacy-guarded route point/date to Open-Meteo for new trips."
                  ready={roadDataAutoFetch}
                  onAction={enableRoadDataAutoFetch}
                  actionLabel="Enable"
                  disabled={requesting}
                />
              </div>
            </div>
          )}

          {currentStep.id === 'data_leaving' && (
            <div className="mb-6 space-y-3">
              {DATA_LEAVING_OPTIONS.map((option) => {
                const OptionIcon = option.icon;
                const enabled = dataLeavingChoices[option.id] === true;
                return (
                  <button
                    type="button"
                    key={option.id}
                    onClick={() => setDataLeavingChoices((choices) => ({ ...choices, [option.id]: !enabled }))}
                    className={`w-full rounded-2xl border-2 p-4 text-left transition-all ${
                      enabled ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-border/80'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-secondary">
                        <OptionIcon className="h-4 w-4 text-primary" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold">{option.title}</span>
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${enabled ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
                            {enabled ? 'On' : 'Off'}
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Leaves: {option.leaves}</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Receives: {option.receiver}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Actions */}
      <div className="w-full max-w-sm mt-4 flex flex-col gap-3">
        <button
          onClick={handleNext}
          disabled={requesting}
          className="w-full py-4 bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold rounded-2xl shadow-lg hover:opacity-90 transition-opacity disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {completionPending ? 'Setting up...' : requesting ? 'Finishing...' : isLast ? 'Get Started' : 'Continue'}
          <ChevronRight className="w-4 h-4" />
        </button>

        {!isLast && step > 0 && (
          <button
            onClick={handleSkip}
            disabled={requesting}
            className="w-full py-3 text-muted-foreground text-sm hover:text-foreground transition-colors"
          >
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
}
