import { describe, expect, it, vi } from 'vitest';
import {
  APP_WORK_TRIGGER_ORIGINS,
  P4_DOMAIN_FOLLOW_UP_REASONS,
  createP4LifecycleWorkRuntime,
} from '@/lib/appLifecycleWork';
import { createAppWorkCoordinator } from '@/lib/appWorkCoordinator';
import { P6_JOB_KEYS } from '@/lib/p6Contracts';

const DERIVED = P6_JOB_KEYS.TRIP_DERIVED_UPDATES;
const ROAD = P6_JOB_KEYS.ROAD_MEMORY_UPDATES;
const idle = { state: 'IDLE', itemsWorked: 0, bytesWorked: 0, hasMore: false };

function fixture() {
  const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
  const derivedResults = [];
  const roadSubjects = new Set();
  const reduced = [];
  const runP6TripDerivedTurn = vi.fn(async () => derivedResults.shift() || idle);
  const runP6RoadMemoryTurn = vi.fn(async () => {
    const next = roadSubjects.values().next().value;
    if (!next) return idle;
    roadSubjects.delete(next);
    if (!reduced.includes(next)) reduced.push(next);
    return { state: 'ROAD_COMPLETE', itemsWorked: 1, bytesWorked: 0, hasMore: roadSubjects.size > 0 };
  });
  const runtime = createP4LifecycleWorkRuntime({
    coordinator,
    nativeAuthorityAvailable: () => false,
    readHealth: async () => ({}),
    runProjectionTurn: async () => ({ done: true, applied: 0 }),
    runJournalTurn: async () => ({ hasMore: false, itemCount: 0 }),
    runP6TripDerivedTurn,
    runP6RoadMemoryTurn,
    enableP6Registrations: true,
  });
  coordinator.setLifecycleState({ effectiveForeground: true, epoch: 51 });
  const admit = (jobKey) => runtime.admit(jobKey, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 51 });
  const wakeRoad = () => runtime.domainFollowUp(ROAD, P4_DOMAIN_FOLLOW_UP_REASONS.ROAD_WORK_AVAILABLE);
  return { coordinator, runtime, derivedResults, roadSubjects, reduced,
    runP6TripDerivedTurn, runP6RoadMemoryTurn, admit, wakeRoad };
}

describe('DPD-051: committed trip completion admits same-session road work', () => {
  it('wakes the road job after it settled IDLE during PREVIEW_BUILD', async () => {
    const f = fixture();
    f.admit(ROAD);
    await f.coordinator.drain();
    expect(f.runP6RoadMemoryTurn).toHaveBeenCalledTimes(1);
    expect(f.coordinator.getJobSnapshot(ROAD).active).toBeNull();
    f.derivedResults.push({ state: 'PREVIEW_BUILD', itemsWorked: 1, hasMore: true },
      { state: 'RETIRE_SUPERSEDED', itemsWorked: 1, hasMore: true, roadWorkBecameEligible: true }, idle);
    f.roadSubjects.add('L2C8');
    f.admit(DERIVED);
    await f.coordinator.drain();
    expect(f.reduced).toEqual(['L2C8']);
    expect(f.runP6RoadMemoryTurn).toHaveBeenCalledTimes(2);
    expect(f.coordinator.getJobSnapshot(ROAD).active).toBeNull();
  });

  it('retains one follow-up while road work is running and then drains it', async () => {
    const f = fixture();
    let release;
    let started;
    const runningStarted = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    f.runP6RoadMemoryTurn.mockImplementationOnce(async () => { started(); await gate; return idle; });
    f.admit(ROAD);
    const running = f.coordinator.runNextTurn();
    await runningStarted;
    f.roadSubjects.add('A');
    expect(f.wakeRoad().status).toBe('followup_recorded');
    expect(f.wakeRoad().status).toBe('followup_recorded');
    release();
    await running;
    await f.coordinator.drain();
    expect(f.reduced).toEqual(['A']);
    expect(f.runP6RoadMemoryTurn).toHaveBeenCalledTimes(2);
  });

  it('does not lose an eligibility transition immediately after road completion', async () => {
    const f = fixture();
    f.admit(ROAD);
    await f.coordinator.drain();
    f.roadSubjects.add('A');
    expect(f.wakeRoad().status).toBe('admitted_domain_followup');
    await f.coordinator.drain();
    f.roadSubjects.add('B');
    expect(f.wakeRoad().status).toBe('admitted_domain_followup');
    await f.coordinator.drain();
    expect(f.reduced).toEqual(['A', 'B']);
  });

  it('coalesces multiple trips and duplicate completion signals without duplicate output', async () => {
    const f = fixture();
    f.admit(ROAD);
    await f.coordinator.drain();
    for (const id of ['A', 'B', 'C']) f.roadSubjects.add(id);
    expect(f.wakeRoad().status).toBe('admitted_domain_followup');
    for (let i = 0; i < 3; i += 1) {
      expect(['coalesced_queued', 'followup_recorded']).toContain(f.wakeRoad().status);
    }
    await f.coordinator.drain();
    expect(f.reduced).toEqual(['A', 'B', 'C']);
    expect(f.coordinator.getJobSnapshot(ROAD).active).toBeNull();
    expect(f.runP6RoadMemoryTurn.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('does not wake for unrelated derived transitions or undeclared reasons', async () => {
    const f = fixture();
    f.admit(ROAD);
    await f.coordinator.drain();
    f.derivedResults.push({ state: 'ANALYTICS_VERIFIED', itemsWorked: 1, hasMore: false });
    f.admit(DERIVED);
    await f.coordinator.drain();
    expect(f.runP6RoadMemoryTurn).toHaveBeenCalledTimes(1);
    expect(f.runtime.domainFollowUp(ROAD, P4_DOMAIN_FOLLOW_UP_REASONS.TRIP_SOURCE_COMMITTED).status)
      .toBe('domain_followup_unauthorized');
  });

  it('remains restart-safe once the same-session job has completed', async () => {
    const f = fixture();
    f.admit(ROAD);
    await f.coordinator.drain();
    f.roadSubjects.add('A');
    f.wakeRoad();
    await f.coordinator.drain();
    f.coordinator.setLifecycleState({ effectiveForeground: true, epoch: 52 });
    f.runtime.admit(ROAD, { origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 52 });
    await f.coordinator.drain();
    expect(f.reduced).toEqual(['A']);
  });
});
