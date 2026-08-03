import { describe, expect, it } from 'vitest';
import {
  buildResolverProvenance,
  buildSpeedEvidenceDecision,
  dedupeSpeedEvidenceReviewItems,
  describeSpeedRuleApplicability,
} from '@/lib/speedEvidenceReasoning';

describe('speed evidence reasoning', () => {
  it('lets confirmed evidence affect score but blocks pending camera evidence', () => {
    expect(buildSpeedEvidenceDecision({ source: 'user_confirmed_posted_sign' }).canAffectScore).toBe(true);
    expect(buildSpeedEvidenceDecision({ source: 'on_device_regulatory_text' }).canAffectScore).toBe(false);
  });

  it('blocks repeated-drive estimates unless the local calibration gate validated them', () => {
    expect(buildSpeedEvidenceDecision({
      source: 'local_road_memory',
      stage: 'operational',
      evidenceCount: 20,
      canAffectScoreAndAlerts: false,
      validationReason: 'Still in shadow mode.',
    })).toMatchObject({
      status: 'shadow',
      canAffectScore: false,
      canAffectVoiceAlerts: false,
    });
    expect(buildSpeedEvidenceDecision({
      source: 'local_road_memory',
      usageStage: 'validated',
      active: true,
      canAffectScoreAndAlerts: true,
    })).toMatchObject({
      status: 'operational',
      canAffectScore: true,
      canAffectVoiceAlerts: true,
    });
  });

  it('deduplicates review prompts by private corridor', () => {
    expect(dedupeSpeedEvidenceReviewItems([{ corridorId: 'a' }, { corridorId: 'a', conflict: true }])).toHaveLength(1);
  });

  it('uses validFrom and expiresAt at the evaluated point time without rewriting earlier history', () => {
    const record = {
      source: 'user_confirmed_posted_sign',
      validFrom: '2026-06-01T00:00:00.000Z',
      expiresAt: '2026-07-01T00:00:00.000Z',
    };

    expect(describeSpeedRuleApplicability(record, {
      timestampMs: Date.parse('2026-05-31T23:59:59.000Z'),
    })).toMatchObject({ active: false, reason: 'not_yet_effective' });
    expect(describeSpeedRuleApplicability(record, {
      timestampMs: Date.parse('2026-06-15T12:00:00.000Z'),
    })).toMatchObject({ active: true, reason: 'active' });
    expect(describeSpeedRuleApplicability(record, {
      timestampMs: Date.parse('2026-07-01T00:00:00.000Z'),
    })).toMatchObject({ active: false, reason: 'expired' });

    expect(buildSpeedEvidenceDecision(record, {
      timestampMs: Date.parse('2026-05-01T00:00:00.000Z'),
    })).toMatchObject({ status: 'future', canAffectScore: false });
  });

  it('treats a blank validFrom as applicable to older matching trip points', () => {
    expect(describeSpeedRuleApplicability({
      source: 'user_entered_estimate',
      appliedAt: '2026-08-01T00:00:00.000Z',
    }, {
      timestampMs: Date.parse('2025-01-01T00:00:00.000Z'),
    })).toMatchObject({ active: true, reason: 'active', validFromMs: null });
  });

  it('blocks malformed or reversed date windows instead of silently applying them', () => {
    expect(describeSpeedRuleApplicability({ validFrom: 'not-a-date' }, { nowMs: 1 }))
      .toMatchObject({ active: false, reason: 'invalid_date_window' });
    expect(describeSpeedRuleApplicability({
      validFrom: '2026-07-02T00:00:00.000Z',
      expiresAt: '2026-07-01T00:00:00.000Z',
    }, { nowMs: Date.parse('2026-06-01T00:00:00.000Z') }))
      .toMatchObject({ active: false, reason: 'invalid_date_window' });
  });

  it('treats a temporary work-zone expiry as its complete condition without inventing a clock schedule', () => {
    const temporaryRule = {
      source: 'user_confirmed_posted_sign',
      qualifierStatus: 'conditional_temporary_work_zone',
      expiresAt: '2026-09-01T00:00:00.000Z',
      timeRule: { enabled: false },
    };

    expect(buildSpeedEvidenceDecision(temporaryRule, {
      timestampMs: Date.parse('2026-08-15T12:00:00.000Z'),
    })).toMatchObject({
      validCondition: true,
      canAffectScore: true,
      canAffectVoiceAlerts: true,
      status: 'confirmed',
      applicability: { active: true, reason: 'active' },
    });
    expect(buildSpeedEvidenceDecision(temporaryRule, {
      timestampMs: Date.parse('2026-09-01T00:00:00.000Z'),
    })).toMatchObject({
      validCondition: true,
      canAffectScore: false,
      status: 'expired',
      applicability: { active: false, reason: 'expired' },
    });
  });

  it('fails closed when a temporary work-zone qualifier has no valid expiry', () => {
    const decision = buildSpeedEvidenceDecision({
      source: 'user_confirmed_posted_sign',
      qualifierStatus: 'conditional_temporary_work_zone',
      timeRule: { enabled: false },
    }, { timestampMs: Date.parse('2026-08-15T12:00:00.000Z') });

    expect(decision).toMatchObject({
      status: 'invalid_condition',
      validCondition: false,
      canAffectScore: false,
      canAffectVoiceAlerts: false,
    });
    expect(decision.why).toContain('expiry is missing or invalid');
  });

  it('keeps point-time applicability statuses ahead of an incomplete qualifier condition', () => {
    const incompleteQualifier = {
      source: 'user_confirmed_posted_sign',
      qualifierStatus: 'conditional_school_when_flashing',
    };

    expect(buildSpeedEvidenceDecision({
      ...incompleteQualifier,
      validFrom: '2026-09-01T00:00:00.000Z',
    }, { timestampMs: Date.parse('2026-08-15T12:00:00.000Z') })).toMatchObject({
      status: 'future',
      validCondition: false,
      canAffectScore: false,
    });
    expect(buildSpeedEvidenceDecision({
      ...incompleteQualifier,
      expiresAt: '2026-08-01T00:00:00.000Z',
    }, { timestampMs: Date.parse('2026-08-15T12:00:00.000Z') })).toMatchObject({
      status: 'expired',
      validCondition: false,
      canAffectScore: false,
    });
  });

  it('evaluates schedules with the recorded UTC offset and carries overnight time into the previous configured day', () => {
    const fridayOvernight = {
      timeRule: {
        enabled: true,
        days: [5],
        startTime: '22:00',
        endTime: '06:00',
      },
    };

    const afterMidnight = describeSpeedRuleApplicability(fridayOvernight, {
      timestampMs: Date.parse('2026-08-08T02:00:00.000Z'),
      utcOffsetMinutes: 0,
    });
    expect(afterMidnight).toMatchObject({ active: true, utcOffsetMinutes: 0 });
    expect(afterMidnight.detail).toContain('recorded UTC offset +0 min');

    expect(describeSpeedRuleApplicability(fridayOvernight, {
      timestampMs: Date.parse('2026-08-08T07:00:00.000Z'),
      utcOffsetMinutes: 0,
    })).toMatchObject({ active: false, reason: 'outside_scheduled_day' });
  });

  it('shows resolver selection, geometry, and revision provenance', () => {
    expect(buildResolverProvenance({
      provenance: 'user_map_edit',
      resolverReason: 'confirmed_posted_beats_local_estimate',
      matchReason: 'matched_traced_section',
      matchDistanceM: 8.4,
      knowledgeRevision: 17,
    })).toMatchObject({
      origin: 'User map edit',
      selection: 'Confirmed posted beats local estimate',
      match: 'Matched traced section',
      revision: 17,
    });
    expect(buildResolverProvenance({ matchReason: 'matched_traced_section' })).toMatchObject({
      revision: null,
    });
    expect(buildResolverProvenance({ matchReason: 'matched_traced_section' }).summary).not.toContain('(0 m)');
  });

  it('reports mapped posted road data as active full-authority evidence', () => {
    expect(buildSpeedEvidenceDecision({ source: 'openstreetmap' })).toMatchObject({
      status: 'mapped',
      canAffectScore: true,
      canAffectVoiceAlerts: true,
    });
  });
});
