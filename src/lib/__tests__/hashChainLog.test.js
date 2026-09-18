import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditTestRuntime } from './helpers/privacyAuditRuntime';
import { AUDIT_FORMAT_KEY } from '@/lib/privacyAuditFormat';
import {
  appendPrivacyEvent,
  exportAuditCheckpoint,
  LAST_CHECKPOINT_EXPORT_KEY,
  loadPrivacyAuditChain,
  PRIVACY_AUDIT_ANCHOR_KEY,
  PRIVACY_AUDIT_CHAIN_KEY,
  verifyChain,
  verifyCheckpoint,
} from '@/lib/hashChainLog';

const storage = new Map();

const bytesToBase64 = (bytes) => Buffer.from(bytes).toString('base64');

const rawEcdsaToDer = (rawSignature) => {
  const integerBytes = (value) => {
    let offset = 0;
    while (offset < value.length - 1 && value[offset] === 0) offset += 1;
    const trimmed = value.slice(offset);
    return trimmed[0] & 0x80 ? Uint8Array.from([0, ...trimmed]) : trimmed;
  };
  const raw = new Uint8Array(rawSignature);
  const r = integerBytes(raw.slice(0, 32));
  const s = integerBytes(raw.slice(32, 64));
  return Uint8Array.from([
    0x30,
    4 + r.length + s.length,
    0x02,
    r.length,
    ...r,
    0x02,
    s.length,
    ...s,
  ]);
};

async function signedCheckpoint(checkpoint) {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const signature = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    new TextEncoder().encode(checkpoint.tip_hash)
  );
  const publicKey = await globalThis.crypto.subtle.exportKey('spki', keyPair.publicKey);
  return {
    ...checkpoint,
    signature: bytesToBase64(rawEcdsaToDer(signature)),
    signing_pubkey: bytesToBase64(new Uint8Array(publicKey)),
  };
}

describe('hashChainLog', () => {
  beforeEach(() => {
    storage.clear();
    // These retained tests exercise v1 compatibility and its original tamper
    // semantics, not fresh-v2 initialization. New v2 tests use persistent IDB.
    storage.set(AUDIT_FORMAT_KEY, JSON.stringify({ state: 'LEGACY_AUDIT_UNKNOWN' }));
    vi.stubGlobal('navigator', { locks: createAuditTestRuntime().locks });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => storage.get(key) ?? null),
      setItem: vi.fn((key, value) => storage.set(key, value)),
      removeItem: vi.fn((key) => storage.delete(key)),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('appends privacy events and verifies the chain tip', async () => {
    const first = await appendPrivacyEvent({
      op: 'POINTS_SUPPRESSED',
      hiddenCount: 3,
      details: { point_count: 8, hidden_point_count: 3 },
    });
    const second = await appendPrivacyEvent({
      op: 'ZONE_SAVED',
      zoneId: 'home',
      zoneLabel: 'Home',
      details: { zone_count: 1 },
    });

    const result = await verifyChain();
    const anchor = JSON.parse(storage.get(PRIVACY_AUDIT_ANCHOR_KEY));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(result).toMatchObject({ valid: true, length: 2, tip: second.hash });
    expect(anchor).toMatchObject({ length: 2, tip: second.hash });
  });

  it('serializes concurrent delivery of one native privacy receipt exactly once', async () => {
    const receipt = {
      op: 'RAW_GPS_AUTO_PURGED',
      operationId: 'native-retention-operation-1',
      details: { purged_trip_count: 1, purged_point_count: 500 },
    };
    const [first, second, third] = await Promise.all([
      appendPrivacyEvent(receipt),
      appendPrivacyEvent(receipt),
      appendPrivacyEvent(receipt),
    ]);
    expect(first.hash).toBe(second.hash);
    expect(second.hash).toBe(third.hash);
    const chain = await loadPrivacyAuditChain();
    expect(chain).toHaveLength(1);
    expect(chain[0].operation_id).toBe(receipt.operationId);
    expect(await verifyChain()).toMatchObject({ valid: true, length: 1 });
  });

  it('detects modified audit entry content', async () => {
    await appendPrivacyEvent({ op: 'EVENTS_SUPPRESSED', hiddenCount: 1 });
    const chain = JSON.parse(storage.get(PRIVACY_AUDIT_CHAIN_KEY));
    chain[0].hidden_count = 9;
    storage.set(PRIVACY_AUDIT_CHAIN_KEY, JSON.stringify(chain));

    const result = await verifyChain();

    expect(result).toMatchObject({
      valid: false,
      brokenAt: 0,
      reason: 'Content hash mismatch at seq 1',
    });
  });

  it('detects tail deletion through the persisted anchor', async () => {
    await appendPrivacyEvent({ op: 'POINTS_SUPPRESSED', hiddenCount: 2 });
    await appendPrivacyEvent({ op: 'EVENTS_SUPPRESSED', hiddenCount: 1 });
    const chain = JSON.parse(storage.get(PRIVACY_AUDIT_CHAIN_KEY));
    storage.set(PRIVACY_AUDIT_CHAIN_KEY, JSON.stringify(chain.slice(0, 1)));

    const result = await verifyChain();

    expect(result).toMatchObject({
      valid: false,
      brokenAt: 1,
      reason: 'Audit log length does not match the stored tip anchor.',
    });
  });

  it('does not store coordinates or radius details in audit entries', async () => {
    await appendPrivacyEvent({
      op: 'ZONE_SAVED',
      zoneId: 'home',
      zoneLabel: 'Home',
      hiddenCount: 1,
      details: {
        lat: 43.65,
        lng: -79.38,
        radius_m: 150,
        hidden_point_count: 1,
        reason: 'privacy_zone_changed',
      },
    });

    const [entry] = await loadPrivacyAuditChain();
    const serialized = JSON.stringify(entry);

    expect(entry.details).toEqual({
      hidden_point_count: 1,
      reason: 'privacy_zone_changed',
    });
    expect(serialized).not.toContain('43.65');
    expect(serialized).not.toContain('-79.38');
    expect(serialized).not.toContain('radius_m');
  });

  it('exports and verifies an unsigned checkpoint on web without treating it as invalid', async () => {
    // Checklist: "Export an audit checkpoint, change nothing, verify it successfully."
    // Checklist: "Confirm a signed Android checkpoint reports a verified signature and an unsigned web checkpoint is labeled unsigned rather than invalid."
    await appendPrivacyEvent({ op: 'ZONE_SAVED' });
    const checkpoint = await exportAuditCheckpoint();
    expect(checkpoint).toMatchObject({
      schema: 'ds_audit_checkpoint_v1',
      seq: 1,
      signature: null,
      signing_pubkey: null,
    });
    expect(storage.get(LAST_CHECKPOINT_EXPORT_KEY)).toBe(String(checkpoint.exported_at));
    await expect(verifyCheckpoint(checkpoint)).resolves.toMatchObject({
      valid: true,
      signatureStatus: 'unsigned',
    });
  });

  it('verifies a cryptographically signed checkpoint', async () => {
    // Checklist: "Confirm a signed Android checkpoint reports a verified signature and an unsigned web checkpoint is labeled unsigned rather than invalid."
    await appendPrivacyEvent({ op: 'ZONE_SAVED' });
    const checkpoint = await signedCheckpoint(await exportAuditCheckpoint());

    await expect(verifyCheckpoint(checkpoint)).resolves.toMatchObject({
      valid: true,
      signatureStatus: 'verified',
    });
  });

  it('rejects a tampered checkpoint signature', async () => {
    await appendPrivacyEvent({ op: 'ZONE_SAVED' });
    const checkpoint = await signedCheckpoint(await exportAuditCheckpoint());
    const tampered = Buffer.from(checkpoint.signature, 'base64');
    tampered[tampered.length - 1] ^= 0x01;

    await expect(verifyCheckpoint({
      ...checkpoint,
      signature: tampered.toString('base64'),
    })).resolves.toMatchObject({
      valid: false,
      signatureStatus: 'invalid',
      reason: 'Checkpoint signature is invalid',
    });
  });

  it('rejects checkpoint verification when current history was modified', async () => {
    // Checklist: "Tamper with audit storage in devtools and confirm chain verification fails."
    await appendPrivacyEvent({ op: 'ZONE_SAVED' });
    const checkpoint = await exportAuditCheckpoint();
    const chain = JSON.parse(storage.get(PRIVACY_AUDIT_CHAIN_KEY));
    chain[0].op = 'ZONE_DELETED';
    storage.set(PRIVACY_AUDIT_CHAIN_KEY, JSON.stringify(chain));
    await expect(verifyCheckpoint(checkpoint)).resolves.toMatchObject({ valid: false });
  });

  it('refuses to export an empty audit chain', async () => {
    await expect(exportAuditCheckpoint()).rejects.toThrow('Audit chain is empty');
  });

  it('P5 F05 blocker evidence: even ONE receipt performs whole-ledger I/O and verification at L=0/100/1000', async () => {
    const snapshots = new Map([[0, new Map(storage)]]);
    for (let index = 1; index <= 1000; index += 1) {
      await appendPrivacyEvent({ op: 'RAW_GPS_AUTO_PURGED', operationId: `seed-${index}`,
        details: { purged_trip_count: 1, purged_point_count: 10 } });
      if (index === 100 || index === 1000) snapshots.set(index, new Map(storage));
    }
    const actualDigest = crypto.subtle.digest.bind(crypto.subtle);
    const measurements = [];
    try {
      for (const [length, snapshot] of snapshots) {
        storage.clear();for (const [key, value] of snapshot) storage.set(key, value);
        let hashBytes = 0;let hashes = 0;
        const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, bytes) => {
          hashes += 1;hashBytes += bytes.byteLength;return actualDigest(algorithm, bytes);
        });
        localStorage.getItem.mockClear();localStorage.setItem.mockClear();
        const event = { op: 'RAW_GPS_AUTO_PURGED', operationId: 'f05-measured-receipt',
          details: { purged_trip_count: 1, purged_point_count: 10 } };
        await appendPrivacyEvent(event);
        const utf8 = (value) => new TextEncoder().encode(value || '').length;
        const readBytes = localStorage.getItem.mock.results.reduce((sum, result) => sum + utf8(result.value), 0);
        const writtenBytes = localStorage.setItem.mock.calls.reduce((sum, [, value]) => sum + utf8(value), 0);
        expect(hashes).toBe(length + 1);
        expect(localStorage.setItem.mock.calls.map(([key]) => key)).toEqual([PRIVACY_AUDIT_CHAIN_KEY, PRIVACY_AUDIT_ANCHOR_KEY]);
        measurements.push({ length, hashes, readBytes, hashBytes, writtenBytes });
        digest.mockRestore();
        await appendPrivacyEvent(event);
        expect((await loadPrivacyAuditChain()).filter((row) => row.operation_id === event.operationId)).toHaveLength(1);
      }
    } finally { vi.restoreAllMocks(); }
    expect(measurements[2].readBytes).toBeGreaterThan(measurements[1].readBytes * 8);
    expect(measurements[2].writtenBytes).toBeGreaterThan(measurements[1].writtenBytes * 8);
    expect(measurements[2].hashBytes).toBeGreaterThan(measurements[1].hashBytes * 8);
    process.stdout.write(`P5-IMPL-F05 observed boundary work (not a boundedness PASS): ${JSON.stringify(measurements)}\n`);
  }, 60000);
});
