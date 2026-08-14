/**
 * Habitual speeding, expressed as the thing it actually is: a stretch of road
 * the driver keeps exceeding the limit on.
 *
 * Why this cannot be a point. A continuous over-limit run produces exactly one
 * speeding event, positioned at whichever GPS fix happened to be fastest
 * (`tripEngine`: `speedingPeakPoint || speedingStart`). On a three-kilometre
 * stretch that peak lands wherever traffic and jitter put it, so the same road
 * driven twice puts its two events nowhere near each other. Clustering them by
 * proximity was never going to find anything — which is why a driver whose only
 * habit is speeding saw "no repeated event areas" no matter how many times they
 * drove the same road.
 *
 * Aggregating along the stretch is what recovers the signal. Each pass drops one
 * event somewhere on the run; summing across the whole run and dividing by how
 * often the driver passes it gives the share of passes on which they sped there.
 * The exposure denominator comes from `routeRiskIndex`, which already counts
 * passes once per trip per segment and already excludes privacy-zone segments.
 *
 * This is a rate, not a count, and deliberately so: speeding once on a road you
 * drive daily is not a habit, and speeding on four of five passes is, even
 * though the second produces fewer events.
 */
import {
  clusterByProximity,
  clusterCenter,
  haversineMeters,
  positionOrNull,
} from '@/lib/geo/proximityClusters';
import { zoneId } from '@/lib/dangerZone/zoneIdentity';
import {
  SPEEDING_STRETCH_MIN_PASSES,
  SPEEDING_STRETCH_MIN_RATE,
  SPEEDING_STRETCH_MIN_TRIPS,
} from '@/lib/appConstants';

/**
 * How close two route-risk segments must be to belong to the same stretch.
 * Segment midpoints sit on a ~110 m grid (`GRID_PRECISION = 3`), so this links
 * consecutive segments of one road without bridging to the next street over.
 * Linking is transitive, so a long road chains into a single stretch.
 */
export const SPEEDING_STRETCH_LINK_RADIUS_M = 150;

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

const usableSegment = (segment) => {
  // Strict, because `Number(null)` is 0 and a segment stored without a midpoint
  // would otherwise become a speeding stretch in the Gulf of Guinea.
  const position = positionOrNull(segment);
  if (!position) return null;
  const speeding = positive(segment?.eventTypes?.speeding);
  if (speeding === 0) return null;
  return {
    ...position,
    speeding,
    passes: positive(segment?.tripCount),
    avgSpeed: positive(segment?.avgSpeed),
  };
};

/** Greatest distance across the stretch, from its bounding box rather than every pair. */
const extentM = (members) => {
  if (members.length < 2) return 0;
  const lats = members.map((m) => m.lat);
  const lngs = members.map((m) => m.lng);
  return haversineMeters(
    { lat: Math.min(...lats), lng: Math.min(...lngs) },
    { lat: Math.max(...lats), lng: Math.max(...lngs) }
  );
};

/**
 * Not calibrated to collision data — a band on how consistent the habit is, so
 * "almost every time" reads differently from "about half the time". There is no
 * `critical` band because nothing here measures how far over the limit it was.
 */
const riskLevelForRate = (rate) => {
  if (rate >= 0.85) return 'high';
  if (rate >= 0.65) return 'medium';
  return 'low';
};

/**
 * @param {Map<string, any> | Array<any>} routeRiskIndex segments from `buildRouteRiskIndex`
 * @param {{minPasses?: number, minRate?: number, minTrips?: number, linkRadiusM?: number}} options
 * @returns {Array<any>} stretch records, highest rate first
 */
export function buildSpeedingStretches(routeRiskIndex, options = {}) {
  const minPasses = Number(options.minPasses) || SPEEDING_STRETCH_MIN_PASSES;
  const minRate = Number.isFinite(Number(options.minRate))
    ? Number(options.minRate)
    : SPEEDING_STRETCH_MIN_RATE;
  const minTrips = Number.isFinite(Number(options.minTrips))
    ? Number(options.minTrips)
    : SPEEDING_STRETCH_MIN_TRIPS;
  const linkRadiusM = Number(options.linkRadiusM) || SPEEDING_STRETCH_LINK_RADIUS_M;

  const source = routeRiskIndex instanceof Map ? [...routeRiskIndex.values()] : routeRiskIndex;
  const segments = (Array.isArray(source) ? source : []).map(usableSegment).filter(Boolean);
  if (segments.length === 0) return [];

  return clusterByProximity(segments, { radiusM: linkRadiusM })
    .map((members) => {
      const center = clusterCenter(members);
      if (!center) return null;

      // Every pass covers the whole stretch, so passes do not add up along it.
      // The busiest member is the honest denominator: taking the largest keeps
      // the rate conservative where the cluster spans segments of unequal
      // exposure.
      const passes = Math.max(...members.map((m) => m.passes));
      const eventCount = members.reduce((sum, m) => sum + m.speeding, 0);
      if (passes < minPasses) return null;

      // Clamped because a single pass can emit more than one event: the
      // over-limit window re-arms with no hysteresis, so one run interrupted by
      // a slow sample counts twice. Above 1 the rate stops meaning "share of
      // passes", so 1 is the honest ceiling rather than a larger number.
      const rate = Math.min(1, eventCount / passes);
      // Distinct drives that contributed. One over-limit run yields one event,
      // so events are a close proxy for passes-with-speeding — never more of
      // them than there were passes.
      const tripCount = Math.min(eventCount, passes);
      const lengthM = extentM(members);

      return {
        id: zoneId(center, 'sz'),
        kind: 'speeding_stretch',
        lat: center.lat,
        lng: center.lng,
        // Half the run, so the circle a proximity check uses covers the stretch
        // rather than only its middle.
        radiusM: Math.max(linkRadiusM, Math.round(lengthM / 2)),
        lengthM: Math.round(lengthM),
        segmentCount: members.length,
        eventCount,
        tripCount,
        passes,
        eventRate: rate,
        severityScore: Math.round(rate * 10),
        riskLevel: riskLevelForRate(rate),
        dominantType: 'speeding',
        typeBreakdown: { speeding: eventCount },
        avgSpeedKmh: Math.round(
          members.reduce((sum, m) => sum + m.avgSpeed, 0) / members.length
        ),
        // Route-risk segments carry no timestamps, so this is genuinely unknown
        // rather than zero. Consumers must not render it as "never".
        lastSeen: null,
      };
    })
    .filter((stretch) => stretch && stretch.eventRate >= minRate && stretch.tripCount >= minTrips)
    .sort((a, b) => b.eventRate - a.eventRate || b.passes - a.passes);
}
