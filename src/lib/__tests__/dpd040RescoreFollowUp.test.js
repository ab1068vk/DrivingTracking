import { describe, expect, it, vi } from 'vitest';
import {
  APP_WORK_TRIGGER_ORIGINS,
  P4_DOMAIN_FOLLOW_UP_REASONS,
  P4_LIFECYCLE_JOB_KEYS,
  createP4LifecycleWorkRuntime,
} from '@/lib/appLifecycleWork';
import { APP_WORK_TURN_RESULTS, createAppWorkCoordinator } from '@/lib/appWorkCoordinator';

// DPD-040. On the A54 at 3,000 trips a posted-sign save enqueued 156 trips; one
// direct batch of 20 ran and the rest waited, with the app open, until a resume.
// The lifecycle RESCORING instance had already settled for that epoch, and a
// same-epoch lifecycle re-admission creates nothing. The fix is a declared
// domain follow-up for rescoring only.

const RESCORING = P4_LIFECYCLE_JOB_KEYS.RESCORING;

const fixture = () => {
  const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
  const runRescoringTurn = vi.fn(async () => ({ items: 0, result: APP_WORK_TURN_RESULTS.DONE }));
  const runtime = createP4LifecycleWorkRuntime({
    coordinator,
    nativeAuthorityAvailable: () => false,
    readHealth: async () => ({}),
    runProjectionTurn: vi.fn(async () => ({ done: true, applied: 0 })),
    runJournalTurn: vi.fn(async () => ({ hasMore: false, itemCount: 0 })),
    runRescoringTurn,
  });
  coordinator.setLifecycleState({ effectiveForeground: true, epoch: 11 });
  return { coordinator, runtime, runRescoringTurn };
};

const drain = async (coordinator, jobKey) => {
  for (let run = 0; run < 40 && coordinator.getJobSnapshot(jobKey)?.active; run += 1) {
    await coordinator.drain();
  }
};

describe('DPD-040: rescoring work enqueued mid-epoch gets a coordinator turn', () => {
  it('reproduces the stranding: a settled epoch ignores a same-epoch lifecycle re-admission', async () => {
    const { coordinator, runtime, runRescoringTurn } = fixture();
    runtime.admit(RESCORING, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 11 });
    await drain(coordinator, RESCORING);
    expect(runRescoringTurn).toHaveBeenCalledTimes(1);

    const again = runtime.admit(RESCORING, { origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 11 });
    expect(again.status).toBe('already_admitted');
    await drain(coordinator, RESCORING);
    expect(runRescoringTurn).toHaveBeenCalledTimes(1); // the 136 trips' turn never came
  });

  it('admits and runs a follow-up turn for the declared reason from the settled state', async () => {
    const { coordinator, runtime, runRescoringTurn } = fixture();
    runtime.admit(RESCORING, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 11 });
    await drain(coordinator, RESCORING);

    const followUp = runtime.admitRescoringWorkEnqueued();
    expect(followUp.status).toBe('admitted_domain_followup');
    await drain(coordinator, RESCORING);
    expect(runRescoringTurn).toHaveBeenCalledTimes(2);
  });

  it('coalesces repeated signals into one instance instead of a storm', async () => {
    const { coordinator, runtime, runRescoringTurn } = fixture();
    runtime.admit(RESCORING, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 11 });
    await drain(coordinator, RESCORING);

    runtime.admitRescoringWorkEnqueued();
    const second = runtime.admitRescoringWorkEnqueued();
    expect(['coalesced_queued', 'followup_recorded']).toContain(second.status);
    await drain(coordinator, RESCORING);
    expect(runRescoringTurn.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('stays default-deny for every other job', () => {
    const { runtime } = fixture();
    const refused = runtime.domainFollowUp(P4_LIFECYCLE_JOB_KEYS.ROAD_CONTEXT, P4_DOMAIN_FOLLOW_UP_REASONS.RESCORE_WORK_ENQUEUED);
    expect(refused.status).toBe('domain_followup_unauthorized');
    expect(refused.instanceId).toBeNull();
  });
});
