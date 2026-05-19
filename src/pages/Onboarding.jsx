import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, Bell, Car, Check, ChevronRight, Globe2, MapPin, Play, Search, Shield } from 'lucide-react';
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
import { openAndroidUsageAccessSettings, startNativeAutoTracking } from '@/lib/activityRecognition';
import { useNavigate } from 'react-router-dom';

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
  const [usageAccessGranted, setUsageAccessGranted] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [setupStatus, setSetupStatus] = useState('');
  const navigate = useNavigate();

  const currentStep = STEPS[step];
  const isLast = step === STEPS.length - 1;

  const refreshSetupStatus = async () => {
    const status = await getPermissionStatus();
    setLocationGranted(status.foregroundLocation === 'granted');
    setNotificationsGranted(status.notifications === 'granted');
    setMotionGranted(status.motionSensors === 'granted');
    setActivityGranted(!isAndroid() || status.activityRecognition === 'granted');
    setBackgroundGranted(!isAndroid() || status.backgroundLocation === 'granted');
    setUsageAccessGranted(!isAndroid() || status.phoneUsageAccess === 'granted');
    return status;
  };

  const handleLocationRequest = async () => {
    setRequesting(true);
    const granted = await requestForegroundLocationPermission();
    setLocationGranted(granted);
    localSettings.update({ location_permission_granted: granted });
    await refreshSetupStatus().catch(() => {});
    setRequesting(false);
  };

  const handleMotionActivityRequest = async () => {
    setRequesting(true);
    const motionOk = await requestMotionSensorPermission();
    const activityOk = isAndroid() ? await requestActivityRecognitionPermission() : true;
    setMotionGranted(motionOk);
    setActivityGranted(activityOk);
    localSettings.update({ activity_permission_granted: activityOk });
    await refreshSetupStatus().catch(() => {});
    setRequesting(false);
  };

  const handleNotificationRequest = async () => {
    setRequesting(true);
    const granted = await requestNotificationPermission();
    setNotificationsGranted(granted);
    localSettings.update({ notification_permission_granted: granted });
    await refreshSetupStatus().catch(() => {});
    setRequesting(false);
  };

  const handleBackgroundLocationRequest = async () => {
    setRequesting(true);
    const granted = await requestBackgroundLocationPermission();
    setBackgroundGranted(granted);
    await refreshSetupStatus().catch(() => {});
    setRequesting(false);
  };

  const requestTrackingModePermissions = async (mode = trackingMode) => {
    await requestForegroundLocationPermission();
    await requestNotificationPermission();
    await requestMotionSensorPermission();
    if (isAndroid()) await requestActivityRecognitionPermission();
    if (mode === 'background_auto') {
      await requestBackgroundLocationPermission();
    }
    if (mode === 'background_auto') {
      if (isAndroid()) {
        try {
          await startNativeAutoTracking();
        } catch {}
      }
    }
  };

  const handleRecommendedSetup = async ({ autoOpenUsageAccess = false } = {}) => {
    setRequesting(true);
    setSetupStatus('Requesting location, notifications, motion, activity, and background tracking permissions...');
    const recommendedMode = isAndroid() ? 'background_auto' : 'auto_detect';
    setTrackingMode(recommendedMode);
    await requestTrackingModePermissions(recommendedMode);
    await refreshSetupStatus().catch(() => {});
    setSetupStatus(isAndroid()
      ? 'Core prompts complete. Finish any Android settings rows that still show setup.'
      : 'Core prompts complete.');
    setRequesting(false);
    if (autoOpenUsageAccess && isAndroid()) {
      await openAndroidUsageAccessSettings().catch(() => {});
    }
  };

  useEffect(() => {
    if (localStorage.getItem('drivesense_first_launch_permission_prompted') === 'true') return undefined;
    localStorage.setItem('drivesense_first_launch_permission_prompted', 'true');
    const timer = setTimeout(() => {
      handleRecommendedSetup({ autoOpenUsageAccess: true }).catch(() => {
        setRequesting(false);
      });
    }, 700);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    refreshSetupStatus().catch(() => {});
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshSetupStatus().catch(() => {});
    };
    const onFocus = () => refreshSetupStatus().catch(() => {});
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const handleNext = async () => {
    if (isLast) {
      await requestTrackingModePermissions();
      // Save settings and complete onboarding
      localSettings.update({
        onboarding_completed: true,
        tracking_mode: trackingMode,
        auto_tracking_enabled: trackingMode !== 'manual',
        background_tracking_enabled: trackingMode === 'background_auto',
      });
      onComplete?.();
      navigate('/');
      return;
    }

    // Request location permission when on location step
    if (currentStep.id === 'location' && !locationGranted) {
      await handleLocationRequest();
    }

    setStep(s => s + 1);
  };

  const handleSkip = () => {
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
                  onClick={openAndroidUsageAccessSettings}
                  className="w-full rounded-2xl border border-border bg-card p-3 text-left text-sm font-semibold text-foreground"
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
                  <SetupChecklistRow
                    label="Background location"
                    detail="Needed for automatic trip capture while the app sleeps."
                    ready={backgroundGranted}
                    onAction={handleBackgroundLocationRequest}
                    disabled={requesting}
                  />
                )}
                {isAndroid() && (
                  <SetupChecklistRow
                    label="Phone Usage Access"
                    detail="Optional, but makes phone-use detection measured instead of inferred."
                    ready={usageAccessGranted}
                    onAction={() => openAndroidUsageAccessSettings().then(() => refreshSetupStatus()).catch(() => {})}
                    actionLabel="Open"
                    disabled={requesting}
                  />
                )}
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Actions */}
      <div className="w-full max-w-sm mt-4 flex flex-col gap-3">
        <button
          onClick={handleNext}
          className="w-full py-4 bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold rounded-2xl shadow-lg hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
        >
          {isLast ? 'Get Started' : 'Continue'}
          <ChevronRight className="w-4 h-4" />
        </button>

        {!isLast && step > 0 && (
          <button
            onClick={handleSkip}
            className="w-full py-3 text-muted-foreground text-sm hover:text-foreground transition-colors"
          >
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
}
