export const SCORING_PIPELINE = Object.freeze([
  Object.freeze({ name: 'safety_base' }),
  Object.freeze({ name: 'braking_efficiency' }),
  Object.freeze({ name: 'speed_compliance' }),
  Object.freeze({ name: 'stop_start' }),
  Object.freeze({ name: 'lane_changing' }),
  Object.freeze({ name: 'phone_use' }),
  Object.freeze({ name: 'safety_blend' }),
  Object.freeze({ name: 'smoothness_base' }),
  Object.freeze({ name: 'jerk' }),
  Object.freeze({ name: 'svi' }),
  Object.freeze({ name: 'brake_onset' }),
  Object.freeze({ name: 'cornering' }),
  Object.freeze({ name: 'smoothness_blend' }),
  Object.freeze({ name: 'eco' }),
  Object.freeze({ name: 'intersection' }),
  Object.freeze({ name: 'fatigue_adjustment' }),
  Object.freeze({ name: 'weather_adjustment' }),
  Object.freeze({ name: 'overall_blend' }),
]);

export function runScoringPipeline(routePoints, events, settings, externalContext = {}, stages = SCORING_PIPELINE) {
  let ctx = {
    routePoints: Array.isArray(routePoints) ? routePoints : [],
    events: Array.isArray(events) ? events : [],
    settings: settings || {},
    externalContext: externalContext || {},
    stages: {},
  };

  for (const stage of stages || []) {
    const name = stage?.name;
    if (!name) continue;

    if (typeof stage.fn !== 'function') {
      ctx.stages[name] = { skipped: true, reason: 'stage_not_implemented' };
      continue;
    }

    try {
      const result = stage.fn(ctx) || {};
      ctx.stages[name] = result;
      ctx = { ...ctx, ...result, stages: ctx.stages };
    } catch (error) {
      ctx.stages[name] = {
        error: error instanceof Error ? error.message : String(error),
        skipped: true,
      };
    }
  }

  return ctx;
}

export function createScoringPipelineContext({
  routePoints = [],
  events = [],
  settings = {},
  externalContext = {},
  stages = {},
} = {}) {
  return {
    routePoints: Array.isArray(routePoints) ? routePoints : [],
    events: Array.isArray(events) ? events : [],
    settings: settings || {},
    externalContext: externalContext || {},
    stages: Object.freeze({ ...(stages || {}) }),
  };
}
