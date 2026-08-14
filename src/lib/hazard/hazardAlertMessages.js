/**
 * What the hazard horizon is allowed to say.
 *
 * Two rules shape everything here.
 *
 * The first is that copy quotes only what the evidence object actually contains.
 * The warning this replaces asserted "N metres ahead" without ever checking that
 * anything was ahead; the lesson is that a number in a spoken sentence reads as
 * a measurement whether or not one was taken.
 *
 * The second is that the late-braking wording never claims a corner. Nothing in
 * this pipeline detects curvature — the observation is repeated hard braking at
 * a location — so the sentence says that, with its counts, and lets the driver
 * recognise the place themselves.
 *
 * These builders live here rather than in voiceAlertMessages.js because that
 * file is already near 500 lines and its catalogs are the part worth reading.
 */

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const humanizeEventType = (value) => String(value || '')
  .replace(/_/g, ' ')
  .trim() || 'risk event';

/** "about 9 seconds" when an arrival time is known, else "about 180 meters", else null. */
export function describeHazardLead(context = {}) {
  const seconds = finiteNumber(context.etaSeconds);
  if (seconds !== null && seconds > 0) {
    return `about ${Math.round(seconds)} seconds ahead`;
  }
  const distance = finiteNumber(context.distanceM);
  if (distance !== null && distance > 0) {
    return `about ${Math.round(distance)} meters ahead`;
  }
  return null;
}

const brakingVerb = (dominantType) => (dominantType === 'sharp_turn'
  ? 'turned sharply'
  : 'braked hard');

export function buildLateBrakingMessage(context = {}) {
  const passes = finiteNumber(context.passes);
  const brakingPasses = finiteNumber(context.brakingPasses);
  const verb = brakingVerb(context.dominantType);
  if (passes === null || brakingPasses === null) {
    return `You have ${verb} here before. Ease off early.`;
  }
  return `You have ${verb} here on ${brakingPasses} of your last ${passes} passes. Ease off early.`;
}

export function buildLateBrakingTechnicalMessage(context = {}) {
  const passes = finiteNumber(context.passes);
  const brakingPasses = finiteNumber(context.brakingPasses);
  const typical = finiteNumber(context.typicalEntryKmh);
  const label = context.dominantType === 'sharp_turn' ? 'sharp turns' : 'hard braking';
  if (passes === null || brakingPasses === null) {
    return `Repeated ${label} recorded at this location.`;
  }
  const entry = typical !== null && typical > 0
    ? `, typical entry ${Math.round(typical)} kilometers per hour`
    : '';
  return `Repeated ${label} recorded at this location: ${brakingPasses} of ${passes} passes${entry}.`;
}

const HAZARD_TITLES = Object.freeze({
  repeated_event_area: 'Repeated event area ahead',
  late_braking_pattern: 'You brake hard here',
});

/**
 * The on-screen banner and the Android notification body. Kept beside the voice
 * copy so the three cannot drift into describing different things.
 *
 * @param {{kind: string, etaSeconds: number, evidence: any}} hazard
 * @returns {{title: string, body: string} | null}
 */
export function buildHazardDisplayMessage(hazard) {
  if (!hazard?.kind) return null;
  const lead = describeHazardLead(hazard) || 'ahead';

  if (hazard.kind === 'late_braking_pattern') {
    const passes = finiteNumber(hazard.evidence?.passes);
    const brakingPasses = finiteNumber(hazard.evidence?.brakingPasses);
    const verb = brakingVerb(hazard.evidence?.dominantType);
    const counts = passes !== null && brakingPasses !== null
      ? ` on ${brakingPasses} of your last ${passes} passes`
      : '';
    return {
      title: HAZARD_TITLES.late_braking_pattern,
      body: `You have ${verb} here${counts} — ${lead}`,
    };
  }

  const typeLabel = humanizeEventType(hazard.evidence?.dominantType);
  return {
    title: HAZARD_TITLES.repeated_event_area,
    body: `${typeLabel} repeated-event area ${lead}`,
  };
}
