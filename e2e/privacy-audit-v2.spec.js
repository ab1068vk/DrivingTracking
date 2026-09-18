import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = `/e2e-privacy-audit-${process.pid}.js`;
test.beforeAll(async () => {
  const result = await build({ entryPoints: [path.join(ROOT, 'e2e/fixtures/privacy-audit-entry.js')],
    bundle: true, format: 'iife', platform: 'browser', write: false, alias: { '@': path.join(ROOT, 'src') },
    define: { 'import.meta.env': JSON.stringify({ MODE: 'test', PROD: true, DEV: false, VITE_P35_NATIVE_AUTHORITY: 'false' }) }, logLevel: 'silent' });
  const target = path.join(ROOT, 'dist', URL.slice(1)); const staging = `${target}.${process.pid}.tmp`;
  await writeFile(staging, result.outputFiles[0].text); await rename(staging, target);
});
async function load(page) {
  await page.route('**/audit-test.html', (route) => route.fulfill({ contentType: 'text/html', body: '<html><body>Audit owner conformance</body></html>' }));
  await page.goto('/audit-test.html'); await page.addScriptTag({ url: URL });
}
test.beforeEach(async ({ page }) => load(page));

for (const length of [0, 100, 1000, 5000]) test(`V7/V25/V26 real IDB append accounting and exact conversion at L=${length}`, async ({ page }) => {
  test.setTimeout(120000);
  const result = await page.evaluate(async (length) => {
    const { audit, seedLegacy, observe } = globalThis.__privacyAudit;
    const before = await seedLegacy(length);
    await audit.runPrivacyAuditCompatibilityUpgrade();
    const after = await audit.loadPrivacyAuditChain();
    const event = { op: 'RAW_GPS_AUTO_PURGED', operationId: 'f05-receipt', timestamp: 100, details: { purged_trip_count: 1 } };
    const samples = [];
    for (let i = 0; i < 2; i += 1) {
      const measurement = observe(); const outcome = await audit.appendPrivacyEventBounded(event); measurement.stop();
      samples.push({ outcome, actual: measurement.totals });
    }
    const duplicate = length ? await audit.appendPrivacyEventBounded({ operationId: 'legacy-duplicate' }) : null;
    const checkpoint = await audit.exportAuditCheckpoint();
    return { exact: JSON.stringify(before) === JSON.stringify(after), samples, duplicate, checkpoint, checkpointProof: await audit.verifyCheckpoint(checkpoint),
      verified: await audit.verifyChain() };
  }, length);
  expect(result.exact).toBe(true); expect(result.verified).toMatchObject({ valid: true, length: length + 1 });
  for (const { outcome, actual } of result.samples) {
    expect(outcome.state).toBe('READY'); expect(outcome.itemsWorked).toBe(actual.itemsWorked);
    expect(outcome.bytesWorked).toBe(actual.bytesWorked);
    expect(actual).toMatchObject({ itemsWorked: 8, historicalReads: 0, legacy: 0 });
    expect(actual.writes).toBeLessThanOrEqual(3); expect(actual.bytesWorked).toBeLessThanOrEqual(256 * 1024);
  }
  expect(result.samples.map(({ outcome }) => outcome.appended)).toEqual([true, false]);
  if (length) expect(result.duplicate).toMatchObject({ seq: 1, appended: false });
  expect(result.checkpoint.signature).toBeNull(); expect(result.checkpoint.signing_pubkey).toBeNull();
  expect(result.checkpointProof).toMatchObject({ valid: true, signatureStatus: 'unsigned' });
});

test('V7 real transactions abort every partial write; renderer restart dedupes committed debt', async ({ page, context }) => {
  const faultResults = await page.evaluate(async () => {
    const { audit } = globalThis.__privacyAudit; await audit.initializePrivacyAudit();
    const results = [];
    for (const [store, method] of [['entries', 'add'], ['operationIds', 'add'], ['meta', 'put']]) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (...args) {
        const result = original.apply(this, args);
        if (this.name === store) this.transaction.abort(); return result;
      };
      const failed = await audit.appendPrivacyEventBounded({ op: 'RAW_GPS_AUTO_PURGED', operationId: `abort-${store}` });
      IDBObjectStore.prototype[method] = original;
      results.push({ failed, verified: await audit.verifyChain() });
    }
    await audit.appendPrivacyEventBounded({ op: 'RAW_GPS_AUTO_PURGED', operationId: 'owed' }, { afterCommit: () => { throw Error('ACK lost'); } });
    return results;
  });
  for (const result of faultResults) { expect(result.failed.state).not.toBe('READY'); expect(result.verified).toMatchObject({ valid: true, length: 0 }); }
  await page.close(); const reopened = await context.newPage(); await load(reopened);
  const outcome = await reopened.evaluate(async () => {
    const { audit, db } = globalThis.__privacyAudit; const opened = await db();
    const key = await new Promise((resolve) => { const r = opened.transaction('meta').objectStore('meta').getAll(); r.onsuccess = () => resolve(r.result.find((row) => row.key)?.key); }); opened.close();
    let exported = false; try { await crypto.subtle.exportKey('raw', key); exported = true; } catch { /* required */ }
    return { exported, result: await audit.appendPrivacyEventBounded({ operationId: 'owed' }), proof: await audit.verifyChain() };
  });
  expect(outcome.exported).toBe(false); expect(outcome.result).toMatchObject({ appended: false, seq: 1 });
  expect(outcome.proof).toMatchObject({ valid: true, length: 1 });
});

test('V7/V26 real cross-context lock, post-READY fence recovery, corruption and loss fail closed', async ({ page, context }) => {
  await page.evaluate(async () => {
    const { audit, seedLegacy } = globalThis.__privacyAudit; await seedLegacy(100);
    try { await audit.runPrivacyAuditCompatibilityUpgrade({ onProgress: ({ phase }) => { if (phase === 'ready') throw Error('death before fence'); } }); } catch { /* injected process boundary */ }
  });
  await page.reload(); await page.addScriptTag({ url: URL });
  expect(await page.evaluate(async () => globalThis.__privacyAudit.audit.initializePrivacyAudit())).toMatchObject({ state: 'READY' });
  const other = await context.newPage(); await load(other);
  await other.evaluate(() => { globalThis.lockEntered = false; navigator.locks.request('drivesense-privacy-audit-owner', async () => { globalThis.lockEntered = true; await new Promise((r) => { globalThis.releaseAudit = r; }); }); });
  await expect.poll(() => other.evaluate(() => globalThis.lockEntered)).toBe(true);
  expect(await page.evaluate(() => globalThis.__privacyAudit.audit.appendPrivacyEventBounded({ operationId: 'busy' }))).toMatchObject({ state: 'AUDIT_BUSY', itemsWorked: 0 });
  await other.evaluate(() => globalThis.releaseAudit()); await other.close();
  const result = await page.evaluate(async () => {
    const { audit, mutate } = globalThis.__privacyAudit;
    const checkpoint = await audit.exportAuditCheckpoint();
    await mutate((tx) => { const s = tx.objectStore('entries'); const r = s.getAll(); r.onsuccess = () => { const row = r.result[0]; row.event.op = 'TAMPER'; s.put(row); }; });
    const appended = await audit.appendPrivacyEventBounded({ operationId: 'suffix', op: 'RAW_GPS_AUTO_PURGED' });
    const proof = await audit.verifyChain(); const check = await audit.verifyCheckpoint(checkpoint);
    let exportFailed = false; try { await audit.exportAuditCheckpoint(); } catch { exportFailed = true; }
    await new Promise((resolve) => { indexedDB.deleteDatabase('drivesense_privacy_audit_v2').onsuccess = resolve; });
    return { appended, proof, check, exportFailed, lost: await audit.appendPrivacyEventBounded({ operationId: 'lost' }) };
  });
  expect(result.appended.state).toBe('READY'); expect(result.proof.valid).toBe(false); expect(result.check.valid).toBe(false);
  expect(result.exportFailed).toBe(true); expect(result.lost.state).toBe('AUDIT_STORAGE_LOST');
});

test('V24 real data-rights orchestration erases local audit only, with durable ERASING across restart', async ({ page }) => {
  await page.evaluate(async () => {
    const { audit } = globalThis.__privacyAudit;
    await audit.initializePrivacyAudit(); await audit.appendPrivacyEventBounded({ operationId: 'old', op: 'RAW_GPS_AUTO_PURGED' });
    await audit.beginPrivacyAuditErasure();
  });
  await page.reload(); await page.addScriptTag({ url: URL });
  const result = await page.evaluate(async () => {
    const { audit, eraseAllLocalDataAndBuildReceipt, buildDataPortabilityExport, db } = globalThis.__privacyAudit;
    const blocked = await audit.appendPrivacyEventBounded({ operationId: 'old' });
    const erased = await eraseAllLocalDataAndBuildReceipt();
    const fence = JSON.parse(localStorage.getItem(audit.AUDIT_FORMAT_KEY));
    const opened = await db(); const rows = await new Promise((resolve) => { const r = opened.transaction('meta').objectStore('meta').getAll(); r.onsuccess = () => resolve(r.result); }); opened.close();
    await audit.initializePrivacyAudit();
    const resumedDebt = await audit.appendPrivacyEventBounded({ operationId: 'native-pending', op: 'RAW_GPS_AUTO_PURGED', details: { purged_trip_count: 1 } });
    const exported = await buildDataPortabilityExport({ trips: [], vehicles: [], settings: {}, privacyZones: [], scoreHistory: [] });
    return { blocked, erased: erased.erasureComplete, fence, rows, resumedDebt, proof: await audit.verifyChain(), exported: JSON.stringify(exported) };
  });
  expect(result.blocked.state).toBe('AUDIT_ERASING'); expect(result.erased).toBe(true);
  expect(result.fence.state).toBe('FRESH_PENDING'); expect(result.rows).toEqual([]);
  expect(result.resumedDebt).toMatchObject({ state: 'READY', seq: 1 }); expect(result.proof).toMatchObject({ valid: true, length: 1 });
  expect(result.exported).not.toContain('native-pending'); expect(result.exported).not.toContain('headMac');
});

test('V26 explicit conversion faults retain one authority at every pre/post READY boundary', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { audit, seedLegacy } = globalThis.__privacyAudit;
    const results = [];
    for (const boundary of ['reading', 'staging', 'verified', 'ready', 'readyTransaction', 'fence']) {
      await new Promise((resolve) => { indexedDB.deleteDatabase('drivesense_privacy_audit_v2').onsuccess = resolve; });
      localStorage.clear(); const original = await seedLegacy(100);
      const oldPut = IDBObjectStore.prototype.put; const oldSet = Storage.prototype.setItem;
      IDBObjectStore.prototype.put = function (value, ...args) {
        const req = oldPut.call(this, value, ...args);
        if (boundary === 'readyTransaction' && this.name === 'meta' && value.state === 'READY') this.transaction.abort();
        return req;
      };
      Storage.prototype.setItem = function (key, value) {
        if (boundary === 'fence' && key === audit.AUDIT_FORMAT_KEY && JSON.parse(value).state === 'V2') throw Error('fence write fault');
        return oldSet.call(this, key, value);
      };
      try { await audit.runPrivacyAuditCompatibilityUpgrade({ onProgress: ({ phase }) => { if (phase === boundary) throw Error('conversion death'); } }); } catch { /* injected */ }
      IDBObjectStore.prototype.put = oldPut; Storage.prototype.setItem = oldSet;
      const selected = await audit.loadPrivacyAuditChain();
      const readiness = await audit.getPrivacyAuditReadiness();
      const beforeAppend = await audit.appendPrivacyEventBounded({ operationId: 'before-fence' });
      await audit.runPrivacyAuditCompatibilityUpgrade();
      const after = await audit.loadPrivacyAuditChain();
      results.push({ boundary, exact: JSON.stringify(original) === JSON.stringify(selected) && JSON.stringify(original) === JSON.stringify(after), readiness, beforeAppend });
    }
    return results;
  });
  for (const item of result) {
    expect(item.exact, item.boundary).toBe(true);
    expect(item.beforeAppend.state).toBe('CONVERSION_REQUIRED');
    expect(item.readiness.state).toBe(['ready', 'fence'].includes(item.boundary) ? 'FENCE_PENDING' : 'CONVERSION_REQUIRED');
  }
});

test('V25 real J1 composition independently measures ledger work and native receipt boundaries at all L', async ({ page }) => {
  test.setTimeout(120000);
  const samples = await page.evaluate(async () => {
    const { audit, seedLegacy, observe, createP5RawGpsRetentionAdapter } = globalThis.__privacyAudit;
    const samples = []; const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
    for (const length of [0, 100, 1000, 5000]) {
      await new Promise((resolve) => { indexedDB.deleteDatabase('drivesense_privacy_audit_v2').onsuccess = resolve; }); localStorage.clear();
      await seedLegacy(length); await audit.runPrivacyAuditCompatibilityUpgrade();
      const debt = [{ operationId: 'receipt-00000', createdAtMs: 100, tripCount: 1, pointCount: 30, motionSampleCount: 0, reason: 'raw_gps_retention_policy' },
        { operationId: 'receipt-00001', createdAtMs: 101, tripCount: 1, pointCount: 30, motionSampleCount: 0, reason: 'raw_gps_retention_policy' }];
      let nativeWork; let ackFail = true;
      const nativeResponse = (payload, response) => {
        const result = { ...response, bytesWorked: response.bytesWorked + size(payload) + 2 * size(response) };
        nativeWork.itemsWorked += result.itemsWorked; nativeWork.bytesWorked += result.bytesWorked; return result;
      };
      const archive = {
        stepP5RawGpsRetention: async () => ({ state: 'COMPLETE', itemsWorked: 1, bytesWorked: 1 }),
        p5PrivacyReceipts: async () => nativeResponse({}, { state: 'READY', receipts: debt.slice(0, 1), itemsWorked: 1, bytesWorked: debt.length ? 188 : 0 }),
        acknowledgeP5PrivacyReceipt: async (operationId) => {
          if (!ackFail) debt.shift();
          return nativeResponse({ operationId }, { state: ackFail ? 'PRIVACY_RECEIPT_FAILED' : 'READY', acknowledged: !ackFail,
            hasMore: debt.length > 0, itemsWorked: ackFail ? 1 : 2, bytesWorked: ackFail ? 188 : 188 + operationId.length + (debt.length ? 40 : 0) });
        },
      };
      const run = createP5RawGpsRetentionAdapter({ archive, readPolicy: async () => ({ retentionDays: 30 }), appendReceipt: audit.appendPrivacyEventBounded });
      await run();
      for (const phase of ['ack-failed', 'retry', 'last', 'empty']) {
        nativeWork = { itemsWorked: 0, bytesWorked: 0 }; const measured = observe();
        const outcome = await run(); measured.stop();
        samples.push({ length, phase, outcome, actual: { itemsWorked: measured.totals.itemsWorked + nativeWork.itemsWorked,
          bytesWorked: measured.totals.bytesWorked + nativeWork.bytesWorked }, ledger: measured.totals });
        ackFail = false;
      }
    }
    return samples;
  });
  for (const row of samples) {
    expect(row.outcome.itemsWorked).toBe(row.actual.itemsWorked); expect(row.outcome.bytesWorked).toBe(row.actual.bytesWorked);
    expect(row.actual.itemsWorked).toBeLessThanOrEqual(15); expect(row.actual.bytesWorked).toBeLessThanOrEqual(320 * 1024);
    expect(row.ledger.historicalReads).toBe(0); expect(row.ledger.legacy).toBe(0);
    expect(row.outcome.privacyReceiptPending).toBe(['ack-failed', 'retry'].includes(row.phase));
  }
  for (const phase of ['ack-failed', 'retry', 'last', 'empty']) {
    const same = samples.filter((s) => s.phase === phase); expect(new Set(same.map((s) => s.actual.itemsWorked)).size).toBe(1);
    // Count/seq decimal encodings grow only within fixed safe-integer limits.
    expect(Math.max(...same.map((s) => s.actual.bytesWorked)) - Math.min(...same.map((s) => s.actual.bytesWorked))).toBeLessThan(100);
  }
});

test('V25 busy, stale prepare and storage failures remain bounded at every ledger length', async ({ page }) => {
  test.setTimeout(120000);
  const samples = await page.evaluate(async () => {
    const { audit, seedLegacy, observe, mutate } = globalThis.__privacyAudit; const samples = [];
    for (const length of [0, 100, 1000, 5000]) {
      await new Promise((resolve) => { indexedDB.deleteDatabase('drivesense_privacy_audit_v2').onsuccess = resolve; }); localStorage.clear();
      await seedLegacy(length); await audit.runPrivacyAuditCompatibilityUpgrade();
      for (const mode of ['busy', 'conflict', 'storage']) {
        let measured; let release; let holding;
        const add = IDBObjectStore.prototype.add; const digest = SubtleCrypto.prototype.digest;
        if (mode === 'busy') {
          let entered; const ready = new Promise((r) => { entered = r; });
          holding = navigator.locks.request('drivesense-privacy-audit-owner', async () => { entered(); await new Promise((r) => { release = r; }); }); await ready;
        }
        if (mode === 'storage') IDBObjectStore.prototype.add = function (...args) {
          if (this.name === 'entries') throw new DOMException('injected quota', 'QuotaExceededError');
          return add.apply(this, args);
        };
        if (mode === 'conflict') SubtleCrypto.prototype.digest = async function (...args) {
          const value = await digest.apply(this, args);
          // External intervening state mutation is not work performed by this
          // append. Pause observations only around the injected competitor.
          measured.pause(); await mutate((tx) => { const s = tx.objectStore('meta'); const r = s.get('control'); r.onsuccess = () => s.put({ ...r.result, intervening: true }); }); measured.resume();
          return value;
        };
        measured = observe(); const outcome = await audit.appendPrivacyEventBounded({ operationId: `fail-${mode}`, op: 'RAW_GPS_AUTO_PURGED' }); measured.stop();
        IDBObjectStore.prototype.add = add; SubtleCrypto.prototype.digest = digest;
        if (release) { release(); await holding; }
        if (mode === 'conflict') await mutate((tx) => { const s = tx.objectStore('meta'); const r = s.get('control'); r.onsuccess = () => { delete r.result.intervening; s.put(r.result); }; });
        samples.push({ length, mode, outcome, actual: measured.totals, proof: await audit.verifyChain() });
      }
    }
    return samples;
  });
  for (const row of samples) {
    expect(row.outcome.state).toBe({ busy: 'AUDIT_BUSY', conflict: 'AUDIT_CONFLICT', storage: 'AUDIT_STORAGE_UNAVAILABLE' }[row.mode]);
    expect(row.outcome.itemsWorked).toBe(row.actual.itemsWorked); expect(row.outcome.bytesWorked).toBe(row.actual.bytesWorked);
    expect(row.actual.itemsWorked).toBeLessThanOrEqual(9); expect(row.actual.bytesWorked).toBeLessThanOrEqual(256 * 1024);
    expect(row.actual.legacy).toBe(0); expect(row.actual.historicalReads).toBe(0);
    expect(row.proof).toMatchObject({ valid: true, length: row.length });
  }
});
