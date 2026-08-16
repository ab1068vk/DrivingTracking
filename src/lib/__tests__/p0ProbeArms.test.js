import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLOCK_SUSPECT_THRESHOLD_MS,
  PAYLOAD_KINDS,
  isValidRunMarker,
  payloadKindForContext,
  safeLongTaskContainerType,
  safeLongTaskName,
  safeSecureMethod,
} from '@/lib/p0Schema';

const loadArms = async () => {
  vi.resetModules();
  return import('@/lib/p0ProbeArms');
};

const setDebugBuild = (enabled) => {
  vi.stubEnv('VITE_SHOW_DEBUG_ROUTES', enabled ? 'true' : 'false');
  vi.stubEnv('DEV', enabled ? 'true' : '');
};

/** @type {Map<string, string>} */
let storage;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('p0 arm gating', () => {
  it('hard-returns arm A in a release build no matter what storage says', async () => {
    setDebugBuild(false);
    storage.set('roadsage_p0_arm', 'B');
    const arms = await loadArms();

    expect(arms.isP0DebugBuild()).toBe(false);
    expect(arms.resolveP0Arm()).toBe('A');
    // The point of the gate: a release user can never disable diagnostics.
    expect(arms.suppressDiagnosticsPersistence()).toBe(false);
    expect(arms.suppressWatchdogCheckpoints()).toBe(false);
    expect(arms.isProbeEnabled()).toBe(false);
    expect(arms.setP0ArmForNextBoot('C')).toBe(false);
  });

  it('honours a stored arm in a debug build', async () => {
    setDebugBuild(true);
    storage.set('roadsage_p0_arm', 'b');
    const arms = await loadArms();

    expect(arms.resolveP0Arm()).toBe('B');
    expect(arms.suppressDiagnosticsPersistence()).toBe(true);
    expect(arms.suppressWatchdogCheckpoints()).toBe(false);
    expect(arms.isProbeEnabled()).toBe(true);
  });

  it('suppresses watchdog checkpoints only in arm C', async () => {
    setDebugBuild(true);
    storage.set('roadsage_p0_arm', 'C');
    const arms = await loadArms();

    expect(arms.suppressDiagnosticsPersistence()).toBe(true);
    expect(arms.suppressWatchdogCheckpoints()).toBe(true);
  });

  it('disables the probe in arm D while leaving production behaviour on', async () => {
    setDebugBuild(true);
    storage.set('roadsage_p0_arm', 'D');
    const arms = await loadArms();

    expect(arms.isProbeEnabled()).toBe(false);
    expect(arms.suppressDiagnosticsPersistence()).toBe(false);
    expect(arms.suppressWatchdogCheckpoints()).toBe(false);
  });

  it('falls back to A for an unknown arm value', async () => {
    setDebugBuild(true);
    storage.set('roadsage_p0_arm', 'Z');
    const arms = await loadArms();
    expect(arms.resolveP0Arm()).toBe('A');
  });

  it('freezes the arm for the process once resolved', async () => {
    setDebugBuild(true);
    storage.set('roadsage_p0_arm', 'B');
    const arms = await loadArms();
    expect(arms.resolveP0Arm()).toBe('B');

    // An arm change mid-run must not split the dataset.
    storage.set('roadsage_p0_arm', 'C');
    expect(arms.resolveP0Arm()).toBe('B');
    expect(arms.suppressWatchdogCheckpoints()).toBe(false);
  });

  it('stages an arm for the next boot without changing the running one', async () => {
    setDebugBuild(true);
    const arms = await loadArms();
    expect(arms.resolveP0Arm()).toBe('A');

    expect(arms.setP0ArmForNextBoot('C')).toBe(true);
    expect(localStorage.getItem('roadsage_p0_arm')).toBe('C');
    expect(arms.resolveP0Arm()).toBe('A');
    expect(arms.setP0ArmForNextBoot('nope')).toBe(false);
  });

  it('changes arm_config_id whenever the configuration changes', async () => {
    setDebugBuild(true);
    storage.set('roadsage_p0_arm', 'A');
    const armsA = await loadArms();
    const idA = armsA.p0ArmConfigId();

    storage.set('roadsage_p0_arm', 'B');
    const armsB = await loadArms();
    const idB = armsB.p0ArmConfigId();

    expect(idA).not.toBe(idB);
    expect(idA).toContain('A');
    expect(idB).toContain('nopersist');
  });
});

describe('p0 schema value guards', () => {
  it('accepts only strict experiment tokens as run markers', () => {
    expect(isValidRunMarker('boot-1000-arma')).toBe(true);
    expect(isValidRunMarker('a')).toBe(true);
    expect(isValidRunMarker('x'.repeat(64))).toBe(true);

    expect(isValidRunMarker('x'.repeat(65))).toBe(false);
    expect(isValidRunMarker('has space')).toBe(false);
    expect(isValidRunMarker('UPPER')).toBe(false);
    expect(isValidRunMarker('trip/42')).toBe(false);
    expect(isValidRunMarker('')).toBe(false);
    expect(isValidRunMarker(null)).toBe(false);
  });

  it('collapses unknown secure methods and long task metadata to fixed enums', () => {
    expect(safeSecureMethod('decryptSensitivePayload')).toBe('decryptSensitivePayload');
    expect(safeSecureMethod('somethingNew')).toBe('other');
    expect(safeSecureMethod(null)).toBe('other');

    expect(safeLongTaskName('same-origin')).toBe('same-origin');
    expect(safeLongTaskName('<div id="secret">')).toBe('unknown');
    expect(safeLongTaskContainerType('iframe')).toBe('iframe');
    expect(safeLongTaskContainerType('user-content')).toBe('unknown');
  });

  it('exposes a frozen clock-suspect threshold', () => {
    expect(CLOCK_SUSPECT_THRESHOLD_MS).toBe(250);
  });
});

describe('payload kind mapping', () => {
  it('maps every known context to its fixed enum', () => {
    expect(payloadKindForContext('trip-summary:abc123')).toBe('trip_summary');
    expect(payloadKindForContext('trip:abc123')).toBe('trip_detail');
    expect(payloadKindForContext('storage:drivesense_active_trip')).toBe('active_trip');
    expect(payloadKindForContext('storage:drivesense_speed_geometry_index_v1')).toBe('speed_geometry');
    expect(payloadKindForContext('storage:speed_knowledge_v1')).toBe('speed_knowledge');
    expect(payloadKindForContext('storage:speed_knowledge_native_mirror_v1')).toBe('speed_knowledge');
    expect(payloadKindForContext('indexeddb:drivesense_speed_knowledge/knowledge:speed_knowledge_v1'))
      .toBe('speed_knowledge');
    expect(payloadKindForContext('native:privacy_zones_v1')).toBe('privacy');
    expect(payloadKindForContext('privacy-intelligence:self-test')).toBe('privacy');
  });

  it('falls back to other and never echoes the raw context', () => {
    expect(payloadKindForContext('storage:some_future_key')).toBe('other');
    expect(payloadKindForContext('drivesense')).toBe('other');
    expect(payloadKindForContext('')).toBe('other');
    expect(payloadKindForContext(null)).toBe('other');
    expect(payloadKindForContext(undefined)).toBe('other');

    // Every result is a member of the frozen enum, so a trip id embedded in the
    // context can never reach an export.
    const contexts = [
      'trip:00000000-1111-2222-3333-444444444444',
      'trip-summary:00000000-1111-2222-3333-444444444444',
      'storage:drivesense_trips',
      'unexpected:51.5074,-0.1278',
    ];
    contexts.forEach((context) => {
      expect(PAYLOAD_KINDS).toContain(payloadKindForContext(context));
    });
  });
});

describe('mirrored storage-key literals stay pinned to their owning modules', () => {
  it('matches the real exported constants', async () => {
    // p0Schema deliberately does not import these modules (it must not drag them
    // into the probe's startup graph). This test is what stops the mirrored
    // literals from drifting.
    const { ACTIVE_TRIP_KEY } = await import('@/lib/trackingStore');
    const { SPEED_GEOMETRY_INDEX_KEY } = await import('@/lib/speedGeometryIndex');
    const {
      SPEED_KNOWLEDGE_STORAGE_KEY,
      SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      SPEED_KNOWLEDGE_DB_NAME,
    } = await import('@/lib/speedKnowledgeRepository');
    const { NATIVE_PRIVACY_ZONES_CONTEXT } = await import('@/lib/privacyZones');

    expect(payloadKindForContext(`storage:${ACTIVE_TRIP_KEY}`)).toBe('active_trip');
    expect(payloadKindForContext(`storage:${SPEED_GEOMETRY_INDEX_KEY}`)).toBe('speed_geometry');
    expect(payloadKindForContext(`storage:${SPEED_KNOWLEDGE_STORAGE_KEY}`)).toBe('speed_knowledge');
    expect(payloadKindForContext(`storage:${SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY}`)).toBe('speed_knowledge');
    expect(payloadKindForContext(`indexeddb:${SPEED_KNOWLEDGE_DB_NAME}/knowledge:x`)).toBe('speed_knowledge');
    expect(payloadKindForContext(NATIVE_PRIVACY_ZONES_CONTEXT)).toBe('privacy');
  });
});
