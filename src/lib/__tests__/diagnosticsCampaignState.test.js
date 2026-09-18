import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const owners = vi.hoisted(() => ({
  native: {
    diagnosticsReadiness: vi.fn(), diagnosticsHealth: vi.fn(), migrationCheckpoint: vi.fn(),
    speedState: vi.fn(), envelopeKekRotationStatus: vi.fn(),
  },
  browserReadiness: vi.fn(), coordinator: vi.fn(), key: vi.fn(), log: vi.fn(), projection: vi.fn(),
}));
vi.mock('@/lib/nativeTripArchive', () => ({ nativeTripArchive: owners.native }));
vi.mock('@/lib/p6TripDerivedState', () => ({ readP6TripDomainReadiness: owners.browserReadiness }));
vi.mock('@/lib/appLifecycleWork', () => ({ getP4WorkCoordinator: () => ({ getCoordinatorSnapshot: owners.coordinator }) }));
vi.mock('@/lib/securePayloadCrypto', () => ({ getActiveEncryptionKeyVersion: owners.key }));
vi.mock('@/lib/keyRotationManager', () => ({ loadRotationLog: owners.log }));
vi.mock('@/lib/localTripRepository', () => ({ readNativeProjectionState: owners.projection }));

import { collectDiagnosticsCampaignState, sanitizeCampaignState } from '@/lib/diagnosticsCampaignState';

describe('bounded Diagnostics campaign owner snapshot', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    owners.native.diagnosticsReadiness.mockResolvedValue({ D2_GEOMETRY: { domain: 'D2_GEOMETRY', state: 'PARTIAL', complete: false, required_version: 12, applied_version: 8 } });
    owners.native.diagnosticsHealth.mockResolvedValue({ recoveryState: 'HEALTHY', sentinelMatches: true, liveCount: 10000, pendingCount: 0 });
    owners.native.migrationCheckpoint.mockResolvedValue({ phase: 'VERIFIED' });
    owners.native.speedState.mockResolvedValue({ recoveryState: 'HEALTHY', bucketCount: 4, totalItemCount: 20 });
    owners.native.envelopeKekRotationStatus.mockResolvedValue({ phase: 'REWRAPPING' });
    owners.browserReadiness.mockResolvedValue({ state: 'VERIFIED', complete: true });
    owners.coordinator.mockReturnValue({ registeredJobs: 4, backlog: 0, sleepingInstances: 0 });
    owners.key.mockResolvedValue(4);
    owners.log.mockResolvedValue([]);
    owners.projection.mockResolvedValue(null);
  });

  it('uses native control status, never browser manifests, for native authority', async () => {
    const snapshot = await collectDiagnosticsCampaignState({ authority: 'native' });
    expect(owners.browserReadiness).not.toHaveBeenCalled();
    expect(owners.native.diagnosticsReadiness).toHaveBeenCalledTimes(1);
    expect(snapshot.derived_readiness.geometry).toMatchObject({ state: 'PARTIAL', complete: false, required_version: 12, applied_version: 8 });
    expect(snapshot.key_rotation.native_phase).toBe('REWRAPPING');
    expect(snapshot.key_rotation.pending_count).toBeNull();
  });

  it('reads four browser status records and no native archive for browser authority', async () => {
    const snapshot = await collectDiagnosticsCampaignState({ authority: 'browser' });
    expect(owners.browserReadiness).toHaveBeenCalledTimes(4);
    expect(owners.native.diagnosticsHealth).not.toHaveBeenCalled();
    expect(snapshot.archive_recovery.state).toBe('not_applicable_browser_authority');
  });

  it('never converts missing probe data into successful false/zero/idle evidence', async () => {
    owners.native.diagnosticsHealth.mockRejectedValue(new Error('private raw failure'));
    owners.native.diagnosticsReadiness.mockRejectedValue(new Error('private raw failure'));
    const snapshot = await collectDiagnosticsCampaignState({ authority: 'native' });
    expect(snapshot.archive_recovery.sentinel_matches).toBeNull();
    expect(snapshot.archive_recovery.live_record_count).toBeNull();
    expect(snapshot.derived_readiness.geometry.complete).toBeNull();
    expect(snapshot.active_capture.state).toBe('unavailable');
    expect(JSON.stringify(snapshot)).not.toContain('private raw failure');
    expect(sanitizeCampaignState({}).background_enrichment.state).toBe('unavailable');
  });

  it('native status acquisition is four primary-key control reads, with no archive scan or route materialization', () => {
    const source = readFileSync(path.join(process.cwd(), 'android/app/src/main/java/com/drivesense/app/DriveSenseP6DerivedState.java'), 'utf8');
    const method = source.split('static JSONObject diagnosticsReadiness')[1].split('static void requireDerivedAdmission')[0];
    expect(method).toContain('FROM p6_control WHERE domain_id=?');
    expect(method).not.toMatch(/COUNT\(|SELECT \*|route_points|decrypt|p6_manifests|coordinator\.write/);
    expect(method.match(/D[1-4]_[A-Z_]+/g)).toHaveLength(4);
  });

  it('distinguishes projection convergence without claiming detail routes were inspected', () => {
    const raw = { authority: 'native', archiveHealth: { archiveGeneration: 'g', projectionRequiredSeq: 12 }, projection: { generation: 'g', mode: 'catchup', afterSeq: 12 } };
    expect(sanitizeCampaignState(raw).projection_detail).toMatchObject({ state: 'converged', complete: true, detail_representation: 'not_inspected' });
    expect(sanitizeCampaignState({ ...raw, projection: { ...raw.projection, afterSeq: 8 } }).projection_detail.complete).toBe(false);
    expect(sanitizeCampaignState({ ...raw, projection: null }).projection_detail.complete).toBeNull();
  });
});
