import { clamp } from '@/lib/mathUtils';

/**
 * Session forensics: reads signals the tracking pipeline already persists but
 * that no screen has ever rendered — why a trip started and stopped, how much
 * of the drive GPS actually covered, and which detectors silently degraded.
 *
 * Everything here is a read over already-stored, already-coordinate-stripped
 * fields. It adds no capture and no network.
 */

export const UNAVAILABLE = 'source unavailable';

// docs/TECHNICAL_REFERENCE.md records these rates for lane-change detection.
export const GPS_ONLY_LANE_CHANGE_FALSE_POSITIVE_NOTE =
  'Lane-change detection fell back to the GPS-only method, which is documented at roughly 30-40% false positives (IMU-fused detection is roughly 10-15%).';

const finite = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const text = (value) => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
};

const humanize = (value) => String(value)
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (character) => character.toUpperCase());

const timestampMs = (value) => {
  if (value == null || value === '') return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const seconds = (value) => {
  const parsed = finite(value);
  return parsed == null || parsed < 0 ? null : parsed;
};

const durationLabel = (value) => {
  const total = seconds(value);
  if (total == null) return UNAVAILABLE;
  if (total < 60) return `${Math.round(total)}s`;
  const minutes = Math.floor(total / 60);
  const remainder = Math.round(total % 60);
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const row = (id, label, value, detail, tone = 'neutral') => ({
  id,
  label,
  value: value == null || value === '' ? UNAVAILABLE : String(value),
  detail: detail || '',
  tone: value == null || value === '' ? 'muted' : tone,
});

/**
 * How much of the elapsed drive the recorded route actually covers.
 *
 * The native service reports wall-clock duration separately from the duration
 * derived from GPS samples; a gap between them is unlogged tracking time
 * (tunnel, permission loss, killed service), which nothing surfaced before.
 */
export function buildGpsCoverage(trip = {}) {
  const wallClock = seconds(trip.wall_clock_duration_seconds);
  const recorded = seconds(trip.duration_seconds);
  if (wallClock == null || recorded == null || wallClock <= 0) {
    return { percent: null, wallClockSeconds: wallClock, recordedSeconds: recorded, missingSeconds: null };
  }
  const percent = clamp(Math.round((recorded / wallClock) * 100), 0, 100);
  return {
    percent,
    wallClockSeconds: wallClock,
    recordedSeconds: recorded,
    missingSeconds: Math.max(0, Math.round(wallClock - recorded)),
  };
}

function startRows(trip) {
  const startedAt = timestampMs(trip.native_candidate_started_at);
  const confirmedAt = timestampMs(trip.native_candidate_confirmed_at);
  const confirmLatency = startedAt != null && confirmedAt != null
    ? Math.max(0, Math.round((confirmedAt - startedAt) / 1000))
    : null;
  const startReason = text(trip.native_auto_start_reason);
  const startSource = text(trip.start_source);

  return [
    row(
      'start-reason',
      'Why recording started',
      startReason ? humanize(startReason) : startSource ? humanize(startSource) : null,
      startReason
        ? 'Reason recorded by the Android auto-tracking service.'
        : startSource
          ? 'No native reason was recorded; this is the app-level start source.'
          : 'Neither a native start reason nor a start source was recorded for this trip.'
    ),
    row(
      'start-confirm-latency',
      'Candidate to confirmed',
      confirmLatency == null ? null : durationLabel(confirmLatency),
      confirmLatency == null
        ? 'Candidate confirmation timestamps were not recorded.'
        : 'Time the service spent verifying real movement before committing to a trip. Distance before confirmation is still retained.'
    ),
    row(
      'start-near-parked',
      'Started near last parked spot',
      trip.native_candidate_near_parked == null ? null : trip.native_candidate_near_parked ? 'Yes' : 'No',
      'Trips starting near your last parked location are held back briefly to avoid recording a parking manoeuvre as a drive.'
    ),
  ];
}

function stopRows(trip) {
  const stopReason = text(trip.native_auto_stop_reason);
  const trimmed = finite(trip.native_tail_trimmed_points);
  const drift = finite(trip.max_drift_since_stop_m);

  return [
    row(
      'stop-reason',
      'Why recording stopped',
      stopReason ? humanize(stopReason) : null,
      stopReason
        ? 'Reason recorded by the Android auto-tracking service.'
        : 'No native stop reason was recorded. Manual stops and app-level stops do not set one.',
      stopReason === 'location_permission_loss' ? 'warn' : 'neutral'
    ),
    row(
      'stop-tail-trimmed',
      'Tail samples trimmed',
      trimmed == null ? null : String(Math.round(trimmed)),
      trimmed
        ? 'Stationary GPS samples recorded after you stopped were removed so parked jitter does not count as driving.'
        : 'No trailing stationary samples needed trimming.'
    ),
    row(
      'stop-parking-detected',
      'Ended from a parked state',
      trip.parking_stop_detected == null ? null : trip.parking_stop_detected ? 'Yes' : 'No',
      'A detected parking stop means the end position is a settled fix rather than a mid-drive cutoff.'
    ),
    row(
      'stop-drift',
      'GPS drift while stopped',
      drift == null ? null : `${drift.toFixed(1)} m`,
      'How far the fix wandered while the vehicle was stationary. This measures GPS jitter, not driving behaviour.'
    ),
  ];
}

function coverageRows(trip) {
  const coverage = buildGpsCoverage(trip);
  const gapCount = finite(trip.route_gap_count);
  const flags = Array.isArray(trip.data_quality_flags) ? trip.data_quality_flags.filter(Boolean) : [];

  return [
    row(
      'coverage-percent',
      'GPS coverage of the drive',
      coverage.percent == null ? null : `${coverage.percent}%`,
      coverage.percent == null
        ? 'Wall-clock duration was not recorded, so coverage cannot be compared.'
        : coverage.missingSeconds
          ? `${durationLabel(coverage.missingSeconds)} of elapsed time has no recorded GPS. Scores are computed only from covered time.`
          : 'Recorded route time matches elapsed time.',
      coverage.percent != null && coverage.percent < 90 ? 'warn' : 'neutral'
    ),
    row(
      'coverage-gaps',
      'Route gaps',
      gapCount == null ? null : String(Math.round(gapCount)),
      gapCount ? 'Breaks longer than the gap threshold are drawn as gaps rather than straight lines.' : 'No tracking gaps were recorded.',
      gapCount ? 'warn' : 'neutral'
    ),
    row(
      'coverage-flags',
      'Data quality flags',
      flags.length ? flags.map(humanize).join(', ') : 'None recorded',
      flags.length
        ? 'These flags reduce score confidence for this trip.'
        : 'No data-quality problems were flagged during recording.',
      flags.length ? 'warn' : 'good'
    ),
    captureTierRow(trip),
  ];
}

const CAPTURE_TIER_REASONS = {
  thermal_guard: 'the phone was running hot',
  battery_guard: 'battery was at or below 15% and not charging',
  critical: 'battery or heat reached a critical level',
};

/**
 * Explains any stretch where the low-power guard reduced capture. A silently
 * degraded section of a drive would be worse than no guard at all.
 */
function captureTierRow(trip) {
  const tiers = trip.capture_tier_seconds && typeof trip.capture_tier_seconds === 'object'
    ? trip.capture_tier_seconds
    : null;
  if (!tiers) {
    return row('capture-tier', 'Low-power capture guard', null, 'Not recorded for this trip.');
  }
  const throttled = Object.entries(tiers)
    .map(([tier, seconds]) => [tier, finite(seconds) || 0])
    .filter(([tier, seconds]) => tier !== 'normal' && seconds > 0);
  if (!throttled.length) {
    return row(
      'capture-tier',
      'Low-power capture guard',
      'Never engaged',
      'The whole drive recorded at the normal rate.',
      'good'
    );
  }
  const total = throttled.reduce((sum, [, seconds]) => sum + seconds, 0);
  const reasons = throttled
    .map(([tier]) => CAPTURE_TIER_REASONS[tier] || humanize(tier))
    .join('; ');
  return row(
    'capture-tier',
    'Low-power capture guard',
    `${durationLabel(total)} reduced`,
    `Capture was reduced because ${reasons}. Recording continued rather than risking a lost drive; the affected stretch has lower resolution, not missing data.`,
    'warn'
  );
}

function motionRows(trip) {
  const fusion = trip.sensor_fusion_summary || {};
  const peakLinear = finite(fusion.peak_linear_ms2);
  const peakRotation = finite(fusion.peak_rotation_deg_s);
  const harsh = finite(fusion.harsh_motion_count);
  const impact = finite(fusion.impact_like_count);
  const movement = finite(fusion.phone_movement_score);
  const sampleCount = finite(fusion.sample_count ?? trip.motion_sample_count ?? trip.native_motion_sample_count);
  const dropped = finite(trip.native_motion_samples_dropped);
  const recorded = sampleCount == null || dropped == null ? null : sampleCount + dropped;

  return [
    row(
      'motion-samples',
      'Motion samples retained',
      sampleCount == null ? null : String(Math.round(sampleCount)),
      'Downsampled IMU samples kept with this trip.'
    ),
    row(
      'motion-retention',
      'Motion resolution traded',
      dropped == null ? null : dropped > 0 ? `${Math.round(dropped)} of ${Math.round(recorded)} thinned` : 'Full rate kept',
      dropped
        ? 'The buffer hit its size budget, so retention thinned the oldest stretches by dropping every second sample. Coverage still spans the whole drive; older stretches are just coarser.'
        : 'The whole drive fit inside the motion-sample budget at full rate.',
      dropped ? 'warn' : 'good'
    ),
    row(
      'motion-peak-linear',
      'Peak linear acceleration',
      peakLinear == null ? null : `${peakLinear.toFixed(2)} m/s²`,
      'Largest device-frame linear acceleration recorded, gravity removed.'
    ),
    row(
      'motion-peak-rotation',
      'Peak rotation rate',
      peakRotation == null ? null : `${peakRotation.toFixed(1)}°/s`,
      'Largest gyroscope rotation rate recorded. High values with a mounted phone indicate sharp cornering; with a loose phone they indicate handling.'
    ),
    row(
      'motion-harsh-count',
      'Harsh motion samples',
      harsh == null ? null : String(Math.round(harsh)),
      'Samples above the harsh-motion threshold. This is a device-motion count, not a scored driving event.'
    ),
    row(
      'motion-impact-count',
      'Impact-like samples',
      impact == null ? null : String(Math.round(impact)),
      impact
        ? 'Samples with both high linear acceleration and high rotation. A dropped or handled phone produces this pattern too, so it is evidence to review, not a crash finding.'
        : 'No samples combined high linear acceleration with high rotation.',
      impact ? 'warn' : 'neutral'
    ),
    row(
      'motion-phone-movement',
      'Phone movement score',
      movement == null ? null : String(Math.round(movement)),
      'Higher values mean the device itself moved more relative to the vehicle, which lowers confidence in IMU-derived measures.'
    ),
  ];
}

/**
 * Phone-orientation calibration and, critically, what its absence cost.
 *
 * Calibration silently gates IMU-fused lane-change detection (tripEngine
 * detectLaneChanges). When it fails the detector falls back to a GPS-only
 * method with a much higher false-positive rate, and until now nothing told
 * the user that had happened.
 */
function calibrationRows(trip) {
  const fusion = trip.sensor_fusion_summary || {};
  const orientation = fusion.phone_orientation || null;
  const calibrated = orientation?.calibrated === true;
  const correlation = finite(orientation?.longitudinal_correlation);
  const laneChanges = finite(trip.lane_change_count);

  const rows = [
    row(
      'calibration-state',
      'Phone orientation calibrated',
      orientation == null ? null : calibrated ? 'Yes' : 'No',
      orientation == null
        ? 'No calibration attempt was recorded for this trip.'
        : calibrated
          ? `Longitudinal axis resolved as ${orientation.longitudinal_axis || 'unknown'} from ${orientation.sample_count ?? 0} GPS-confirmed braking events.`
          : `Calibration did not succeed (${humanize(orientation.reason || 'unknown reason')}). It needs at least two GPS-confirmed harsh-brake events in the trip.`,
      orientation == null ? 'neutral' : calibrated ? 'good' : 'warn'
    ),
    row(
      'calibration-confidence',
      'Calibration confidence',
      orientation?.confidence ? humanize(orientation.confidence) : null,
      correlation == null
        ? 'Correlation between GPS deceleration and device axes was not recorded.'
        : `Correlation between GPS deceleration and the chosen axis: ${correlation.toFixed(2)}.`
    ),
  ];

  if (orientation != null && !calibrated) {
    rows.push(row(
      'calibration-consequence',
      'Effect on lane-change detection',
      laneChanges == null ? 'GPS-only fallback used' : `${Math.round(laneChanges)} detected via GPS-only fallback`,
      GPS_ONLY_LANE_CHANGE_FALSE_POSITIVE_NOTE,
      'warn'
    ));
  }

  return rows;
}

function phoneUsageRows(trip) {
  const events = Array.isArray(trip.native_phone_usage_events) ? trip.native_phone_usage_events : [];
  const granted = trip.native_phone_usage_access_granted;
  const afterUnlock = events.filter((event) => event?.started_after_unlock === true).length;
  const afterScreenOn = events.filter((event) => event?.started_after_screen_on === true && event?.started_after_unlock !== true).length;
  const proxyCount = finite(trip.native_phone_proxy_count);

  return [
    row(
      'phone-access',
      'Usage Access evidence',
      granted == null ? null : granted ? 'Granted' : 'Not granted',
      granted
        ? 'Phone-use windows come from confirmed Android Usage Access records.'
        : 'Without Usage Access, phone use can only be inferred and is not scored as confirmed evidence.'
    ),
    row(
      'phone-after-unlock',
      'Sessions starting with an unlock',
      events.length ? String(afterUnlock) : null,
      'The phone was locked and was deliberately unlocked during the drive. This is the strongest interaction signal.',
      afterUnlock ? 'warn' : 'neutral'
    ),
    row(
      'phone-after-screen-on',
      'Sessions on an already-woken screen',
      events.length ? String(afterScreenOn) : null,
      'The screen was already on. This can be navigation or a passenger, so it is weaker evidence than an unlock.'
    ),
    row(
      'phone-gps-proxy',
      'GPS proxy observations',
      proxyCount == null ? null : String(Math.round(proxyCount)),
      'Steering-oscillation patterns that resemble distraction. Diagnostic only — this is not counted as confirmed phone use.'
    ),
  ];
}

export function buildSessionForensics(trip = {}) {
  if (!trip || typeof trip !== 'object') return [];
  return [
    { id: 'start', title: 'Session start', rows: startRows(trip) },
    { id: 'stop', title: 'Session stop', rows: stopRows(trip) },
    { id: 'coverage', title: 'Recording coverage', rows: coverageRows(trip) },
    { id: 'motion', title: 'Motion evidence', rows: motionRows(trip) },
    { id: 'calibration', title: 'Sensor calibration', rows: calibrationRows(trip) },
    { id: 'phone', title: 'Phone interaction evidence', rows: phoneUsageRows(trip) },
  ];
}

/**
 * Flattens the grouped forensics into the flat row shape the evidence console
 * table already renders, so the console needs a tab rather than a new layout.
 */
export function buildSessionEvidenceRows(trip = {}) {
  return buildSessionForensics(trip).flatMap((group) => group.rows.map((item) => ({
    id: item.id,
    kind: 'session',
    label: item.label,
    metricKey: group.title,
    value: item.value,
    sampleCount: UNAVAILABLE,
    confidence: item.value === UNAVAILABLE ? 'unavailable' : item.tone === 'warn' ? 'diagnostic' : 'recorded',
    dataSourceLabel: 'recording session',
    calibrationNote: item.detail,
    detail: item.detail,
  })));
}

export function countAvailableForensics(groups = []) {
  return groups.reduce((total, group) => (
    total + (group.rows || []).filter((item) => item.value !== UNAVAILABLE).length
  ), 0);
}
