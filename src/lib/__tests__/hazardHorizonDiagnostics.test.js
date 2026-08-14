/**
 * The predicted risk of this feature is that it looks broken: direction filtering
 * and one-shot-per-drive cut alert volume sharply, so a working quiet drive and a
 * broken one are indistinguishable unless "why did it not warn me" is answerable
 * afterwards. It is answerable only if the suppression tallies survive the drive
 * and reach the tracking diagnostics console.
 *
 * They previously did not. The hook accumulated them into a ref nothing read,
 * under a comment claiming they were surfaced. These tests pin the tally itself
 * and the two properties that make recording it affordable: one record per drive,
 * never at GPS cadence, and nothing at all for a drive that never ran.
 */
import { describe, expect, it } from 'vitest';
import { createHazardDriveTally } from '@/lib/hazard/hazardDriveDiagnostics';

/** What the horizon returns for a fix too slow to project from. */
const stopped = (reason = 'below_min_speed') => ({
  diagnostics: { stopReason: reason },
  suppressed: [{ id: null, reason }],
});

/** A fix that projected fine, but every hazard found was rejected. */
const projected = (reasons, { knownZones = 4, knownSegments = 9 } = {}) => ({
  diagnostics: { stopReason: null, knownZones, knownSegments },
  suppressed: reasons.map((reason, i) => ({ id: `zone:${i}`, reason })),
});

describe('createHazardDriveTally', () => {
  it('reports nothing for a drive that never evaluated a fix', () => {
    // reset() also runs on mount and on every tracking-state change, so an
    // unstarted drive must not leave a misleading empty record behind.
    expect(createHazardDriveTally().flush({ alertCount: 0 })).toBeNull();
  });

  it('names the reason a quiet drive was quiet', () => {
    const tally = createHazardDriveTally();
    for (let i = 0; i < 25; i += 1) tally.record(stopped());

    const event = tally.flush({ alertCount: 0 });
    expect(event.type).toBe('hazard_horizon_summary');
    expect(event.context).toBe('hazard_horizon');
    expect(event.fixes).toBe(25);
    expect(event.alert_count).toBe(0);
    // "Never projected a path" and "projected, found nothing" are different
    // diagnoses and only one of them is a bug.
    expect(event.reason).toBe('below_min_speed');
    expect(event.stop_reasons.below_min_speed).toBe(25);
    expect(event.detail).toContain('0 spoken over 25 evaluated fixes');
  });

  it('does not conflate a stop reason with a per-hazard suppression', () => {
    // The stopped-fix shape carries the same reason in both places. Counting it
    // twice would make a slow drive look like it was rejecting hazards.
    const tally = createHazardDriveTally();
    tally.record(stopped('no_heading'));
    const event = tally.flush({ alertCount: 0 });
    expect(event.stop_reasons.no_heading).toBe(1);
    expect(event.suppressed_reasons).toEqual({});
  });

  it('tallies per-hazard suppression reasons once the path projects', () => {
    const tally = createHazardDriveTally();
    tally.record(projected(['behind', 'behind', 'off_path']));
    tally.record(projected(['behind', 'beyond_horizon']));

    const event = tally.flush({ alertCount: 1 });
    expect(event.suppressed_reasons).toEqual({ behind: 3, off_path: 1, beyond_horizon: 1 });
    expect(event.reason).toBe('behind');
    expect(event.alert_count).toBe(1);
    expect(event.detail).toContain('Most suppressed hazard reason: behind x3');
  });

  it('records how much knowledge existed, so an empty index is distinguishable', () => {
    // This is the failure the trip-end rebuild fixes. A precise horizon over an
    // empty store looks exactly like "nothing was ahead of you".
    const tally = createHazardDriveTally();
    tally.record(projected([], { knownZones: 0, knownSegments: 0 }));
    tally.record(projected([], { knownZones: 6, knownSegments: 11 }));

    const event = tally.flush({ alertCount: 0 });
    expect(event.known_zones).toBe(6);
    expect(event.known_segments).toBe(11);
    expect(event.detail).toContain('6 known areas, 11 known segments');
  });

  it('starts a fresh tally after each flush, so one drive cannot inflate the next', () => {
    const tally = createHazardDriveTally();
    tally.record(stopped());
    tally.record(stopped());
    expect(tally.flush({ alertCount: 0 }).fixes).toBe(2);

    tally.record(stopped());
    expect(tally.flush({ alertCount: 0 }).fixes).toBe(1);
    expect(tally.flush({ alertCount: 0 })).toBeNull();
  });

  it('ignores a malformed horizon rather than breaking the drive', () => {
    const tally = createHazardDriveTally();
    tally.record(null);
    tally.record(undefined);
    expect(tally.flush({ alertCount: 0 })).toBeNull();

    tally.record({});
    expect(tally.flush({}).fixes).toBe(1);
  });
});
