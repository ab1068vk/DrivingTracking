import { FeaturePermissionBadge, PermissionBadge, SectionTitle, SettingRow, Toggle } from '../settingsComponents';

export function PrivacySettings({ ctx, visibleSectionIds = null }) {
  const {
    AlertTriangle, Banknote, Bell, Bluetooth, Check, ChevronRight, Clock, Download, Droplets, Focus, Gauge, Info, Leaf, LocateFixed, Lock, MapPin, Monitor, Moon, Plus, Route, Search, Shield, SlidersHorizontal, Smartphone, Sun, Target, Trash2, Unlock, Upload, Volume2, X, Zap,
    AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO, CALIBRATION_STATUSES, Checkbox, COMMUTE_MATCH_RADIUS_M, CURRENCY_SYMBOL_OPTIONS, CalibrationStatusTag, FeaturePermissionBadge: FeaturePermissionBadgeFromCtx, NIGHT_END_TIME, NIGHT_START_TIME, PENALTY_SCALE_CALIBRATION, PRIVACY_RADIUS_MAX_M, PRIVACY_RADIUS_MIN_M, PROVISIONAL_SCORING_CONSTANTS, PUBLIC_OSRM_DEMO_URL, RECOMMENDED_PRIVACY_RADIUS_M, SCORING_VERSION, SPEED_LIMIT_DEFAULT_COUNTRY_LABELS,
    addCurrentPrivacyZone, applyCalibration, autoRescoreVisible, batteryStatus, calibLoading, calibProfile, calibrationEntryForSetting, calibrationStatusLabel, cfg, commitPrivacyDraftRadius, deletePrivacyZone, dismissCalibration, effectiveTrackingMode, enableOsrmMapMatching, enableTrackingMode, getPermissionExplanation, handleBatteryOptimization, handleDeleteAllTrips, handleExportAll, handleExportBackup, handleMotionPermission, handleObdPairing, importInputRef, isAndroid, isPublicOsrmDemoUrl, locationFeatureStatus, motionSupport, nativeTrackingStatus, notificationFeatureStatus, obdPairingStatus, obdSupport, openAndroidUsageAccessSettings, osrmEndpointDraft, osrmHealthCheckState, parkedLocation, permissionStatus, privacyDraft, privacyDraftRadiusError, privacyRadiusDrafts, privacyZoneRadiusErrors, privacyZones, requestActivityRecognitionPermission, requestBackgroundLocationPermission, requestForegroundLocationPermission, requestNotificationPermission, requestSaveOsrmEndpoint, rescoreCompleted, rescoreProgress, rescoreProgressPct, rescoreStatus, rescoreTotal, rescoreTrips, runCalibration, runVoiceTest, saveOsrmEndpoint, savePrivacyZone, scoreMigrationSummary, scoringValue, setOsrmEndpointDraft, setPatternGuideOpen, setPrivacyDraft, setPrivacyDraftRadiusError, setPrivacyRadiusDrafts, setPrivacyZoneRadiusErrors, setThresholdEditingEnabled, showPrivacyPolicy, sliderWarning, speedLimitDefaultCountryKey, stopNativeAutoTrackingSafely, thresholdEditingEnabled, updateCfg, updateExternalContextAutoFetch, updateNightMode, updateNotificationSetting, updatePrivacyZoneRadius, updateRetention, updateTheme, updateTrackingPaused, voiceTestStatus
  } = ctx;
  void FeaturePermissionBadgeFromCtx;
  const sectionVisible = (id) => !visibleSectionIds || visibleSectionIds.includes(id);
  const draftRadiusValue = Number(privacyDraft.radius_m);
  const showDraftRadiusWarning =
    Number.isFinite(draftRadiusValue) &&
    draftRadiusValue >= PRIVACY_RADIUS_MIN_M &&
    draftRadiusValue < RECOMMENDED_PRIVACY_RADIUS_M;

  return (
    <>
      {sectionVisible('settings-privacy-data') && (
        <>
      {/* Privacy */}
              <SectionTitle id="settings-privacy-data">Privacy & Data</SectionTitle>
              <div>
                <SettingRow
                  icon={Shield}
                  label="Privacy Policy"
                  sublabel="All data is stored locally on your device"
                  onClick={showPrivacyPolicy}
                >
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </SettingRow>
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
                  sublabel="JSON with trips, GPS route points, events, vehicles, and settings"
                  onClick={handleExportBackup}
                >
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </SettingRow>
                <SettingRow
                  icon={Upload}
                  label="Import Backup"
                  sublabel="Restore a Road Sage JSON backup into local storage"
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
        </>
      )}
    </>
  );
}
