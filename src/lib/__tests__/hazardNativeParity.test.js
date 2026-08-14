/**
 * The hazard warning exists on both sides: the webview evaluates it per GPS fix,
 * and DriveSenseAutoTrackingService evaluates it during background auto-tracked
 * drives. When `voice_alert_owner` is the native service, the driver hears only
 * the Java one.
 *
 * So the two must agree on the geometry. `npm run native:constants:check` catches
 * a stale generated file; this catches the other direction — a constant quietly
 * dropped from the generator's field list, which leaves DetectionConstants.java
 * "current" while the service falls back to a hard-coded default.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as appConstants from '@/lib/appConstants';

const JAVA_PATH = path.join(
  process.cwd(),
  'android/app/src/main/java/com/drivesense/app/DetectionConstants.java'
);
const SERVICE_PATH = path.join(
  process.cwd(),
  'android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java'
);

/** Every constant the background service needs to reproduce the webview's geometry. */
const SHARED = [
  'HAZARD_HORIZON_ALERT_SECONDS',
  'HAZARD_HORIZON_MIN_SECONDS',
  'HAZARD_HORIZON_MIN_SECONDS_SETTING',
  'HAZARD_HORIZON_MAX_SECONDS',
  'HAZARD_PROJECTION_SLACK',
  'HAZARD_PROJECTION_MIN_M',
  'HAZARD_PROJECTION_MAX_M',
  'HAZARD_FORWARD_CONE_DEG',
  'HAZARD_CORRIDOR_MAX_HALF_WIDTH_M',
  'HAZARD_MIN_SPEED_KMH',
  'HAZARD_MAX_ACCURACY_M',
  'HAZARD_ALERT_GLOBAL_COOLDOWN_MS',
];

const java = readFileSync(JAVA_PATH, 'utf8');
const service = readFileSync(SERVICE_PATH, 'utf8');

const javaValueOf = (name) => {
  const match = java.match(new RegExp(`static final \\w+ ${name} = ([-\\d.]+)[dfLl]?;`));
  return match ? Number(match[1]) : null;
};

describe('hazard horizon native parity', () => {
  it.each(SHARED)('%s is emitted into Java with the JavaScript value', (name) => {
    expect(appConstants[name]).toBeTypeOf('number');
    expect(javaValueOf(name)).toBe(appConstants[name]);
  });

  it.each(SHARED)('%s is actually read by the tracking service', (name) => {
    expect(service).toContain(`DetectionConstants.${name}`);
  });

  it('no longer carries the omnidirectional radius it replaced', () => {
    // A 300 m radius in any direction, announced as "ahead". Its removal is the
    // whole point of the change, so its return should fail loudly.
    expect(service).not.toMatch(/DANGER_ZONE_ALERT_RADIUS_M\s*=/);
    expect(service).not.toMatch(/DANGER_ZONE_ALERT_COOLDOWN_MS\s*=/);
  });

  it('clamps the configurable lead time on the native side too', () => {
    // Without this the Settings slider would only affect foreground drives.
    expect(service).toContain('hazard_horizon_seconds');
  });

  it('warns once per zone per drive and clears that with the other per-drive state', () => {
    expect(service).toContain('alertedHazardIds');
    expect(service).toMatch(/lastDangerZoneAlertMs = 0L;\s*\n\s*alertedHazardIds\.clear\(\);/);
  });
});
