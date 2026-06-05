import { FeaturePermissionBadge, PermissionBadge, SectionTitle, SettingRow, Toggle } from '../settingsComponents';

export function ScoringSettings({ ctx, visibleSectionIds = null }) {
  const {
    AlertTriangle, Banknote, Bell, Bluetooth, Check, ChevronRight, Clock, Download, Droplets, Focus, Gauge, Info, Leaf, LocateFixed, Lock, MapPin, Monitor, Moon, Plus, Route, Search, Shield, SlidersHorizontal, Smartphone, Sun, Target, Trash2, Unlock, Upload, Volume2, X, Zap,
    AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO, CALIBRATION_STATUSES, Checkbox, COMMUTE_MATCH_RADIUS_M, CURRENCY_SYMBOL_OPTIONS, CalibrationStatusTag, FeaturePermissionBadge: FeaturePermissionBadgeFromCtx, NIGHT_END_TIME, NIGHT_START_TIME, PENALTY_SCALE_CALIBRATION, PRIVACY_RADIUS_MAX_M, PRIVACY_RADIUS_MIN_M, PROVISIONAL_SCORING_CONSTANTS, PUBLIC_OSRM_DEMO_URL, SCORING_VERSION, SPEED_LIMIT_DEFAULT_COUNTRY_LABELS,
    addCurrentPrivacyZone, applyCalibration, autoRescoreVisible, batteryStatus, calibLoading, calibProfile, calibrationEntryForSetting, calibrationStatusLabel, cfg, commitPrivacyDraftRadius, deletePrivacyZone, dismissCalibration, effectiveTrackingMode, enableOsrmMapMatching, enableTrackingMode, getPermissionExplanation, handleBatteryOptimization, handleDeleteAllTrips, handleExportAll, handleExportBackup, handleMotionPermission, handleObdPairing, importInputRef, isAndroid, isPublicOsrmDemoUrl, locationFeatureStatus, motionSupport, nativeTrackingStatus, notificationFeatureStatus, obdPairingStatus, obdSupport, openAndroidUsageAccessSettings, osrmEndpointDraft, osrmHealthCheckState, parkedLocation, permissionStatus, privacyDraft, privacyDraftRadiusError, privacyRadiusDrafts, privacyZoneRadiusErrors, privacyZones, requestActivityRecognitionPermission, requestBackgroundLocationPermission, requestForegroundLocationPermission, requestNotificationPermission, requestSaveOsrmEndpoint, rescoreCompleted, rescoreProgress, rescoreProgressPct, rescoreStatus, rescoreTotal, rescoreTrips, runCalibration, runVoiceTest, saveOsrmEndpoint, savePrivacyZone, scoreMigrationSummary, scoringValue, setOsrmEndpointDraft, setPatternGuideOpen, setPrivacyDraft, setPrivacyDraftRadiusError, setPrivacyRadiusDrafts, setPrivacyZoneRadiusErrors, setThresholdEditingEnabled, showPrivacyPolicy, sliderWarning, speedLimitDefaultCountryKey, stopNativeAutoTrackingSafely, thresholdEditingEnabled, updateCfg, updateExternalContextAutoFetch, updateNightMode, updateNotificationSetting, updatePrivacyZoneRadius, updateRetention, updateTheme, updateTrackingPaused, voiceTestStatus
  } = ctx;
  void FeaturePermissionBadgeFromCtx;
  const sectionVisible = (id) => !visibleSectionIds || visibleSectionIds.includes(id);

  return (
    <>
      {sectionVisible('settings-driving-goals') && (
        <>
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
                  </div>
                ))}
              </div>
        </>
      )}

      {sectionVisible('settings-night-window') && (
        <>
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
        </>
      )}

      {sectionVisible('settings-detection-thresholds') && (
        <>
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
                  label="Lane-change diagnostic"
                  sublabel="Diagnostic only; excluded from Safety until dashcam-review criteria are met"
                >
                  <Toggle
                    value={cfg.lane_change_score_enabled !== false}
                    onChange={v => updateCfg({ lane_change_score_enabled: v })}
                  />
                </SettingRow>
                <div className="px-1 pb-2 text-xs leading-relaxed text-muted-foreground">
                  Safety weight is 0% until 200 dashcam-reviewed trips reach at least 85% agreement and curved-road false positives stay below 10%. Curved-road suppression and speed-specific IMU yaw thresholds are active; this still does not measure turn-signal use or following-vehicle gaps.
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
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-100">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold">{PENALTY_SCALE_CALIBRATION.label}</div>
                    <div className="flex items-center gap-2">
                      {PENALTY_SCALE_CALIBRATION.calibration_status === CALIBRATION_STATUSES.PROVISIONAL && <CalibrationStatusTag />}
                      <span className="font-mono">{PENALTY_SCALE_CALIBRATION.value}</span>
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
                    onClick={rescoreTrips}
                    className="rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary"
                  >
                    {scoreMigrationSummary.mismatch_count > 0 ? 'Re-score outdated trips' : 'Re-score completed trips'}
                  </button>
                  {rescoreStatus && <span className="text-xs text-muted-foreground">{rescoreStatus}</span>}
                </div>
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
                <details className="mt-3 rounded-xl border border-border bg-card p-3 text-xs">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-semibold">
                    <span>Calibration registry</span>
                    <span className="flex items-center gap-2">
                      <CalibrationStatusTag />
                      {PROVISIONAL_SCORING_CONSTANTS.length}
                    </span>
                  </summary>
                  <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
                    {PROVISIONAL_SCORING_CONSTANTS.map((entry) => (
                      <div key={entry.key} className="rounded-lg bg-secondary/60 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold">{entry.label}</span>
                          <span className="flex items-center gap-2">
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
                      { key: 'threshold_heading_drift_std_degs', label: 'GPS Attention Signal Threshold', unit: 'degrees', min: 5, max: 15, step: 1, help: 'GPS attention signal only - not a fatigue measurement. The retired 02:00-05:00 multiplier is not applied.' },
                      { key: 'threshold_phone_proxy_oscillations', label: 'Phone Proxy Sensitivity', unit: 'oscillations', min: 6, max: 8, step: 1, help: 'Diagnostic only: GPS micro-steering patterns are not phone-use evidence and do not affect scores.' },
                      { key: 'threshold_speed_creep_kmh', label: 'Speed Creep Alert', unit: 'km/h', min: 5, max: 25, step: 5, help: 'How much speed can rise on straight highway sections before Road Sage logs speed creep.' },
                      { key: 'threshold_overtake_accel_ms2', label: 'Overtake Development Diagnostic', unit: 'm/s²', min: 3.0, max: 5.0, step: 0.5, help: 'Moved to Development Diagnostics and hidden from Trip Detail; it does not affect scores, coaching, route risk, or achievements.' },
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
        </>
      )}

      {sectionVisible('settings-speed-warning') && (
        <>
      {/* Speed Warning */}
              <SectionTitle id="settings-speed-warning">Speed Warning</SectionTitle>
              <SettingRow
                icon={Info}
                label="Automatic road-data fetching"
                sublabel="On by default. Saved trips fetch OpenStreetMap speed limits and Open-Meteo weather when internet is available. OSRM snapping still stays manual."
              >
                <Toggle
                  value={cfg.external_context_auto_fetch_enabled !== false}
                  onChange={updateExternalContextAutoFetch}
                />
              </SettingRow>
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
                label="Get posted speed limits"
                sublabel="When you tap Get Road Data, sends route-area boxes to OpenStreetMap for road names and speed limits"
              >
                <Toggle
                  value={cfg.speed_limit_lookup_enabled !== false}
                  onChange={v => updateCfg({ speed_limit_lookup_enabled: v })}
                />
              </SettingRow>
              <SettingRow
                icon={Gauge}
                label="Fallback limit country"
                sublabel={`Used when OpenStreetMap has no maxspeed tag; Trip Detail shows the ${SPEED_LIMIT_DEFAULT_COUNTRY_LABELS[speedLimitDefaultCountryKey(cfg)] || 'Global'} fallback profile in compliance provenance`}
              >
                <select
                  className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
                  value={String(cfg.country_code || cfg.configurable_country_defaults || 'global').toLowerCase()}
                  onChange={event => {
                    const value = event.target.value;
                    updateCfg({
                      country_code: value === 'global' ? '' : value.toUpperCase(),
                      configurable_country_defaults: value,
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
              <SettingRow
                icon={Droplets}
                label="Get trip weather"
                sublabel="When you tap Get Road Data, sends a privacy-safe route point and date to Open-Meteo"
              >
                <Toggle
                  value={cfg.weather_context_enabled !== false}
                  onChange={v => updateCfg({ weather_context_enabled: v })}
                />
              </SettingRow>
              <div className="mx-1 mb-3 rounded-2xl border border-border bg-card p-3 text-xs text-muted-foreground">
                <div className="font-semibold text-foreground">What Get Road Data does</div>
                <div className="mt-2 grid gap-2">
                  <div>
                    <span className="font-semibold text-foreground">Get posted speed limits {cfg.speed_limit_lookup_enabled === false ? 'OFF' : 'ON'}:</span>{' '}
                    {cfg.speed_limit_lookup_enabled === false
                      ? 'skips OpenStreetMap; scoring and map colors use GPS/fallback limits only.'
                      : `sends route-area boxes to OpenStreetMap Overpass and adds road names plus posted/default limits. Road-type defaults use the ${String(cfg.country_code || cfg.configurable_country_defaults || 'global').toUpperCase()} profile and remain approximations, not legal advice.`}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">Get trip weather {cfg.weather_context_enabled === false ? 'OFF' : 'ON'}:</span>{' '}
                    {cfg.weather_context_enabled === false
                      ? 'skips Open-Meteo; scores do not get weather adjustment.'
                      : 'sends a privacy-safe route point and date to Open-Meteo and can adjust scores for rain, snow, fog, or freezing weather.'}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">Snap route to roads {cfg.map_matching_enabled === false ? 'OFF' : cfg.osrm_map_matching_url && cfg.osrm_data_sharing_consented === true ? 'ON' : cfg.osrm_map_matching_url ? 'NEEDS CONSENT' : 'OPTIONAL'}:</span>{' '}
                    {cfg.map_matching_enabled === false
                      ? 'skips OSRM; map/playback keep the original GPS line.'
                      : cfg.osrm_map_matching_url
                        ? isPublicOsrmDemoUrl(cfg.osrm_map_matching_url)
                          ? 'blocked because the public OSRM demo is reference text only.'
                          : cfg.osrm_data_sharing_consented === true
                            ? 'sends sampled GPS points to your trusted OSRM endpoint and may make map/playback follow roads more cleanly.'
                            : 'will be skipped until OSRM data-sharing consent is saved.'
                        : 'optional map cleanup only; trips still score correctly without an OSRM endpoint.'}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">Automatic road-data fetching {cfg.external_context_auto_fetch_enabled !== false ? 'ON' : 'OFF'}:</span>{' '}
                    {cfg.external_context_auto_fetch_enabled !== false
                      ? 'new saved trips fetch OpenStreetMap speed limits and Open-Meteo weather automatically; OSRM still waits for manual Get Road Data.'
                      : 'new saved trips stay local for map/weather services until the user taps Get Road Data.'}
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
        </>
      )}
    </>
  );
}
