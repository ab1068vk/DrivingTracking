import { FeaturePermissionBadge, PermissionBadge, SectionTitle, SettingRow, Toggle } from '../settingsComponents';
import { OsrmEndpointPanel } from '@/settings/osrm/OsrmEndpointPanel';
import { CalibrationSettings } from './CalibrationSettings';
import { hasVerifiedOsrmEndpoint } from '@/lib/osrmEndpointTrust';

export function AdvancedSettings({ ctx, visibleSectionIds = null }) {
  const {
    AlertTriangle, Banknote, Bell, Bluetooth, Check, ChevronRight, Clock, Download, Droplets, Focus, Gauge, Info, Leaf, LocateFixed, Lock, MapPin, Monitor, Moon, Plus, Route, Search, Shield, SlidersHorizontal, Smartphone, Sun, Target, Trash2, Unlock, Upload, Volume2, X, Zap,
    AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO, CALIBRATION_STATUSES, Checkbox, COMMUTE_MATCH_RADIUS_M, CURRENCY_SYMBOL_OPTIONS, CalibrationStatusTag, FeaturePermissionBadge: FeaturePermissionBadgeFromCtx, NIGHT_END_TIME, NIGHT_START_TIME, PENALTY_SCALE_CALIBRATION, PRIVACY_RADIUS_MAX_M, PRIVACY_RADIUS_MIN_M, PROVISIONAL_SCORING_CONSTANTS, PUBLIC_OSRM_DEMO_URL, SCORING_VERSION, SPEED_LIMIT_DEFAULT_COUNTRY_LABELS,
    addCurrentPrivacyZone, applyCalibration, autoRescoreVisible, batteryStatus, calibLoading, calibProfile, calibrationEntryForSetting, calibrationStatusLabel, cfg, commitPrivacyDraftRadius, deletePrivacyZone, dismissCalibration, effectiveTrackingMode, enableOsrmMapMatching, enableTrackingMode, getPermissionExplanation, handleBatteryOptimization, handleDeleteAllTrips, handleExportAll, handleExportBackup, handleMotionPermission, handleObdPairing, importInputRef, isAndroid, isPublicOsrmDemoUrl, locationFeatureStatus, motionSupport, nativeTrackingStatus, notificationFeatureStatus, obdPairingStatus, obdSupport, openAndroidUsageAccessSettings, osrmEndpointDraft, osrmHealthCheckState, parkedLocation, permissionStatus, privacyDraft, privacyDraftRadiusError, privacyRadiusDrafts, privacyZoneRadiusErrors, privacyZones, refreshPermissions, requestActivityRecognitionPermission, requestBackgroundLocationPermission, requestForegroundLocationPermission, requestNotificationPermission, requestSaveOsrmEndpoint, rescoreCompleted, rescoreProgress, rescoreProgressPct, rescoreStatus, rescoreTotal, rescoreTrips, runCalibration, runVoiceTest, saveOsrmEndpoint, savePrivacyZone, scoreMigrationSummary, scoringValue, setOsrmEndpointDraft, setPatternGuideOpen, setPrivacyDraft, setPrivacyDraftRadiusError, setPrivacyRadiusDrafts, setPrivacyZoneRadiusErrors, setThresholdEditingEnabled, showPrivacyPolicy, sliderWarning, speedLimitDefaultCountryKey, stopNativeAutoTrackingSafely, thresholdEditingEnabled, updateCfg, updateExternalContextAutoFetch, updateNightMode, updateNotificationSetting, updatePrivacyZoneRadius, updateRetention, updateTheme, updateTrackingPaused, voiceTestStatus
  } = ctx;
  void FeaturePermissionBadgeFromCtx;
  const sectionVisible = (id) => !visibleSectionIds || visibleSectionIds.includes(id);

  return (
    <>
      <CalibrationSettings
        cfg={cfg}
        updateCfg={updateCfg}
        visible={sectionVisible('settings-calibration')}
      />

      {sectionVisible('settings-advanced-models') && (
        <>
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
                <details className="group px-1 py-3 border-b border-border/50">
                  <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium text-muted-foreground">
                    <span className="transition-transform group-open:rotate-90">{'>'}</span>
                    <Route className="h-4 w-4" />
                    Advanced: Route snapping (OSRM)
                  </summary>
                  <div className="mt-2 space-y-3">
                    <div className="rounded-lg bg-secondary/40 p-3 text-xs text-muted-foreground space-y-1">
                      <p className="font-medium text-foreground">What is route snapping?</p>
                      <p>
                        OSRM cleans up GPS wiggles so your trip line follows road geometry. It requires a self-hosted or trusted OSRM server; the public demo is blocked because it receives raw GPS coordinates.
                      </p>
                      <p>
                        If you don't have an OSRM server, your trips still score correctly. Only the map display is affected.
                      </p>
                      <a
                        href="https://github.com/Project-OSRM/osrm-backend"
                        className="inline-flex text-primary underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Learn how to self-host OSRM
                      </a>
                    </div>
                    <SettingRow
                      icon={Route}
                      label="Snap route to roads (OSRM)"
                      sublabel="Manual only. Sends sampled GPS points only when you tap Get Road Data on a trip."
                    >
                      <Toggle
                        value={hasVerifiedOsrmEndpoint(cfg)}
                        onChange={enableOsrmMapMatching}
                      />
                    </SettingRow>
                    <div className="px-1 py-3 border-b border-border/50">
                      <div className="flex justify-between gap-3 text-xs mb-1.5">
                        <span className="font-medium">Network timeout</span>
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
                    <OsrmEndpointPanel
                      cfg={cfg}
                      endpointDraft={osrmEndpointDraft}
                      healthCheckState={osrmHealthCheckState}
                      isPublicOsrmDemoUrl={isPublicOsrmDemoUrl}
                      publicDemoUrl={PUBLIC_OSRM_DEMO_URL}
                      onChangeEndpointDraft={setOsrmEndpointDraft}
                      onSaveEndpoint={requestSaveOsrmEndpoint}
                      onClearEndpoint={() => {
                        setOsrmEndpointDraft('');
                        saveOsrmEndpoint('', true);
                      }}
                    />
                  </div>
                </details>
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
        </>
      )}

      {sectionVisible('settings-phone-use') && (
        <>
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
        </>
      )}
    </>
  );
}
