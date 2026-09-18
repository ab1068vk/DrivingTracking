import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildAppActivityProfile,
  buildAppExperienceReport,
  buildRuntimeProfile,
  buildTripDataProfile,
  collectionModeForTrip,
  parseAppExperienceReport,
  recordHistoricalAppExperienceEvent,
  replayEvidenceStateForTrip,
} from '@/lib/appExperienceDiagnostics';
import { getCurrentDiagnosticsAttribution } from '@/lib/diagnosticsIdentity';
import { sanitizeCampaignExport } from '@/lib/diagnosticsCampaignSchema';
import { classifyNativeDiagnosticsProbeFailure, nativeEventAttribution, nativeWatchdogCategory } from '@/lib/activityRecognition';

describe('Diagnostics qualification truth', () => {
  it('keeps native projection and runtime build metadata parity in the Android bridge', () => {
    const root = process.cwd();
    const repository = readFileSync(path.join(root, 'android/app/src/main/java/com/drivesense/app/DriveSenseTripArchiveRepository.java'), 'utf8');
    const plugin = readFileSync(path.join(root, 'android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java'), 'utf8');
    expect(repository.match(/PAGE_PROJECTION_FIELDS=\{([^}]*)\}/)?.[1]).toContain('"start_source"');
    expect(plugin).toContain('ROAD_SAGE_BUILD_SOURCE_ID');
    expect(plugin).toContain('artifactId');
    expect(plugin).toContain('versionCode');
  });

  it.each([
    ['native_auto', 'native_automatic'],
    ['native_manual', 'native_manual'],
    ['auto', 'browser_automatic'],
    ['manual', 'browser_manual'],
    [undefined, 'unknown_legacy'],
  ])('classifies collection source %s as %s', (start_source, expected) => {
    expect(collectionModeForTrip({ start_source })).toBe(expected);
  });

  it('supports categorical legacy modes without treating generic native as automatic', () => {
    expect(collectionModeForTrip({ native_manual_background: true })).toBe('native_manual');
    expect(collectionModeForTrip({ tracking_mode: 'background_auto' })).toBe('native_automatic');
    expect(collectionModeForTrip({ tracking_mode: 'auto_detect' })).toBe('browser_automatic');
    expect(collectionModeForTrip({ tracking_mode: 'manual' })).toBe('browser_manual');
    expect(collectionModeForTrip({ start_source: 'native' })).toBe('unknown_legacy');
  });

  it('keeps replay absence distinct from exclusion, expiry, legacy and unavailable representation', () => {
    expect(replayEvidenceStateForTrip({ route_replay_available: true })).toBe('present');
    expect(replayEvidenceStateForTrip({ route_replay_available: false })).toBe('absent');
    expect(replayEvidenceStateForTrip({ privacy_mode: 'summary_only' })).toBe('privacy_excluded');
    expect(replayEvidenceStateForTrip({ route_data_expired_at: 'retained-marker' })).toBe('expired');
    expect(replayEvidenceStateForTrip({})).toBe('legacy_unknown');
    expect(replayEvidenceStateForTrip({ diagnostics_replay_representation: 'unavailable' })).toBe('unavailable');
    expect(replayEvidenceStateForTrip({ projection_status: 'degraded', route_replay_available: false })).toBe('unavailable');
  });

  it('never presents a fixed twenty-row window as the population at campaign scales', () => {
    for (const total of [0, 1, 20, 21, 100, 128, 500, 1000, 3000, 5000, 5001, 10000]) {
      const rows = Array.from({ length: Math.min(20, total) }, (_, index) => ({
        status: 'completed', distance_km: index + 1, route_replay_available: false,
      }));
      const profile = buildTripDataProfile(rows, {
        window: { limit: 20, hasMore: total > 20, populationComplete: total <= 20, completeness: 'EXACT', snapshot: { authority: 'browser', generation: 'g', revision: 1 } },
        population: { available: true, totalTripCount: total, completedTripCount: null, completedCountState: 'not_indexed' },
      });
      expect(profile.scope).toBe('bounded_window');
      expect(profile.window.row_count).toBe(Math.min(20, total));
      expect(profile.anonymous_trip_shapes.length).toBeLessThanOrEqual(20);
      expect(profile.population.total_trip_count).toBe(total);
      expect(profile.window.population_complete).toBe(total <= 20);
    }
  });

  it('counts typed failures but not informational names containing error or failure', () => {
    const profile = buildAppActivityProfile([
      { timestamp: '2026-09-18T10:00:00Z', severity: 'info', category: 'diagnostics', operation: 'possible_error_failure_incident' },
      { timestamp: '2026-09-18T10:01:00Z', severity: 'error', category: 'failure', operation: 'storage_write' },
      { timestamp: '2026-09-18T10:02:00Z', severity: 'info', category: 'diagnostics', operation: 'freeze_anr_memory_pressure_report' },
    ]);
    expect(profile.counts.crashes_and_failures).toBe(1);
    expect(profile.error_count).toBe(1);
    expect(profile.counts.freezes_and_anrs).toBe(0);
    expect(profile.counts.resource_pressure).toBe(0);
    expect(nativeWatchdogCategory({ type: 'android_ui_stall_recovered' })).toBe('diagnostics');
  });

  it('does not restamp retained native events as this launch or build', () => {
    const current = getCurrentDiagnosticsAttribution();
    expect(nativeEventAttribution({ sessionId: 'native-now', buildScopeId: current.buildScopeId }).sessionId).toBe('native-now');
    const old = nativeEventAttribution({ sessionId: 'native-old', buildScopeId: 'old-build' });
    expect(old.sessionId).toBe('native-old');
    const legacy = recordHistoricalAppExperienceEvent({ ...nativeEventAttribution({}), operation: 'legacy_native_failure', severity: 'error' });
    expect(legacy.sessionId).toBe('');
    expect(legacy.buildScopeId).toBe('');
    const report = buildAppExperienceReport({ systemEvents: [legacy] });
    expect(report.activity.counts.crashes_and_failures).toBe(0);
    expect(report.evidence_scopes.older_history.activity.counts.crashes_and_failures).toBe(1);
  });

  it('separates current session, same-build prior session, and older-build evidence', () => {
    const current = getCurrentDiagnosticsAttribution();
    const report = buildAppExperienceReport({
      systemEvents: [
        { timestamp: '2026-09-18T10:00:00Z', severity: 'info', operation: 'current_ok', sessionId: current.sessionId, buildScopeId: current.buildScopeId },
        { timestamp: '2026-09-18T10:01:00Z', severity: 'error', category: 'failure', operation: 'same_build_failure', sessionId: 'prior-launch', buildScopeId: current.buildScopeId },
        { timestamp: '2026-09-18T10:02:00Z', severity: 'error', category: 'failure', operation: 'old_build_failure', sessionId: 'old-launch', buildScopeId: 'old-build' },
      ],
      performanceEntries: [
        { name: 'current', durationMs: 5, at: '2026-09-18T10:00:00Z', sessionId: current.sessionId, buildScopeId: current.buildScopeId },
        { name: 'same-build', durationMs: 10, at: '2026-09-18T10:01:00Z', sessionId: 'prior-launch', buildScopeId: current.buildScopeId },
        { name: 'old-build', durationMs: 2000, at: '2026-09-18T10:02:00Z', sessionId: 'old-launch', buildScopeId: 'old-build' },
      ],
    });
    expect(report.activity.counts.crashes_and_failures).toBe(0);
    expect(report.evidence_scopes.current_build.activity.counts.crashes_and_failures).toBe(1);
    expect(report.evidence_scopes.older_history.activity.counts.crashes_and_failures).toBe(1);
    expect(report.performance.sample_count).toBe(1);
    expect(report.evidence_scopes.current_build.performance.sample_count).toBe(2);
    expect(report.health.status).toBe('good');
  });

  it('exports Android version, variant, artifact identity, platform, and web hash separately', () => {
    const report = buildAppExperienceReport({
      buildInfo: { buildHash: 'a'.repeat(64), algorithm: 'sha256-bundle-normalized-v1', sourceId: 'source-id' },
      nativeDiagnostics: {
        runtime: {
          platform: 'android', nativeBridgeAvailable: true, probeState: 'success',
          build: { versionName: '1.1.0', versionCode: 3, flavor: 'physicalH', buildType: 'debug', sourceId: 'source-id', artifactId: 'artifact-id' },
        },
        watchdog: {}, serviceEnabled: false, tripAuthority: 'native',
      },
    });
    expect(report.app).toMatchObject({
      version_name: '1.1.0', version_code: 3, platform: 'android',
      build_variant: 'physicalH:debug', artifact_id: 'artifact-id',
      web_bundle_hash: 'a'.repeat(64),
    });
    expect(report.runtime).toMatchObject({ trip_authority: 'native', native_bridge_state: 'available' });
    const imported = parseAppExperienceReport(JSON.stringify(report));
    expect(imported.app.artifact_id).toBe('artifact-id');
    expect(imported.attribution.current_build_scope_id).toBe('artifact-id');
    expect(imported.runtime.native_bridge_state).toBe('available');
    expect(imported.runtime.tracking_service_state).toBe('disabled');
  });

  it('keeps browser, failed probe, disabled service, and available watchdog states distinct', () => {
    expect(buildRuntimeProfile({ runtime: { platform: 'web', nativeBridgeAvailable: false, probeState: 'not_applicable' }, watchdog: null }).native_bridge_state).toBe('not_applicable');
    expect(buildRuntimeProfile({ runtime: { platform: 'android', nativeBridgeAvailable: null, probeState: 'failed' }, watchdog: null }).probe_state).toBe('failed');
    const disabled = buildRuntimeProfile({ runtime: { platform: 'android', nativeBridgeAvailable: true, probeState: 'success' }, serviceEnabled: false, watchdog: {} });
    expect(disabled.native_bridge_state).toBe('available');
    expect(disabled.tracking_service_state).toBe('disabled');
    expect(disabled.watchdog_state).toBe('available');
    expect(classifyNativeDiagnosticsProbeFailure(new Error('Plugin not implemented')).nativeBridgeAvailable).toBe(false);
    expect(classifyNativeDiagnosticsProbeFailure(new Error('probe timed out')).nativeBridgeAvailable).toBeNull();
    expect(classifyNativeDiagnosticsProbeFailure(new Error('Diagnostics result unavailable')).nativeBridgeAvailable).toBeNull();
    expect(classifyNativeDiagnosticsProbeFailure({ code: 'UNIMPLEMENTED' }).nativeBridgeAvailable).toBe(false);
  });

  it('strictly allowlists campaign state and excludes private or raw failure material', () => {
    const safe = sanitizeCampaignExport({
      authority: { trip: 'native', generation: 'g1', revision: 2, snapshot_state: 'available', tripId: 'secret-trip' },
      archive_recovery: { state: 'HEALTHY', sentinel_matches: true, route: [{ lat: 43.1 }] },
      migration: { state: 'COMPLETE', rawPayload: 'secret' },
      active_capture: { state: 'recording', service_enabled: true, trip_id: 'secret-trip' },
      backup_restore: { state: 'idle', detail: 'bounded', path: 'private/path' },
      key_rotation: { state: 'ok', active_key_version: 4, keyMaterial: 'secret' },
      coordinator: { backlog: 0, crashStack: 'secret stack' },
      derived_readiness: {}, road_speed: {}, projection_detail: {}, background_enrichment: {},
    });
    const exported = JSON.stringify(safe);
    expect(exported).not.toContain('secret-trip');
    expect(exported).not.toContain('43.1');
    expect(exported).not.toContain('private/path');
    expect(exported).not.toContain('keyMaterial');
    expect(exported).not.toContain('secret stack');
  });
});
