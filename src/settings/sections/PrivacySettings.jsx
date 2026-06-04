import { useState } from 'react';
import { FeaturePermissionBadge, PermissionBadge, SectionTitle, SettingRow, Toggle } from '../settingsComponents';
import { LEGAL_DISCLAIMER_ITEMS, LEGAL_DISCLAIMER_SUMMARY } from '@/lib/legalDisclaimers';
import {
  isBiometricLockEnabled,
  isLocked,
  markUnlocked,
  notifyBiometricLockSettingsChanged,
  setBiometricLockEnabled,
} from '@/lib/biometricLock';
import {
  BIOMETRIC_LOCK_TIMEOUT_DEFAULT_MINUTES,
  BIOMETRIC_LOCK_TIMEOUT_MAX_MINUTES,
} from '@/lib/appConstants';
import { authenticateBiometricGate, isBiometricGateAvailable } from '@/lib/nativeBiometricGate';
import { PRIVACY_CONSENT_POINTS, PRIVACY_NOTICE_HIGHLIGHTS, PRIVACY_NOTICE_SUMMARY } from '@/lib/privacyNotice';
import { toast } from '@/components/ui/use-toast';

export function PrivacySettings({ ctx, visibleSectionIds = null }) {
  const {
    AlertTriangle, Banknote, Bell, Bluetooth, Check, ChevronRight, Clock, Download, Droplets, Focus, Gauge, Info, Leaf, LocateFixed, Lock, MapPin, Monitor, Moon, Plus, Route, Search, Shield, SlidersHorizontal, Smartphone, Sun, Target, Trash2, Unlock, Upload, Volume2, X, Zap,
    AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO, CALIBRATION_STATUSES, Checkbox, COMMUTE_MATCH_RADIUS_M, CURRENCY_SYMBOL_OPTIONS, CalibrationStatusTag, FeaturePermissionBadge: FeaturePermissionBadgeFromCtx, NIGHT_END_TIME, NIGHT_START_TIME, PENALTY_SCALE_CALIBRATION, PRIVACY_RADIUS_MAX_M, PRIVACY_RADIUS_MIN_M, PROVISIONAL_SCORING_CONSTANTS, PUBLIC_OSRM_DEMO_URL, RECOMMENDED_PRIVACY_RADIUS_M, SCORING_VERSION, SPEED_LIMIT_DEFAULT_COUNTRY_LABELS,
    addCurrentPrivacyZone, applyCalibration, autoRescoreVisible, batteryStatus, calibLoading, calibProfile, calibrationEntryForSetting, calibrationStatusLabel, cfg, commitPrivacyDraftRadius, deletePrivacyZone, dismissCalibration, effectiveTrackingMode, enableOsrmMapMatching, enableTrackingMode, ephemeralModeState, getPermissionExplanation, handleBackupFileSelected, handleBatteryOptimization, handleDeleteAllTrips, handleExportAll, handleExportBackup, handleMotionPermission, handleObdPairing, handleWipeAllData, importInputRef, isAndroid, isPublicOsrmDemoUrl, locationFeatureStatus, motionSupport, nativeTrackingStatus, notificationFeatureStatus, obdPairingStatus, obdSupport, openAndroidUsageAccessSettings, osrmEndpointDraft, osrmHealthCheckState, parkedLocation, permissionStatus, privacyDraft, privacyDraftRadiusError, privacyRadiusDrafts, privacyZoneRadiusErrors, privacyZones, requestActivityRecognitionPermission, requestBackgroundLocationPermission, requestForegroundLocationPermission, requestNotificationPermission, requestSaveOsrmEndpoint, rescoreCompleted, rescoreProgress, rescoreProgressPct, rescoreStatus, rescoreTotal, rescoreTrips, runCalibration, runVoiceTest, saveOsrmEndpoint, savePrivacyZone, scoreMigrationSummary, scoringValue, setOsrmEndpointDraft, setPatternGuideOpen, setPrivacyDraft, setPrivacyDraftRadiusError, setPrivacyRadiusDrafts, setPrivacyZoneRadiusErrors, setStealthNextTripEnabled, setThresholdEditingEnabled, showPrivacyPolicy, sliderWarning, speedLimitDefaultCountryKey, stealthTripToggleDisabled, stopNativeAutoTrackingSafely, thresholdEditingEnabled, updateCfg, updateExternalContextAutoFetch, updateNightMode, updateNotificationSetting, updatePrivacyZoneRadius, updateRetention, updateTheme, updateTrackingPaused, voiceTestStatus
  } = ctx;
  void FeaturePermissionBadgeFromCtx;
  const settings = cfg ?? {};
  const sectionVisible = (id) => !visibleSectionIds || visibleSectionIds.includes(id);
  const [biometricLockEnabled, setBiometricLockEnabledState] = useState(() => isBiometricLockEnabled());
  const [biometricLockBusy, setBiometricLockBusy] = useState(false);
  const lockTimeout = settings?.lock_timeout_minutes ?? BIOMETRIC_LOCK_TIMEOUT_DEFAULT_MINUTES;
  const draftRadiusValue = Number(privacyDraft.radius_m);
  const showDraftRadiusWarning =
    Number.isFinite(draftRadiusValue) &&
    draftRadiusValue >= PRIVACY_RADIUS_MIN_M &&
    draftRadiusValue < RECOMMENDED_PRIVACY_RADIUS_M;
  const updateBiometricLockEnabled = async (enabled) => {
    if (biometricLockBusy) return;
    setBiometricLockBusy(true);
    const wasLocked = isLocked(settings);
    try {
      if (enabled === true && isAndroid()) {
        const available = await isBiometricGateAvailable();
        if (!available) {
          toast({
            title: 'App lock unavailable',
            description: 'Set up a device PIN, password, pattern, or fingerprint before turning on App lock.',
            variant: 'destructive',
          });
          return;
        }
        await authenticateBiometricGate();
      }

      updateCfg({ biometric_lock_enabled: enabled === true });
      setBiometricLockEnabled(enabled);
      if (enabled && !wasLocked) markUnlocked();
      setBiometricLockEnabledState(isBiometricLockEnabled());
      notifyBiometricLockSettingsChanged();
    } catch (error) {
      if (error?.message !== 'cancelled') {
        toast({
          title: 'Could not enable App lock',
          description: error?.message || 'Confirm your device credential and try again.',
          variant: 'destructive',
        });
      }
    } finally {
      setBiometricLockBusy(false);
    }
  };
  const updateBiometricLockTimeout = (minutes) => {
    updateCfg({ lock_timeout_minutes: minutes });
    notifyBiometricLockSettingsChanged();
  };

  return (
    <>
      {sectionVisible('settings-privacy-data') && (
        <>
      {/* Privacy */}
              <SectionTitle id="settings-privacy-data">Privacy & Data</SectionTitle>
              <div>
                <SettingRow
                  icon={Shield}
                  label="Privacy, Legal & Safety"
                  sublabel="What stays local, what can leave, what is masked, and deletion limits"
                  onClick={showPrivacyPolicy}
                >
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </SettingRow>
                <div className="my-3 rounded-2xl border border-border bg-secondary/30 p-3">
                  <div className="flex items-start gap-2">
                    <Shield className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div>
                      <div className="text-sm font-semibold text-foreground">Privacy Notice Summary</div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{PRIVACY_NOTICE_SUMMARY}</p>
                    </div>
                  </div>
                  <div className="mt-3 divide-y divide-border/60">
                    {PRIVACY_NOTICE_HIGHLIGHTS.map((item) => (
                      <div key={item.title} className="py-2 first:pt-0 last:pb-0">
                        <div className="text-xs font-semibold text-foreground">{item.title}</div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.body}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 border-t border-border/70 pt-3">
                    <div className="text-xs font-semibold text-foreground">Consent checkpoints</div>
                    <ul className="mt-1 space-y-1 text-xs leading-relaxed text-muted-foreground">
                      {PRIVACY_CONSENT_POINTS.map((point) => (
                        <li key={point}>- {point}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div className="my-3 rounded-2xl border border-amber-400/40 bg-amber-500/10 p-3 text-sm">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <div>
                      <div className="font-semibold text-foreground">Legal & Safety Disclaimers</div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{LEGAL_DISCLAIMER_SUMMARY}</p>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2">
                    {LEGAL_DISCLAIMER_ITEMS.map((item) => (
                      <div key={item.title} className="rounded-xl bg-card/70 px-3 py-2">
                        <div className="text-xs font-semibold text-foreground">{item.title}</div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.body}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <SettingRow
                  icon={Target}
                  label="Share anonymized calibration labels"
                  sublabel="Uploads only summary features and survey labels. Raw GPS, addresses, trip notes, and route geometry stay local."
                >
                  <Checkbox
                    checked={cfg.calibration_sharing_enabled === true}
                    onCheckedChange={(checked) => updateCfg({ calibration_sharing_enabled: checked === true })}
                  />
                </SettingRow>
                <SettingRow
                  icon={Lock}
                  label="App lock (optional)"
                  sublabel="Requires device credential after inactivity. Off by default."
                >
                  <Toggle
                    value={biometricLockEnabled}
                    onChange={updateBiometricLockEnabled}
                    disabled={biometricLockBusy}
                  />
                </SettingRow>
                <SettingRow
                  icon={Clock}
                  label="Auto-lock after"
                  sublabel="Require biometric re-authentication after this unlocked session timeout. Backgrounding still locks immediately."
                >
                  <select
                    value={lockTimeout}
                    onChange={(event) => updateBiometricLockTimeout(Number(event.target.value))}
                    disabled={!biometricLockEnabled}
                    className="bg-card border border-border rounded-lg text-xs px-2 py-1"
                    aria-label="Auto-lock timeout"
                  >
                    <option value={1}>1 minute</option>
                    <option value={BIOMETRIC_LOCK_TIMEOUT_DEFAULT_MINUTES}>{BIOMETRIC_LOCK_TIMEOUT_DEFAULT_MINUTES} minutes (default)</option>
                    <option value={15}>15 minutes</option>
                    <option value={BIOMETRIC_LOCK_TIMEOUT_MAX_MINUTES}>{BIOMETRIC_LOCK_TIMEOUT_MAX_MINUTES} minutes</option>
                    <option value={0}>Never</option>
                  </select>
                </SettingRow>
                <div className="my-3 overflow-hidden rounded-2xl border border-amber-400/50 bg-amber-500/10 p-3">
                  <div className="flex flex-col gap-3 min-[420px]:flex-row min-[420px]:items-start min-[420px]:justify-between">
                    <div className="flex min-w-0 items-start gap-2 self-stretch">
                      <Shield className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-foreground">Stealth Trip Mode</div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          The next trip is scored in memory only, then route points and events are erased when the trip ends or the app backgrounds.
                        </p>
                      </div>
                    </div>
                    <div className="flex w-full justify-end min-[420px]:w-auto min-[420px]:shrink-0">
                      <Toggle
                        value={ephemeralModeState?.stealthNextTrip === true}
                        onChange={setStealthNextTripEnabled}
                        disabled={stealthTripToggleDisabled}
                      />
                    </div>
                  </div>
                  {ephemeralModeState?.stealthNextTrip && (
                    <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                      Active: the next trip will leave no saved trip record on this device.
                    </p>
                  )}
                  {ephemeralModeState?.ephemeralActive && (
                    <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                      Recording in stealth mode. This setting unlocks after the trip is erased.
                    </p>
                  )}
                  {stealthTripToggleDisabled && !ephemeralModeState?.ephemeralActive && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Finish the current trip before arming stealth mode.
                    </p>
                  )}
                </div>
                <div className="my-3 rounded-2xl border border-border bg-secondary/30 p-3">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        <MapPin className="h-4 w-4 text-primary" />
                        Trip Map Privacy Zones
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">Mask sensitive places from maps, CSV exports, and backups.</div>
                    </div>
                    <span className="rounded-full bg-card px-2 py-1 text-xs font-semibold">{privacyZones.length}</span>
                  </div>
                  <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-[minmax(0,1fr)_88px]">
                    <input
                      value={privacyDraft.label}
                      onChange={(event) => setPrivacyDraft((draft) => ({ ...draft, label: event.target.value }))}
                      className="min-w-0 rounded-xl border border-border bg-card px-3 py-2 text-sm"
                      placeholder="Home, work, school"
                      autoComplete="off"
                      data-lpignore="true"
                      data-form-type="other"
                      aria-autocomplete="none"
                      spellCheck={false}
                    />
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
                      className={`min-w-0 rounded-xl border bg-card px-3 py-2 text-sm ${privacyDraftRadiusError ? 'border-red-500 focus:outline-red-500' : 'border-border'}`}
                      aria-label="Privacy zone radius in meters"
                    />
                  </div>
                  <div className={`mt-1 flex justify-end text-[11px] font-medium ${privacyDraftRadiusError ? 'text-red-500' : 'text-muted-foreground'}`}>
                    Min 50 m · Max 1000 m
                  </div>
                  {privacyDraftRadiusError && (
                    <div className="mt-1 text-right text-[11px] font-medium text-red-500">
                      {privacyDraftRadiusError}
                    </div>
                  )}
                  {showDraftRadiusWarning && (
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                      Radii under {RECOMMENDED_PRIVACY_RADIUS_M}m may not fully hide your home address due to GPS drift. Consider {RECOMMENDED_PRIVACY_RADIUS_M}m or higher.
                    </p>
                  )}
                  <div className="mt-2 rounded-xl bg-card px-3 py-2 text-xs text-muted-foreground">
                    Radius can be 50-1000 m. Maps and playback draw this circle and clip the visible route to its edge, while full raw GPS still powers distance, speed, and scoring. Events inside the circle stay hidden from maps and exports.
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
                        <div key={zone.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-card px-3 py-2 text-xs">
                          <div className="min-w-0">
                            <div className="truncate font-semibold">{zone.label}</div>
                            <div className="text-muted-foreground">{Math.round(zone.radius_m)} m mask radius</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
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
                              aria-label={`Radius in meters for ${zone.label}`}
                            />
                            <button
                              type="button"
                              onClick={() => deletePrivacyZone(zone.id)}
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
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </SettingRow>
                <SettingRow
                  icon={Download}
                  label="Export Full Backup"
                  sublabel="Encrypted backup with trips, GPS route points, events, vehicles, and settings"
                  onClick={handleExportBackup}
                >
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </SettingRow>
                <label className="relative -mx-1 flex cursor-pointer items-center justify-between gap-3 rounded-xl border-b border-border/50 px-2 py-3 transition-colors hover:bg-secondary/50">
                  <input
                    ref={importInputRef}
                    type="file"
                    accept="application/json,application/octet-stream,.json,.rsbackup"
                    className="absolute inset-0 z-10 cursor-pointer opacity-0"
                    onChange={handleBackupFileSelected}
                    aria-label="Import Backup"
                  />
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-secondary">
                      <Upload className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <div className="break-words text-sm font-medium">Import Backup</div>
                      <div className="mt-0.5 break-words text-xs text-muted-foreground">
                        Restore a Road Sage backup into local storage
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                </label>
                <SettingRow
                  icon={Info}
                  label="Data Retention"
                  sublabel="Older completed trips are permanently deleted from this device"
                >
                  <select
                    value={cfg.data_retention_months}
                    onChange={e => updateRetention(Number(e.target.value))}
                    className="bg-card border border-border rounded-lg text-xs px-2 py-1"
                  >
                    <option value={6}>6 months</option>
                    <option value={12}>1 year</option>
                    <option value={24}>2 years (default)</option>
                    <option value={36}>3 years</option>
                    <option value={0}>Never</option>
                  </select>
                </SettingRow>
                <div className="px-12 pb-3 text-xs leading-relaxed text-muted-foreground">
                  Export a backup before shortening this setting.
                </div>
                <SettingRow
                  icon={Trash2}
                  label="Delete All Trips"
                  sublabel="Permanently removes all trip data"
                  danger
                  onClick={handleDeleteAllTrips}
                >
                  <ChevronRight className="w-4 h-4 text-red-400" />
                </SettingRow>
                <SettingRow
                  icon={Shield}
                  label="Wipe All Road Sage Data"
                  sublabel="Factory reset this device: trips, vehicles, settings, calibration labels, active-trip recovery, and native cache files"
                  danger
                  onClick={handleWipeAllData}
                >
                  <ChevronRight className="w-4 h-4 text-red-400" />
                </SettingRow>
              </div>
        </>
      )}
    </>
  );
}
