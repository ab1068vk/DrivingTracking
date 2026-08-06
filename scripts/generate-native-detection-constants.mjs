/**
 * Emits android/app/src/main/java/com/drivesense/app/DetectionConstants.java from the
 * JavaScript scoring constants, so the native live-coaching detector and the JS scoring
 * pipeline cannot drift apart the way the hand-copied literals had.
 *
 * Run `npm run native:constants` after editing src/lib/scoringConstants.js. `--check`
 * (wired into pretest, alongside the scoring-version guard) fails if the Java file is stale.
 *
 * Only values that BOTH sides genuinely share belong here. Live-alert-only tuning
 * (cooldowns, the tighter voice-alert accuracy gate) stays in the service, next to the
 * comment explaining why it differs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedPath = path.join(
  repoRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'drivesense', 'app', 'DetectionConstants.java'
);
const checkOnly = process.argv.includes('--check');

const importFresh = (relativePath) => import(
  `${pathToFileURL(path.join(repoRoot, relativePath)).href}?native-constants=${Date.now()}`
);

const { scoringValue } = await importFresh('src/lib/scoringConstants.js');
const { STANDARD_GRAVITY_MS2 } = await importFresh('src/lib/mathUtils.js');
const {
  SPEED_ALERT_MIN_CONFIDENCE,
  SPEED_ALERT_RELEASE_KMH,
  SPEED_ALERT_SUSTAINED_MS,
} = await importFresh('src/lib/appConstants.js');

/**
 * Java field name -> value, Java type, and the JS constant it came from.
 *
 * `source` is documentation only; `value` is what is emitted. Keep the two in step.
 * `group` lines are rendered as one Javadoc block above the fields.
 */
const FIELDS = [
  {
    group: [
      'GPS sample quality. Must match the filter the scored trip uses, or the live',
      'detector reacts to points the trip engine has already discarded.',
    ],
    fields: [
      { name: 'MAX_ACCURACY_M', type: 'float', value: scoringValue('MAX_GPS_ACCURACY_M'), source: 'MAX_GPS_ACCURACY_M' },
      { name: 'MIN_POINT_DISTANCE_M', type: 'double', value: scoringValue('MIN_POINT_DISTANCE_M'), source: 'MIN_POINT_DISTANCE_M' },
      { name: 'STATIONARY_SPEED_KMH', type: 'double', value: scoringValue('STATIONARY_SPEED_KMH'), source: 'STATIONARY_SPEED_KMH' },
      { name: 'MIN_TRUSTED_SPEED_KMH', type: 'double', value: scoringValue('MIN_TRUSTED_SPEED_KMH'), source: 'MIN_TRUSTED_SPEED_KMH' },
      { name: 'MAX_SPEED_KMH', type: 'double', value: scoringValue('MAX_REASONABLE_GPS_SPEED_KMH'), source: 'MAX_REASONABLE_GPS_SPEED_KMH' },
      { name: 'STATS_MAX_SAMPLE_GAP_SECONDS', type: 'long', value: scoringValue('MAX_SAMPLE_GAP_SECONDS'), source: 'MAX_SAMPLE_GAP_SECONDS' },
    ],
  },
  {
    group: [
      'Trip acceptance. A trip the native side saves but the scorer rejects shows up as',
      'an unscored record in the trip list.',
    ],
    fields: [
      { name: 'MIN_TRIP_MS', type: 'long', value: scoringValue('MIN_TRIP_DURATION_SECONDS') * 1000, source: 'MIN_TRIP_DURATION_SECONDS * 1000' },
      { name: 'MIN_TRIP_KM', type: 'double', value: scoringValue('MIN_TRIP_DISTANCE_KM'), source: 'MIN_TRIP_DISTANCE_KM' },
      { name: 'MAX_TERMINAL_IDLE_SECONDS', type: 'long', value: scoringValue('MAX_TERMINAL_IDLE_SECONDS'), source: 'MAX_TERMINAL_IDLE_SECONDS' },
    ],
  },
  {
    group: ['Fallback night window, used when solar context is unavailable.'],
    fields: [
      { name: 'NIGHT_START_HOUR', type: 'int', value: scoringValue('NIGHT_START_HOUR'), source: 'NIGHT_START_HOUR' },
      { name: 'NIGHT_END_HOUR', type: 'int', value: scoringValue('NIGHT_END_HOUR'), source: 'NIGHT_END_HOUR' },
    ],
  },
  {
    group: [
      'Event minimum-speed gates. These were one shared LIVE_EVENT_MIN_SPEED_KMH on the',
      'native side, which is why braking alerts could fire below the speed at which the',
      'scored trip records a harsh brake at all.',
    ],
    fields: [
      { name: 'MIN_SPEED_HARSH_BRAKE_KMH', type: 'double', value: scoringValue('MIN_SPEED_HARSH_BRAKE_KMH'), source: 'MIN_SPEED_HARSH_BRAKE_KMH' },
      { name: 'MIN_SPEED_RAPID_ACCEL_KMH', type: 'double', value: scoringValue('MIN_SPEED_RAPID_ACCEL_KMH'), source: 'MIN_SPEED_RAPID_ACCEL_KMH' },
      { name: 'CORNERING_MIN_SPEED_KMH', type: 'double', value: scoringValue('CORNERING_MIN_SPEED_KMH'), source: 'CORNERING_MIN_SPEED_KMH' },
      { name: 'SHARP_TURN_MIN_HEADING_CHANGE_DEG', type: 'double', value: scoringValue('SHARP_TURN_MIN_HEADING_CHANGE_DEG'), source: 'SHARP_TURN_MIN_HEADING_CHANGE_DEG' },
      { name: 'STANDARD_GRAVITY_MS2', type: 'double', value: STANDARD_GRAVITY_MS2, source: 'mathUtils.js STANDARD_GRAVITY_MS2' },
    ],
  },
  {
    group: [
      'Stop-start pattern. The JS detector picks its threshold set from the trip median',
      'moving speed; the service approximates that with the current speed, because it',
      'has no trip median until the trip ends.',
    ],
    fields: [
      { name: 'STOP_START_URBAN_SPEED_SPLIT_KMH', type: 'double', value: scoringValue('STOP_START_URBAN_MEDIAN_SPEED_KMH'), source: 'STOP_START_URBAN_MEDIAN_SPEED_KMH' },
      { name: 'STOP_START_DECEL_MS2', type: 'double', value: scoringValue('STOP_START_DECEL_MS2'), source: 'STOP_START_DECEL_MS2' },
      { name: 'STOP_START_MIN_SPEED_KMH', type: 'double', value: scoringValue('STOP_START_MIN_SPEED_KMH'), source: 'STOP_START_MIN_SPEED_KMH' },
      { name: 'STOP_START_SPEED_DROP_KMH', type: 'double', value: scoringValue('STOP_START_SPEED_DROP_KMH'), source: 'STOP_START_SPEED_DROP_KMH' },
      { name: 'STOP_START_URBAN_DECEL_MS2', type: 'double', value: scoringValue('STOP_START_URBAN_DECEL_MS2'), source: 'STOP_START_URBAN_DECEL_MS2' },
      { name: 'STOP_START_URBAN_MIN_SPEED_KMH', type: 'double', value: scoringValue('STOP_START_URBAN_MIN_SPEED_KMH'), source: 'STOP_START_URBAN_MIN_SPEED_KMH' },
      { name: 'STOP_START_URBAN_SPEED_DROP_KMH', type: 'double', value: scoringValue('STOP_START_URBAN_SPEED_DROP_KMH'), source: 'STOP_START_URBAN_SPEED_DROP_KMH' },
    ],
  },
  {
    group: [
      'Default detection thresholds. The service reads the user value from settings and',
      'falls back to these, so a fallback that disagreed with DEFAULT_SETTINGS would make',
      'a fresh install detect differently from a configured one.',
    ],
    fields: [
      { name: 'HARSH_BRAKE_MS2', type: 'double', value: scoringValue('HARSH_BRAKE_MS2'), source: 'HARSH_BRAKE_MS2' },
      { name: 'RAPID_ACCEL_MS2', type: 'double', value: scoringValue('RAPID_ACCEL_MS2'), source: 'RAPID_ACCEL_MS2' },
      { name: 'SHARP_TURN_G_LOW', type: 'double', value: scoringValue('SHARP_TURN_G_LOW'), source: 'SHARP_TURN_G_LOW' },
      { name: 'HEADING_DRIFT_STD_DEG', type: 'double', value: scoringValue('HEADING_DRIFT_STD_DEG'), source: 'HEADING_DRIFT_STD_DEG' },
      { name: 'HEADING_DRIFT_HIGHWAY_SPEED_KMH', type: 'double', value: scoringValue('HEADING_DEVIATION_HIGHWAY_MIN_SPEED_KMH'), source: 'HEADING_DEVIATION_HIGHWAY_MIN_SPEED_KMH' },
      { name: 'MANOEUVRE_ALERT_BRAKE_MS2', type: 'double', value: scoringValue('MANOEUVRE_ALERT_BRAKE_MS2'), source: 'MANOEUVRE_ALERT_BRAKE_MS2' },
      { name: 'MANOEUVRE_ALERT_TURN_DEG_S', type: 'double', value: scoringValue('MANOEUVRE_ALERT_TURN_DEG_S'), source: 'MANOEUVRE_ALERT_TURN_DEG_S' },
      { name: 'SPEEDING_FALLBACK_KMH', type: 'double', value: scoringValue('SPEEDING_FALLBACK_KMH'), source: 'SPEEDING_FALLBACK_KMH' },
      { name: 'SPEED_OVER_KMH', type: 'double', value: scoringValue('SPEED_OVER_KMH'), source: 'SPEED_OVER_KMH' },
      { name: 'LONG_DRIVE_MINUTES', type: 'double', value: scoringValue('LONG_DRIVE_MINUTES'), source: 'LONG_DRIVE_MINUTES' },
    ],
  },
  {
    group: [
      'Phone-use GPS proxy. Diagnostic only on both sides: it never contributes to a',
      'score, and confirmed phone use still requires Usage Access.',
    ],
    fields: [
      { name: 'PHONE_MICRO_STEER_WINDOW_S', type: 'double', value: scoringValue('PHONE_MICRO_STEER_WINDOW_S'), source: 'PHONE_MICRO_STEER_WINDOW_S' },
      { name: 'PHONE_MICRO_STEER_COUNT', type: 'int', value: scoringValue('PHONE_MICRO_STEER_COUNT'), source: 'PHONE_MICRO_STEER_COUNT' },
      { name: 'PHONE_MICRO_STEER_MIN_DEG', type: 'double', value: scoringValue('PHONE_MICRO_STEER_MIN_DEG'), source: 'PHONE_MICRO_STEER_MIN_DEG' },
      { name: 'PHONE_MICRO_STEER_MAX_DEG', type: 'double', value: scoringValue('PHONE_MICRO_STEER_MAX_DEG'), source: 'PHONE_MICRO_STEER_MAX_DEG' },
      { name: 'PHONE_PROXY_MAX_ACCURACY_M', type: 'float', value: scoringValue('PHONE_PROXY_MAX_ACCURACY_M'), source: 'PHONE_PROXY_MAX_ACCURACY_M' },
      { name: 'PHONE_DETECT_MIN_SPEED_KMH', type: 'double', value: scoringValue('PHONE_DETECT_MIN_SPEED_KMH'), source: 'PHONE_DETECT_MIN_SPEED_KMH' },
    ],
  },
  {
    group: [
      'Speed-alert gating. These were hand-copied literals that happened to agree, and',
      'the two sides had already drifted in behaviour: the webview applied neither the',
      'sustained window nor the confidence floor, so a background trip and a foreground',
      'trip over the same road could alert differently.',
      '',
      'RELEASE_KMH is the hysteresis band. The over-limit state clears only below',
      '(limit + margin - release), so hovering on the threshold cannot re-arm the alert.',
    ],
    fields: [
      { name: 'SPEED_ALERT_SUSTAINED_MS', type: 'long', value: SPEED_ALERT_SUSTAINED_MS, source: 'appConstants.SPEED_ALERT_SUSTAINED_MS' },
      { name: 'SPEED_ALERT_MIN_CONFIDENCE', type: 'double', value: SPEED_ALERT_MIN_CONFIDENCE, source: 'appConstants.SPEED_ALERT_MIN_CONFIDENCE' },
      { name: 'SPEED_ALERT_RELEASE_KMH', type: 'double', value: SPEED_ALERT_RELEASE_KMH, source: 'appConstants.SPEED_ALERT_RELEASE_KMH' },
    ],
  },
];

const decimals = (value) => {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
};

const literal = (type, value) => {
  if (!Number.isFinite(value)) throw new Error(`Non-finite value for a ${type} field: ${value}`);
  if (type === 'int' || type === 'long') {
    if (!Number.isInteger(value)) throw new Error(`${type} field needs an integer, got ${value}`);
    return type === 'long' ? `${value}L` : String(value);
  }
  const text = value.toFixed(Math.max(1, decimals(value)));
  return type === 'float' ? `${text}f` : `${text}d`;
};

const renderGroup = ({ group, fields }) => [
  `    /**\n${group.map((line) => `     * ${line}`).join('\n')}\n     */`,
  ...fields.map(({ name, type, value, source }) =>
    `    /** ${source} */\n    static final ${type} ${name} = ${literal(type, value)};`
  ),
].join('\n');

const nextSource = `package com.drivesense.app;

/**
 * Detection constants shared with the JavaScript scoring pipeline.
 *
 * GENERATED by scripts/generate-native-detection-constants.mjs from
 * src/lib/scoringConstants.js. Do not edit by hand - run \`npm run native:constants\`.
 *
 * The native service runs its own live detector for voice coaching only; it never
 * produces a score. Sharing these values is what stops it announcing an event that the
 * scored trip will not contain. Each field names the JS constant it mirrors.
 */
final class DetectionConstants {

${FIELDS.map(renderGroup).join('\n\n')}

    private DetectionConstants() {
    }
}
`;

// Compare content, not bytes: git checks Java out with CRLF where core.autocrlf is on.
const normalizeEol = (source) => source.replace(/\r\n/g, '\n');

let currentSource = '';
try {
  currentSource = readFileSync(generatedPath, 'utf8');
} catch {
  currentSource = '';
}
const isUpToDate = normalizeEol(currentSource) === normalizeEol(nextSource);
const fieldCount = FIELDS.reduce((sum, entry) => sum + entry.fields.length, 0);

if (checkOnly) {
  if (!isUpToDate) {
    console.error('DetectionConstants.java is stale or missing.');
    console.error('Run: npm run native:constants');
    process.exit(1);
  }
  console.log(`DetectionConstants.java is current (${fieldCount} constants).`);
} else if (!isUpToDate) {
  writeFileSync(generatedPath, nextSource);
  console.log(`Generated DetectionConstants.java (${fieldCount} constants).`);
} else {
  console.log(`DetectionConstants.java is current (${fieldCount} constants).`);
}
