import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import { SPEED_ALERT_MIN_CONFIDENCE, SPEED_ALERT_RELEASE_KMH, SPEED_ALERT_SUSTAINED_MS } from '@/lib/appConstants';
import { createSpeedAlertGate } from '@/lib/speed/speedAlertGate';

const over = (gate, speedKmh, nowMs) => gate.evaluate({
  speedKmh,
  limitKmh: 50,
  marginKmh: 5,
  nowMs,
});

describe('speed alert gate', () => {
  it('mirrors the sustained window the native service uses', () => {
    expect(SPEED_ALERT_SUSTAINED_MS).toBe(5000);
  });

  it('does not report sustained until the window has elapsed', () => {
    const gate = createSpeedAlertGate();
    expect(over(gate, 70, 0)).toMatchObject({ over: true, sustained: false });
    expect(over(gate, 70, 4999)).toMatchObject({ over: true, sustained: false });
    expect(over(gate, 70, 5000)).toMatchObject({ over: true, sustained: true });
  });

  it('ignores a single spike', () => {
    const gate = createSpeedAlertGate();
    // One bad fix at 120, then back to compliant. Never sustained.
    expect(over(gate, 120, 0).sustained).toBe(false);
    expect(over(gate, 48, 1000)).toMatchObject({ over: false, sustained: false });
    expect(over(gate, 48, 9000).sustained).toBe(false);
  });

  it('holds the over state through hysteresis rather than flapping', () => {
    const gate = createSpeedAlertGate();
    over(gate, 60, 0);
    // Just below the 55 threshold but within the release band: still engaged, so
    // the sustained timer keeps running instead of restarting on every fix.
    expect(over(gate, 55 - (SPEED_ALERT_RELEASE_KMH - 1), 1000).over).toBe(true);
    expect(over(gate, 60, 5000).sustained).toBe(true);
  });

  it('releases once speed drops clear of the band', () => {
    const gate = createSpeedAlertGate();
    over(gate, 60, 0);
    expect(over(gate, 55 - SPEED_ALERT_RELEASE_KMH - 1, 1000).over).toBe(false);
    // Having released, the window starts again from scratch.
    expect(over(gate, 60, 1100).sustained).toBe(false);
    expect(over(gate, 60, 6099).sustained).toBe(false);
    expect(over(gate, 60, 6100).sustained).toBe(true);
  });

  it('treats a missing or unusable limit as not over', () => {
    const gate = createSpeedAlertGate();
    for (const limitKmh of [null, undefined, NaN, 'fast']) {
      expect(gate.evaluate({ speedKmh: 90, limitKmh, marginKmh: 5 })).toMatchObject({ over: false });
    }
  });

  it('does not report a negative duration when the clock jumps backwards', () => {
    const gate = createSpeedAlertGate();
    over(gate, 70, 10000);
    const result = over(gate, 70, 2000);
    expect(result.overForMs).toBeGreaterThanOrEqual(0);
    expect(result.sustained).toBe(false);
  });

  it('reset clears the window', () => {
    const gate = createSpeedAlertGate();
    over(gate, 70, 0);
    gate.reset();
    expect(over(gate, 70, 5000).sustained).toBe(false);
  });
});

describe('web and native share one alert policy', () => {
  const nativeSource = () => readFileSync(
    'android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java',
    'utf8'
  );

  it('reads the gating constants from the generated file rather than literals', () => {
    const source = nativeSource();
    // These were hand-copied literals in the service. If one side is retuned the
    // other must follow, so both now come from DetectionConstants.
    expect(source).toContain('DetectionConstants.SPEED_ALERT_SUSTAINED_MS');
    expect(source).toContain('DetectionConstants.SPEED_ALERT_RELEASE_KMH');
    expect(source).toContain('DetectionConstants.SPEED_ALERT_MIN_CONFIDENCE');
    expect(source).not.toMatch(/SPEED_ALERT_SUSTAINED_MS\s*=\s*5_000L/);
    expect(source).not.toMatch(/confidence\s*<\s*0\.55d/);
  });

  it('applies release hysteresis instead of clearing on the first dip', () => {
    expect(nativeSource()).toContain('SPEED_ALERT_RELEASE_KMH;');
  });

  it('emits the same values the JS side uses', () => {
    const generated = readFileSync(
      'android/app/src/main/java/com/drivesense/app/DetectionConstants.java',
      'utf8'
    );
    expect(generated).toContain(`SPEED_ALERT_SUSTAINED_MS = ${SPEED_ALERT_SUSTAINED_MS}L`);
    expect(generated).toContain(`SPEED_ALERT_RELEASE_KMH = ${SPEED_ALERT_RELEASE_KMH.toFixed(1)}d`);
    expect(generated).toContain(`SPEED_ALERT_MIN_CONFIDENCE = ${SPEED_ALERT_MIN_CONFIDENCE}d`);
  });
});
