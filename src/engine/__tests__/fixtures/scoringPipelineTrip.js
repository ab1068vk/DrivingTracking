const START_MS = Date.UTC(2026, 5, 1, 14, 0, 0);
const START_LAT = 43.6532;
const START_LNG = -79.3832;
const POINT_COUNT = 520;
const LAT_STEP = 0.00027;

const speedForIndex = (index) => {
  if (index >= 145 && index <= 155) return 112;
  if (index === 250) return 106;
  if (index === 251) return 55;
  if (index >= 330 && index <= 345) return index % 2 === 0 ? 78 : 95;
  return index % 40 < 20 ? 86 : 92;
};

const headingForIndex = (index) => (
  index >= 330 && index <= 345 ? 4 * Math.sin(index) : 0
);

export function buildRealisticScoringTrip() {
  return Array.from({ length: POINT_COUNT }, (_, index) => ({
    lat: START_LAT + index * LAT_STEP,
    lng: START_LNG + Math.sin(index / 35) * 0.00008,
    timestamp: new Date(START_MS + index * 2000).toISOString(),
    speed_kmh: speedForIndex(index),
    heading: headingForIndex(index),
    accuracy: index % 97 === 0 ? 18 : 8,
  }));
}

export function buildPhoneUseGap() {
  return {
    phone_use_score_available: false,
    phone_use_score_status: 'usage_access_required',
    phone_use_events: [],
    phone_proxy_events: [],
    phone_use_window_count: 0,
    phone_use_total_seconds: 0,
    phone_use_risk: 'none',
    phone_use_score: null,
    data_sources: [],
  };
}
