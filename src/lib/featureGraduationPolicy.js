export const FEATURE_STATUSES = Object.freeze({
  DIAGNOSTIC_ONLY: 'diagnostic_only',
  VALIDATION_REQUIRED: 'validation_required',
  RETIRED_TO_DEVELOPMENT: 'retired_to_development',
});

export const LANE_CHANGING_GRADUATION_CRITERIA = Object.freeze({
  minimumLabeledTrips: 200,
  minimumManualReviewAgreement: 0.85,
  maximumCurvedRoadFalsePositiveRate: 0.10,
  labelSource: 'manual dashcam review',
});

export const BETA_FEATURE_POLICIES = Object.freeze({
  laneChanging: Object.freeze({
    status: FEATURE_STATUSES.DIAGNOSTIC_ONLY,
    label: 'Lane Changing Diagnostic',
    userLabel: 'Diagnostic only - not included in Safety',
    graduationCriteria: LANE_CHANGING_GRADUATION_CRITERIA,
  }),
  headingDrift: Object.freeze({
    status: FEATURE_STATUSES.DIAGNOSTIC_ONLY,
    label: 'GPS Attention Signal',
    userLabel: 'GPS attention signal only - not a fatigue measurement',
  }),
  overtakePattern: Object.freeze({
    status: FEATURE_STATUSES.RETIRED_TO_DEVELOPMENT,
    label: 'Overtake Pattern Diagnostic',
    userLabel: 'Development diagnostic only - hidden from Trip Detail',
  }),
});
