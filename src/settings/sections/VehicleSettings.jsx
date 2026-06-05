import { FeaturePermissionBadge, PermissionBadge, SectionTitle, SettingRow, Toggle } from '../settingsComponents';

export function VehicleSettings({ ctx, visibleSectionIds = null }) {
  const {
    AlertTriangle, Banknote, Bell, Bluetooth, Check, ChevronRight, Clock, Download, Droplets, Focus, Gauge, Info, Leaf, LocateFixed, Lock, MapPin, Monitor, Moon, Plus, Route, Search, Shield, SlidersHorizontal, Smartphone, Sun, Target, Trash2, Unlock, Upload, Volume2, X, Zap,
    AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO, CALIBRATION_STATUSES, Checkbox, COMMUTE_MATCH_RADIUS_M, CURRENCY_SYMBOL_OPTIONS, CalibrationStatusTag, FeaturePermissionBadge: FeaturePermissionBadgeFromCtx, NIGHT_END_TIME, NIGHT_START_TIME, PENALTY_SCALE_CALIBRATION, PRIVACY_RADIUS_MAX_M, PRIVACY_RADIUS_MIN_M, PROVISIONAL_SCORING_CONSTANTS, PUBLIC_OSRM_DEMO_URL, SCORING_VERSION, SPEED_LIMIT_DEFAULT_COUNTRY_LABELS,
    addCurrentPrivacyZone, applyCalibration, autoRescoreVisible, batteryStatus, calibLoading, calibProfile, calibrationEntryForSetting, calibrationStatusLabel, cfg, commitPrivacyDraftRadius, deletePrivacyZone, dismissCalibration, effectiveTrackingMode, enableOsrmMapMatching, enableTrackingMode, getPermissionExplanation, handleBatteryOptimization, handleDeleteAllTrips, handleExportAll, handleExportBackup, handleMotionPermission, handleObdPairing, importInputRef, isAndroid, isPublicOsrmDemoUrl, locationFeatureStatus, motionSupport, nativeTrackingStatus, notificationFeatureStatus, obdPairingStatus, obdSupport, openAndroidUsageAccessSettings, osrmEndpointDraft, osrmHealthCheckState, parkedLocation, permissionStatus, privacyDraft, privacyDraftRadiusError, privacyRadiusDrafts, privacyZoneRadiusErrors, privacyZones, requestActivityRecognitionPermission, requestBackgroundLocationPermission, requestForegroundLocationPermission, requestNotificationPermission, requestSaveOsrmEndpoint, rescoreCompleted, rescoreProgress, rescoreProgressPct, rescoreStatus, rescoreTotal, rescoreTrips, runCalibration, runVoiceTest, saveOsrmEndpoint, savePrivacyZone, scoreMigrationSummary, scoringValue, setOsrmEndpointDraft, setPatternGuideOpen, setPrivacyDraft, setPrivacyDraftRadiusError, setPrivacyRadiusDrafts, setPrivacyZoneRadiusErrors, setThresholdEditingEnabled, showPrivacyPolicy, sliderWarning, speedLimitDefaultCountryKey, stopNativeAutoTrackingSafely, thresholdEditingEnabled, updateCfg, updateExternalContextAutoFetch, updateNightMode, updateNotificationSetting, updatePrivacyZoneRadius, updateRetention, updateTheme, updateTrackingPaused, voiceTestStatus
  } = ctx;
  void FeaturePermissionBadgeFromCtx;
  const sectionVisible = (id) => !visibleSectionIds || visibleSectionIds.includes(id);

  return (
    <>
      {sectionVisible('settings-appearance') && (
        <>
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
        </>
      )}

      {sectionVisible('settings-economics') && (
        <>
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
                    value={cfg.co2_baseline_kg_per_100km ?? 12}
                    onChange={e => updateCfg({ co2_baseline_kg_per_100km: Number(e.target.value) })}
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
                    value={cfg.default_ev_kwh_per_100km ?? 18}
                    onChange={e => updateCfg({ default_ev_kwh_per_100km: Number(e.target.value) })}
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
                    value={cfg.grid_co2_kg_per_kwh ?? 0.04}
                    onChange={e => updateCfg({ grid_co2_kg_per_kwh: Number(e.target.value) })}
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
                    value={cfg.tree_co2_kg_per_year ?? 21}
                    onChange={e => updateCfg({ tree_co2_kg_per_year: Number(e.target.value) })}
                    className="w-24 rounded-lg border border-border bg-background px-2 py-1 text-right text-xs outline-none focus:border-primary"
                  />
                </SettingRow>
              </div>
        </>
      )}
    </>
  );
}
