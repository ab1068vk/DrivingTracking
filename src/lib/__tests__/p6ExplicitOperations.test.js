import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ value: { operations: {} } }));

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (_key, fallback) => structuredClone(memory.value ?? fallback)),
  setJson: vi.fn(async (_key, value) => {
    memory.value = structuredClone(value);
  }),
}));

vi.mock('@/lib/nativePlatform', () => ({ isAndroid: () => false }));
vi.mock('@/lib/nativeTripArchive', () => ({ nativeTripArchive: {} }));

import {
  cancelP6ExplicitOperation,
  listP6ExplicitOperations,
  markP6ExplicitOperationsAfterRestart,
  readP6ExplicitOperation,
  resumeP6ExplicitOperation,
  runP6ExplicitOperationTurn,
  startP6ExplicitOperation,
} from '@/lib/p6ExplicitOperations';
import {
  P6_EXPLICIT_OPERATION_STATES,
  P6_EXPLICIT_OPERATION_TYPES,
} from '@/lib/p6Contracts';

describe('P6 explicit foreground operations', () => {
  beforeEach(() => {
    memory.value = { operations: {} };
    vi.clearAllMocks();
  });

  it('persists exactly the four frozen operation types and deduplicates active work by type', async () => {
    await expect(startP6ExplicitOperation('UNKNOWN')).rejects.toThrow('P6_EXPLICIT_OPERATION_TYPE_INVALID');

    const created = [];
    for (const type of Object.values(P6_EXPLICIT_OPERATION_TYPES)) {
      created.push(await startP6ExplicitOperation(type, { details: { type } }));
    }
    const duplicate = await startP6ExplicitOperation(P6_EXPLICIT_OPERATION_TYPES.DERIVED_REPAIR);

    expect(await listP6ExplicitOperations()).toHaveLength(4);
    expect(new Set(created.map((operation) => operation.operationId)).size).toBe(4);
    expect(duplicate.operationId).toBe(created[0].operationId);
    expect(created.every((operation) => operation.state === P6_EXPLICIT_OPERATION_STATES.READY)).toBe(true);
  });

  it('pauses while hidden, yields to P4, and advances only when the caller requests a turn', async () => {
    const operation = await startP6ExplicitOperation(P6_EXPLICIT_OPERATION_TYPES.DERIVED_REPAIR);
    const handler = vi.fn(async () => ({
      itemsWorked: 3,
      bytesWorked: 50,
      cursor: { page: 2 },
      done: false,
    }));

    const hidden = await runP6ExplicitOperationTurn(operation.operationId, handler, { visible: () => false });
    expect(hidden.state).toBe(P6_EXPLICIT_OPERATION_STATES.PAUSED_HIDDEN);
    expect(handler).not.toHaveBeenCalled();

    const waiting = await runP6ExplicitOperationTurn(operation.operationId, handler, { p4Busy: () => true });
    expect(waiting.state).toBe(P6_EXPLICIT_OPERATION_STATES.WAITING_FOR_OWNER);
    expect(handler).not.toHaveBeenCalled();

    const ready = await runP6ExplicitOperationTurn(operation.operationId, handler);
    expect(ready).toEqual(expect.objectContaining({
      state: P6_EXPLICIT_OPERATION_STATES.READY,
      cursor: { page: 2 },
      progress: { itemsWorked: 3, bytesWorked: 50, turns: 1 },
      runnerLease: null,
    }));
    expect(handler).toHaveBeenCalledTimes(1);

    const persisted = await readP6ExplicitOperation(operation.operationId);
    expect(persisted.progress.turns).toBe(1);
  });

  it('pauses active operations after restart and requires an explicit resume', async () => {
    const operation = await startP6ExplicitOperation(P6_EXPLICIT_OPERATION_TYPES.RETAINED_HISTORY_LEARNING);
    await markP6ExplicitOperationsAfterRestart();

    expect((await readP6ExplicitOperation(operation.operationId)).state)
      .toBe(P6_EXPLICIT_OPERATION_STATES.PAUSED_AFTER_RESTART);
    expect((await resumeP6ExplicitOperation(operation.operationId)).state)
      .toBe(P6_EXPLICIT_OPERATION_STATES.READY);
  });

  it('finishes bounded cancellation cleanup before entering the terminal state', async () => {
    const operation = await startP6ExplicitOperation(P6_EXPLICIT_OPERATION_TYPES.AFFECTED_TRIP_RESCORE);
    await cancelP6ExplicitOperation(operation.operationId);
    const cleanup = vi.fn()
      .mockResolvedValueOnce({ done: false, cursor: { cleanupPage: 1 }, itemsWorked: 2, bytesWorked: 20 })
      .mockResolvedValueOnce({ done: true });

    const pending = await runP6ExplicitOperationTurn(operation.operationId, vi.fn(), { cleanup });
    expect(pending).toEqual(expect.objectContaining({
      state: P6_EXPLICIT_OPERATION_STATES.CANCEL_REQUESTED,
      cursor: { cleanupPage: 1 },
      progress: { itemsWorked: 2, bytesWorked: 20, turns: 1 },
    }));

    const cancelled = await runP6ExplicitOperationTurn(operation.operationId, vi.fn(), { cleanup });
    expect(cancelled).toEqual(expect.objectContaining({
      state: P6_EXPLICIT_OPERATION_STATES.CANCELLED,
      cursor: null,
    }));
    expect(cleanup).toHaveBeenCalledTimes(2);
    await expect(resumeP6ExplicitOperation(operation.operationId))
      .rejects.toThrow('P6_EXPLICIT_OPERATION_TERMINAL');
  });

  it('records completion progress and converts handler faults to durable failure state', async () => {
    const completedOperation = await startP6ExplicitOperation(P6_EXPLICIT_OPERATION_TYPES.BROWSER_SPEED_MIGRATION);
    const completed = await runP6ExplicitOperationTurn(completedOperation.operationId, async () => ({
      itemsWorked: 1,
      bytesWorked: 10,
      done: true,
    }));
    expect(completed).toEqual(expect.objectContaining({
      state: P6_EXPLICIT_OPERATION_STATES.COMPLETED,
      progress: { itemsWorked: 1, bytesWorked: 10, turns: 1 },
    }));

    const failedOperation = await startP6ExplicitOperation(P6_EXPLICIT_OPERATION_TYPES.DERIVED_REPAIR);
    const failed = await runP6ExplicitOperationTurn(failedOperation.operationId, async () => {
      const error = new Error('corrupt payload');
      error.code = 'P6_CORRUPT';
      throw error;
    });
    expect(failed).toEqual(expect.objectContaining({
      state: P6_EXPLICIT_OPERATION_STATES.FAILED,
      runnerLease: null,
      failure: { code: 'P6_CORRUPT', message: 'corrupt payload' },
    }));
  });
});
