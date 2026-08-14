/**
 * The old gate was a flat 60 s cooldown and nothing else, so any zone within
 * 300 m spoke once a minute regardless of whether the vehicle was approaching it.
 *
 * The central test here is the closure-rate one: a hazard on the road being
 * driven closes at the vehicle's own speed, and one on a diverging parallel road
 * does not. That single check is what removes parallel-road warnings without any
 * map data, so it is worth reading before changing anything in this file.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createHazardAlertGate } from '@/lib/hazard/hazardAlertGate';

const SPEED_KMH = 72;
const SPEED_MS = SPEED_KMH / 3.6;
const START = 1_770_000_000_000;

let gate;

beforeEach(() => {
  gate = createHazardAlertGate();
});

/** A fix `seconds` after START, having closed exactly as fast as the vehicle moves. */
const approaching = (hazardId, startAlongM, seconds, overrides = {}) => ({
  hazardId,
  etaSeconds: (startAlongM - SPEED_MS * seconds) / SPEED_MS,
  alongTrackM: startAlongM - SPEED_MS * seconds,
  urgency: 0.5,
  speedKmh: SPEED_KMH,
  nowMs: START + seconds * 1000,
  ...overrides,
});

describe('createHazardAlertGate', () => {
  it('will not speak on first sight', () => {
    const first = gate.evaluate(approaching('a', 200, 0));
    expect(first.shouldAlert).toBe(false);
    expect(first.reason).toBe('awaiting_sustained_approach');
    expect(first.approachFixes).toBe(1);
  });

  it('speaks once the approach is sustained', () => {
    gate.evaluate(approaching('a', 200, 0));
    const second = gate.evaluate(approaching('a', 200, 2));
    expect(second.shouldAlert).toBe(true);
    expect(second.approachFixes).toBe(2);
  });

  it('never accumulates progress for a hazard on a diverging parallel road', () => {
    // It gets nearer, but far more slowly than the vehicle is travelling: the
    // corridor is pulling away from it.
    for (let second = 0; second <= 10; second += 2) {
      const result = gate.evaluate({
        hazardId: 'parallel',
        etaSeconds: 10 - second * 0.15,
        alongTrackM: 200 - second * 3,
        urgency: 0.5,
        speedKmh: SPEED_KMH,
        nowMs: START + second * 1000,
      });
      expect(result.shouldAlert).toBe(false);
    }
    expect(gate.stats().alertCount).toBe(0);
  });

  it('does not accumulate progress for a hazard that is not getting closer', () => {
    gate.evaluate(approaching('a', 200, 0));
    const result = gate.evaluate({ ...approaching('a', 200, 2), alongTrackM: 210, etaSeconds: 11 });
    expect(result.shouldAlert).toBe(false);
    expect(result.approachFixes).toBe(1);
  });

  it('keeps progress across a brief absence but drops it after the release window', () => {
    gate.evaluate(approaching('a', 400, 0));
    // Outranked for two seconds, then back: progress survives.
    expect(gate.evaluate(approaching('a', 400, 2)).shouldAlert).toBe(true);

    const slow = createHazardAlertGate({ sustainedFixes: 3 });
    slow.evaluate(approaching('b', 900, 0));
    slow.evaluate(approaching('b', 900, 2));
    // Gone for longer than releaseSeconds: the tracker is torn down and the
    // next sighting starts over rather than alerting on stale progress.
    const afterGap = slow.evaluate(approaching('b', 900, 12));
    expect(afterGap.approachFixes).toBe(1);
    expect(afterGap.shouldAlert).toBe(false);
  });

  it('says a thing once per drive and re-arms on the next one', () => {
    gate.evaluate(approaching('a', 400, 0));
    expect(gate.evaluate(approaching('a', 400, 2)).shouldAlert).toBe(true);
    expect(gate.evaluate(approaching('a', 400, 4)).reason).toBe('already_alerted');

    gate.startDrive();
    gate.evaluate(approaching('a', 400, 6));
    expect(gate.evaluate(approaching('a', 400, 8)).shouldAlert).toBe(true);
  });

  it('holds a second hazard behind the cooldown', () => {
    gate.evaluate(approaching('a', 400, 0));
    expect(gate.evaluate(approaching('a', 400, 2)).shouldAlert).toBe(true);
    gate.evaluate(approaching('b', 400, 4));
    expect(gate.evaluate(approaching('b', 400, 6)).reason).toBe('cooldown');
  });

  it('lets a markedly more urgent hazard pre-empt the cooldown exactly once', () => {
    gate.evaluate(approaching('a', 400, 0, { urgency: 0.4 }));
    expect(gate.evaluate(approaching('a', 400, 2, { urgency: 0.4 })).shouldAlert).toBe(true);

    gate.evaluate(approaching('b', 400, 4, { urgency: 0.9 }));
    expect(gate.evaluate(approaching('b', 400, 6, { urgency: 0.9 })).shouldAlert).toBe(true);

    // A third, also much more urgent, is refused inside the pre-empt interval.
    gate.evaluate(approaching('c', 400, 8, { urgency: 0.95 }));
    expect(gate.evaluate(approaching('c', 400, 10, { urgency: 0.95 })).reason).toBe('cooldown');
  });

  it('survives a clock that jumps backwards', () => {
    gate.evaluate(approaching('a', 400, 10));
    const backwards = gate.evaluate({ ...approaching('a', 400, 12), nowMs: START + 5000 });
    expect(backwards.approachFixes).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(backwards.approachFixes)).toBe(true);
  });

  it('stops talking after the per-drive ceiling', () => {
    const capped = createHazardAlertGate({ cooldownMs: 0, maxPerDrive: 2 });
    for (const id of ['a', 'b', 'c']) {
      capped.evaluate(approaching(id, 400, 0));
      capped.evaluate(approaching(id, 400, 2));
    }
    expect(capped.stats().alertCount).toBe(2);
    expect(capped.evaluate(approaching('d', 400, 4)).reason).toBe('max_per_drive');
  });

  it('refuses unusable readings instead of treating them as zero', () => {
    // Number(null) is 0, which would look like a hazard at the vehicle's bumper.
    expect(gate.evaluate({ hazardId: 'a', etaSeconds: null, alongTrackM: null, speedKmh: null }).reason)
      .toBe('unusable_reading');
    expect(gate.evaluate({}).reason).toBe('no_hazard');
  });
});
