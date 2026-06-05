import { FeaturePermissionBadge, PermissionBadge, SectionTitle, SettingRow, Toggle } from '../settingsComponents';

export function TrackingSettings({ ctx, visibleSectionIds = null }) {
  const {
    AlertTriangle, Banknote, Bell, Bluetooth, Check, ChevronRight, Clock, Download, Droplets, Focus, Gauge, Info, Leaf, LocateFixed, Lock, MapPin, Monitor, Moon, Plus, Route, Search, Shield, SlidersHorizontal, Smartphone, Sun, Target, Trash2, Unlock, Upload, Volume2, X, Zap,
    AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO, CALIBRATION_STATUSES, Checkbox, COMMUTE_MATCH_RADIUS_M, CURRENCY_SYMBOL_OPTIONS, CalibrationStatusTag, FeaturePermissionBadge: FeaturePermissionBadgeFromCtx, NIGHT_END_TIME, NIGHT_START_TIME, PENALTY_SCALE_CALIBRATION, PRIVACY_RADIUS_MAX_M, PRIVACY_RADIUS_MIN_M, PROVISIONAL_SCORING_CONSTANTS, PUBLIC_OSRM_DEMO_URL, SCORING_VERSION, SPEED_LIMIT_DEFAULT_COUNTRY_LABELS,
    addCurrentPrivacyZone, applyCalibration, autoRescoreVisible, batteryStatus, calibLoading, calibProfile, calibrationEntryForSetting, calibrationStatusLabel, cfg, commitPrivacyDraftRadius, deletePrivacyZone, dismissCalibration, effectiveTrackingMode, enableOsrmMapMatching, enableTrackingMode, getPermissionExplanation, handleBatteryOptimization, handleDeleteAllTrips, handleExportAll, handleExportBackup, handleMotionPermission, handleObdPairing, importInputRef, isAndroid, isPublicOsrmDemoUrl, locationFeatureStatus, motionSupport, nativeTrackingStatus, notificationFeatureStatus, obdPairingStatus, obdSupport, openAndroidUsageAccessSettings, osrmEndpointDraft, osrmHealthCheckState, parkedLocation, permissionStatus, privacyDraft, privacyDraftRadiusError, privacyRadiusDrafts, privacyZoneRadiusErrors, privacyZones, refreshPermissions, requestActivityRecognitionPermission, requestBackgroundLocationPermission, requestForegroundLocationPermission, requestNotificationPermission, requestSaveOsrmEndpoint, rescoreCompleted, rescoreProgress, rescoreProgressPct, rescoreStatus, rescoreTotal, rescoreTrips, runCalibration, runVoiceTest, saveOsrmEndpoint, savePrivacyZone, scoreMigrationSummary, scoringValue, setOsrmEndpointDraft, setPatternGuideOpen, setPrivacyDraft, setPrivacyDraftRadiusError, setPrivacyRadiusDrafts, setPrivacyZoneRadiusErrors, setThresholdEditingEnabled, showPrivacyPolicy, sliderWarning, speedLimitDefaultCountryKey, stopNativeAutoTrackingSafely, thresholdEditingEnabled, trackingModeRequestInFlight, updateCfg, updateExternalContextAutoFetch, updateNightMode, updateNotificationSetting, updatePrivacyZoneRadius, updateRetention, updateTheme, updateTrackingPaused, voiceTestStatus
  } = ctx;
  void FeaturePermissionBadgeFromCtx;
  const sectionVisible = (id) => !visibleSectionIds || visibleSectionIds.includes(id);
  const notificationPermissionState = permissionStatus?.notifications ||
    (cfg.notification_permission_granted === true ? 'granted' : cfg.notification_permission_granted);
  const notificationPermissionGranted = notificationPermissionState === 'granted';
  const notificationsMasterOn = cfg.notifications_enabled !== false && notificationPermissionGranted;
  const notificationControlsDisabled = !notificationsMasterOn;
  const notificationToggleValue = (key) => notificationsMasterOn && cfg[key] !== false;

  return (
    <>
      {sectionVisible('settings-tracking') && (
        <>
      {/* Tracking */}
              <SectionTitle id="settings-tracking">Tracking</SectionTitle>
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
                        disabled={trackingModeRequestInFlight || effectiveTrackingMode === opt.id}
                        className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all text-left ${
                          effectiveTrackingMode === opt.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                        } disabled:cursor-not-allowed disabled:opacity-60`}
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
                  sublabel={cfg.tracking_paused ? 'Paused until Pause All Tracking is turned off' : nativeTrackingStatus?.enabled ? 'Native background auto tracking is running' : 'Keeps recording after the app is minimized with a persistent notification'}
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
        </>
      )}

      {sectionVisible('settings-android-permissions') && (
        <>
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
        </>
      )}

      {sectionVisible('settings-feature-permissions') && (
        <>
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
                    label: 'Real speed limits, weather, optional OSRM matching, and offline route previews',
                    sub: 'Uses open-source map/weather data over the network or cached local route data. OSRM route matching stays off unless you add an endpoint.',
                    value: 'none',
                  },
                  {
                    label: 'Live voice alerts and rule-based driving coach summaries',
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
        </>
      )}

      {sectionVisible('settings-notifications') && (
        <>
      {/* Notifications */}
              <SectionTitle id="settings-notifications">Notifications</SectionTitle>
              <div className="space-y-3">
                <SettingRow
                  icon={Bell}
                  label="Enable all notifications"
                  sublabel={notificationPermissionGranted ? 'Disabling this turns off all notification groups below' : 'Android notification permission is not granted'}
                >
                  <Toggle value={notificationsMasterOn} onChange={v => updateNotificationSetting({ notifications_enabled: v })} />
                </SettingRow>
                <div className={`${notificationControlsDisabled ? 'pointer-events-none opacity-50' : ''}`}>
                  <div className="rounded-2xl bg-secondary/40 p-3">
                    <div className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">Quiet Hours</div>
                    <SettingRow label="Quiet hours" sublabel="Suppress non-safety notifications during this window">
                      <Toggle value={notificationsMasterOn && cfg.notif_quiet_hours_enabled === true} onChange={v => updateNotificationSetting({ notif_quiet_hours_enabled: v })} disabled={notificationControlsDisabled} />
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
                      { key: 'notif_phone_use_alert_enabled', label: 'Phone use warning', sub: 'Immediate warning for confirmed Android Usage Access detections' },
                      { key: 'notif_heading_drift_alert_enabled', label: 'Attention pattern warning', sub: 'Beta GPS heading patterns and long-drive break alerts' },
                      { key: 'notif_speeding_alert_enabled', label: 'Speeding alert', sub: 'Sustained speeding warnings' },
                      { key: 'danger_zone_alerts_enabled', label: 'Repeated event area alerts', sub: 'Warn when approaching your own repeated driving-event locations' },
                      { key: 'live_coaching_enabled', label: 'Live coaching overlay', sub: 'Show real-time coaching feedback during active trips' },
                    ].map(({ key, label, sub }) => (
                        <SettingRow key={key} label={label} sublabel={sub}>
                        <Toggle value={notificationToggleValue(key)} onChange={v => updateNotificationSetting({ [key]: v })} disabled={notificationControlsDisabled || (key !== 'notif_safety_alerts_enabled' && cfg.notif_safety_alerts_enabled === false)} />
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
                        <Toggle value={notificationToggleValue(key)} onChange={v => updateNotificationSetting({ [key]: v })} disabled={notificationControlsDisabled || (key.startsWith('notif_post_trip_') && cfg.notif_post_trip_summary_enabled === false && key !== 'notif_post_trip_summary_enabled')} />
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
                        disabled={notificationControlsDisabled}
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
                        <Toggle value={notificationToggleValue(key)} onChange={v => updateNotificationSetting({ [key]: v })} disabled={notificationControlsDisabled || (key !== 'notif_coaching_enabled' && cfg.notif_coaching_enabled === false && key.startsWith('notif_'))} />
                      </SettingRow>
                    ))}
                  </div>

                  <div className="rounded-2xl bg-secondary/40 p-3">
                    <div className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">Vehicle</div>
                    <SettingRow label="Maintenance reminders" sublabel="Vehicle service due and soon notifications">
                      <Toggle value={notificationToggleValue('notif_maintenance_enabled')} onChange={v => updateNotificationSetting({ notif_maintenance_enabled: v })} disabled={notificationControlsDisabled} />
                    </SettingRow>
                    <SettingRow label="No-trip nudge" sublabel="Remind after a period with no recorded trips">
                      <Toggle value={notificationToggleValue('notif_inactive_nudge_enabled')} onChange={v => updateNotificationSetting({ notif_inactive_nudge_enabled: v })} disabled={notificationControlsDisabled} />
                    </SettingRow>
                    <SettingRow label="Nudge after" sublabel="Days without a completed trip">
                      <select
                        value={cfg.notif_inactive_nudge_days ?? 7}
                        disabled={notificationControlsDisabled || cfg.notif_inactive_nudge_enabled === false}
                        onChange={e => updateNotificationSetting({ notif_inactive_nudge_days: Number(e.target.value) })}
                        className="bg-card border border-border rounded-lg text-xs px-2 py-1 disabled:opacity-60"
                      >
                        {[3, 5, 7, 14].map((days) => <option key={days} value={days}>{days} days</option>)}
                      </select>
                    </SettingRow>
                  </div>
                </div>
              </div>
        </>
      )}
    </>
  );
}
