import { describe, expect, it } from 'vitest';
import {
  buildRoadMemoryCalibration,
  buildRoadMemoryReviewQueue,
  decorateRoadMemoryCandidates,
  summarizeRoadMemoryIntelligence,
} from '@/lib/roadMemoryIntelligence';

const candidate = (id, overrides = {}) => ({
  id,
  sectionKey: id,
  geohash: `dpz8${String(id).padStart(2, '0')}`,
  source: 'local_road_memory',
  limitKmh: 50,
  confidence: 0.72,
  agreement: 1,
  tripCount: 4,
  evidenceCount: 4,
  tripIds: [`${id}-1`, `${id}-2`, `${id}-3`, `${id}-4`],
  lastObservedAt: new Date().toISOString(),
  sectionPoints: [
    { lat: 43.65 + Number(id || 0) * 0.001, lng: -79.39 },
    { lat: 43.65 + Number(id || 0) * 0.001, lng: -79.38 },
  ],
  quality: { congestionSpreadKmh: 5 },
  ...overrides,
});

const exactFeedback = (count = 8) => Array.from({ length: count }, (_, index) => candidate(index + 1, {
  reviewState: 'confirmed',
  reviewedAt: new Date().toISOString(),
  limitAtReviewKmh: 50,
  reviewedLimitKmh: 50,
  feedbackOutcome: 'exact',
}));

describe('Road Memory intelligence calibration', () => {
  it('keeps mature repeated-drive estimates in shadow mode before parked validation', () => {
    const { candidates, calibration } = decorateRoadMemoryCandidates([candidate(1)]);
    expect(calibration.status).toBe('collecting');
    expect(candidates[0]).toMatchObject({
      baseStage: 'operational',
      usageStage: 'shadow',
      active: false,
      canAffectScoreAndAlerts: false,
    });
  });

  it('validates only after enough exact parked decisions', () => {
    const calibration = buildRoadMemoryCalibration(exactFeedback());
    expect(calibration).toMatchObject({
      feedbackCount: 8,
      exactCount: 8,
      validated: true,
      status: 'validated',
    });

    const model = decorateRoadMemoryCandidates([
      ...exactFeedback(),
      candidate(20),
    ]);
    const active = model.candidates.find((item) => item.id === 20);
    expect(active).toMatchObject({
      usageStage: 'validated',
      active: true,
      canAffectScoreAndAlerts: true,
    });
  });

  it('does not transfer validation into an untested road context', () => {
    const model = decorateRoadMemoryCandidates([
      ...exactFeedback(),
      candidate(20, {
        limitKmh: 90,
        quality: { congestionSpreadKmh: 25, medianAccuracyM: 35 },
      }),
    ]);
    const unseenContext = model.candidates.find((item) => item.id === 20);

    expect(model.calibration.validated).toBe(true);
    expect(unseenContext).toMatchObject({
      usageStage: 'shadow',
      active: false,
      canAffectScoreAndAlerts: false,
      contextCalibration: {
        feedbackCount: 0,
        validated: false,
      },
    });
    expect(unseenContext.validationReason).toContain('0 of 4 supporting parked decisions');
  });

  it('does not ratchet evidence confidence down when decorated data is decorated again', () => {
    const first = decorateRoadMemoryCandidates([
      ...exactFeedback(),
      candidate(20),
    ]);
    const firstActive = first.candidates.find((item) => item.id === 20);
    const second = decorateRoadMemoryCandidates(first.candidates);
    const secondActive = second.candidates.find((item) => item.id === 20);

    expect(secondActive).toMatchObject({
      evidenceConfidence: firstActive.evidenceConfidence,
      calibratedConfidence: firstActive.calibratedConfidence,
      confidence: firstActive.confidence,
      usageStage: 'validated',
      active: true,
      canAffectScoreAndAlerts: true,
    });
  });

  it('learns from adjustments and rejections without activating an inaccurate model', () => {
    const feedback = Array.from({ length: 8 }, (_, index) => candidate(index + 1, {
      reviewState: index < 3 ? 'confirmed' : index < 6 ? 'adjusted' : 'rejected',
      limitAtReviewKmh: 50,
      reviewedLimitKmh: index < 3 ? 50 : index < 6 ? 40 : null,
      feedbackOutcome: index < 3 ? 'exact' : index < 6 ? 'adjusted' : 'rejected',
    }));
    const calibration = buildRoadMemoryCalibration(feedback);
    expect(calibration.validated).toBe(false);
    expect(calibration.status).toBe('needs_tuning');
    expect(calibration.adjustedCount).toBe(3);
    expect(calibration.rejectedCount).toBe(2);
  });

  it('creates a short high-information queue and exposes an honest summary', () => {
    const items = Array.from({ length: 12 }, (_, index) => candidate(index + 1, {
      tripCount: index % 2 ? 2 : 4,
      agreement: index % 3 ? 1 : 0.75,
    }));
    const queue = buildRoadMemoryReviewQueue(items, { limit: 5 });
    const summary = summarizeRoadMemoryIntelligence(items);
    expect(queue.items).toHaveLength(5);
    expect(queue.items[0].why).toContain('strongest unverified');
    expect(summary.validatedCount).toBe(0);
    expect(summary.shadowCount).toBeGreaterThan(0);
    expect(summary.reviewQueueCount).toBe(8);
  });
});
