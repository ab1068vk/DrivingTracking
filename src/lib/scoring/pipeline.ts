type ScoringStageResult = Record<string, unknown>;

export interface ScoringPipelineContext {
  routePoints: unknown[];
  events: unknown[];
  settings: Record<string, unknown>;
  externalContext: Record<string, unknown>;
  stages: Record<string, ScoringStageResult>;
  [key: string]: unknown;
}

export interface ScoringPipelineStage {
  name: string;
  fn?: (ctx: ScoringPipelineContext) => ScoringStageResult;
}

export const SCORING_PIPELINE: readonly ScoringPipelineStage[] = Object.freeze([
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

const recordOrEmpty = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

export function runScoringPipeline(
  routePoints: unknown[],
  events: unknown[],
  settings: Record<string, unknown>,
  externalContext: Record<string, unknown> = {},
  stages: readonly ScoringPipelineStage[] = SCORING_PIPELINE
): ScoringPipelineContext {
  let ctx = {
    routePoints: Array.isArray(routePoints) ? routePoints : [],
    events: Array.isArray(events) ? events : [],
    settings: recordOrEmpty(settings),
    externalContext: recordOrEmpty(externalContext),
    stages: {} as Record<string, ScoringStageResult>,
  } satisfies ScoringPipelineContext;

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
}: Partial<ScoringPipelineContext> = {}): ScoringPipelineContext {
  return {
    routePoints: Array.isArray(routePoints) ? routePoints : [],
    events: Array.isArray(events) ? events : [],
    settings: recordOrEmpty(settings),
    externalContext: recordOrEmpty(externalContext),
    stages: Object.freeze({ ...recordOrEmpty(stages) }) as Record<string, ScoringStageResult>,
  };
}
