// J1's disposable domain phase, never a scheduler or durable coordinator cursor.
export function createP5RawGpsRetentionAdapter({ archive, readPolicy, appendReceipt, freezeEvidence = null, onStatus = () => {} }) {
  let phase = 'native'; let identity;
  let status = { state: 'UNKNOWN', privacyReceiptPending: null };
  const publish = (outcome) => {
    status = { state: outcome.state, nativePolicyDrained: phase === 'receipts',
      privacyReceiptPending: outcome.privacyReceiptPending ?? status.privacyReceiptPending };
    onStatus(status);
    return outcome;
  };
  const run = async ({ instanceId = '', archiveGeneration = '' } = {}) => {
    const policy = await readPolicy();
    const token = JSON.stringify([instanceId, archiveGeneration, policy.retentionDays, policy.motionRetentionDays]);
    if (token !== identity) { identity = token; phase = 'native'; }
    if (phase === 'native') {
      const outcome = await archive.stepP5RawGpsRetention({ ...policy, now: Date.now() });
      if (outcome.state === 'P6_FREEZE_REQUIRED') {
        if (typeof freezeEvidence !== 'function') throw new Error('P6_RETENTION_FREEZE_OWNER_MISSING');
        const frozen = await freezeEvidence({
          sourceAuthority: outcome.sourceAuthority || 'native', tripId: outcome.tripId,
          sourceRevision: outcome.sourceRevision, cursor: outcome.freezeCursor || '', maxItems: 8,
        });
        const ack = await archive.acknowledgeP6RetentionFreeze(
          outcome.jobId, frozen.nextCursor || '', frozen.hasMore !== true,
        );
        return publish({ ...ack,
          state: frozen.hasMore ? 'P6_FREEZE_PARTIAL' : 'P6_FREEZE_COMPLETE',
          itemsWorked: (Number(outcome.itemsWorked) || 0) + (Number(frozen.itemsWorked) || 0) + (Number(ack.itemsWorked) || 0),
          bytesWorked: (Number(outcome.bytesWorked) || 0) + (Number(frozen.bytesWorked) || 0) + (Number(ack.bytesWorked) || 0),
          hasMore: true,
        });
      }
      if ((outcome.state === 'COMPLETE' && !outcome.jobId) || outcome.state === 'DISABLED') {
        phase = 'receipts';
        return publish({ ...outcome, state: 'RECEIPTS_NEXT', hasMore: true });
      }
      // One completed job is not a drained-policy proof.
      return publish({ ...outcome, hasMore: ['COMPLETE', 'OBSOLETE_COMPLETE'].includes(outcome.state) && outcome.jobId ? true : outcome.hasMore });
    }
    let itemsWorked = 0; let bytesWorked = 0; let nativeItems = 0; let nativeBytes = 0;
    const addNative = (result) => {
      nativeItems += result.itemsWorked; nativeBytes += result.bytesWorked;
      itemsWorked += result.itemsWorked; bytesWorked += result.bytesWorked;
      if (nativeItems > 6 || nativeBytes > 64 * 1024) throw new Error('P5_RECEIPT_NATIVE_BUDGET_EXCEEDED');
    };
    try {
      const pending = await archive.p5PrivacyReceipts(); addNative(pending);
      if (pending.state !== 'READY') return publish({ state: 'PRIVACY_RECEIPT_FAILED', itemsWorked, bytesWorked, hasMore: false, privacyReceiptPending: true });
      const receipt = pending.receipts?.[0];
      if (!receipt) return publish({ state: 'COMPLETE', itemsWorked, bytesWorked, hasMore: false, privacyReceiptPending: false });
      const delivered = await appendReceipt({
        op: 'RAW_GPS_AUTO_PURGED', operationId: receipt.operationId, timestamp: receipt.createdAtMs,
        details: { purged_trip_count: receipt.tripCount, purged_point_count: receipt.pointCount,
          purged_motion_sample_count: receipt.motionSampleCount, reason: receipt.reason },
      }, { afterCommit: async () => {
        const ack = await archive.acknowledgeP5PrivacyReceipt(receipt.operationId); addNative(ack);
        return ack;
      } });
      itemsWorked += delivered.itemsWorked; bytesWorked += delivered.bytesWorked;
      if (delivered.itemsWorked > 9 || delivered.bytesWorked > 256 * 1024 || itemsWorked > 15 || bytesWorked > 320 * 1024) {
        throw new Error('P5_RECEIPT_COMBINED_BUDGET_EXCEEDED');
      }
      if (delivered.state !== 'READY') return publish({ state: delivered.state, itemsWorked, bytesWorked, hasMore: false, privacyReceiptPending: true });
      const ack = delivered.acknowledgement;
      if (ack?.state !== 'READY' || !ack.acknowledged) return publish({ state: 'PRIVACY_RECEIPT_FAILED', itemsWorked, bytesWorked, hasMore: false, privacyReceiptPending: true });
      return publish({ state: ack.hasMore ? 'RECEIPTS_PENDING' : 'COMPLETE', itemsWorked, bytesWorked,
        hasMore: ack.hasMore === true, privacyReceiptPending: ack.hasMore === true });
    } catch (error) {
      // Do not clamp observed work, including failed ACK/probe costs.
      return publish({ state: 'PRIVACY_RECEIPT_FAILED', error: error.message, itemsWorked, bytesWorked,
        hasMore: false, privacyReceiptPending: true });
    }
  };
  run.reset = () => { phase = 'native'; identity = undefined; };
  run.status = () => ({ ...status });
  return run;
}
