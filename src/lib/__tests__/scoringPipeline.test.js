import { describe, expect, it } from 'vitest';
import { explainScores } from '@/lib/scoring/explainer';
import { createScoringPipelineContext, runScoringPipeline } from '@/lib/scoring/pipeline';

describe('scoring pipeline', () => {
  it('runs named stages in order and keeps their outputs as an audit trail', () => {
    const stages = [
      { name: 'base', fn: () => ({ baseScore: 90 }) },
      { name: 'blend', fn: (ctx) => ({ finalScore: ctx.baseScore - 5 }) },
    ];

    const ctx = runScoringPipeline([], [], {}, {}, stages);

    expect(ctx.finalScore).toBe(85);
    expect(ctx.stages).toEqual({
      base: { baseScore: 90 },
      blend: { finalScore: 85 },
    });
  });

  it('records a skipped stage when one stage throws', () => {
    const ctx = runScoringPipeline([], [], {}, {}, [
      { name: 'base', fn: () => ({ baseScore: 90 }) },
      { name: 'broken', fn: () => { throw new Error('sensor unavailable'); } },
      { name: 'after', fn: (prior) => ({ finalScore: prior.baseScore }) },
    ]);

    expect(ctx.finalScore).toBe(90);
    expect(ctx.stages.broken).toMatchObject({
      error: 'sensor unavailable',
      skipped: true,
    });
  });

  it('explains the top score contributors from pipeline stage output', () => {
    const ctx = createScoringPipelineContext({
      stages: {
        phone_use: { risk: 'high', scoreDeduction: 45 },
        speed_compliance: { score: 70 },
        braking_efficiency: { score: 80 },
        safety_blend: {
          score: 72,
          weights: { compliance: 0.10, braking: 0.15, stopStart: 0.05, laneChanging: 0.05 },
        },
        smoothness_blend: { score: 88, weights: { jerk: 0.25 } },
        eco: { score: 91, weights: { ecoDriving: 0.4, fuelBand: 0.2 } },
        overall_blend: { score: 80, weights: { safety: 0.35, smoothness: 0.30, eco: 0.20 } },
      },
    });

    const explanation = explainScores(ctx);

    expect(explanation.safety[0]).toMatchObject({
      factor: 'phone_use',
      label: 'Phone use detected while driving',
      impact: -45,
    });
    expect(explanation.overall[0]).toMatchObject({
      factor: 'safety',
      impact: -10,
    });
    expect(explanation.top_factors.length).toBeGreaterThan(0);
  });
});
