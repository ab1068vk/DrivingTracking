import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  encrypted: new Map(),
  nativeEvidence: [],
  saveUserCorrection: vi.fn(),
  listUserCorrections: vi.fn(),
  updateUserCorrection: vi.fn(),
  deleteEvidenceImage: vi.fn(),
  correctionMatchesPoint: vi.fn(),
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  getEncryptedJson: vi.fn(async (key, fallback) => mocks.encrypted.get(key) ?? fallback),
  setEncryptedJson: vi.fn(async (key, value) => {
    mocks.encrypted.set(key, structuredClone(value));
  }),
}));

vi.mock('@/lib/speedSignScanner', () => ({
  drainNativeSpeedSignEvidence: vi.fn(async () => {
    const result = mocks.nativeEvidence;
    mocks.nativeEvidence = [];
    return result;
  }),
  deleteSpeedSignEvidenceImage: (...args) => mocks.deleteEvidenceImage(...args),
}));

vi.mock('@/lib/localSpeedKnowledge', () => ({
  correctionMatchesPoint: (...args) => mocks.correctionMatchesPoint(...args),
  LocalSpeedKnowledge: class {
    listUserCorrections(...args) {
      return mocks.listUserCorrections(...args);
    }
    saveUserCorrection(...args) {
      return mocks.saveUserCorrection(...args);
    }
    updateUserCorrection(...args) {
      return mocks.updateUserCorrection(...args);
    }
  },
}));

vi.mock('@/lib/speedKnowledgeRepository', () => ({
  speedKnowledgeStore: {},
}));

import {
  importSpeedSignEvidence,
  listSpeedSignEvidence,
  reviewSpeedSignEvidence,
  routeContextForSpeedSignEvidence,
  SPEED_SIGN_EVIDENCE_STORAGE_KEY,
  syncNativeSpeedSignEvidence,
} from '@/lib/speedSignEvidence';

const evidence = (overrides = {}) => ({
  id: 'sign_123',
  tripId: 'trip-1',
  corridorId: 'corridor_abcdef',
  limitKmh: 50,
  displayedValue: 50,
  displayedUnit: 'km/h',
  confidence: 0.77,
  frameCount: 2,
  detectorMode: 'local_sign_proposal_v1',
  signTargetFound: true,
  signTargetScore: 0.73,
  timestamp: Date.now(),
  source: 'on_device_regulatory_text',
  qualifierStatus: 'regulatory_text_no_qualifiers',
  reviewImageAvailable: true,
  reviewImageExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  reviewImageDataUrl: 'data:image/jpeg;base64,THIS_MUST_NEVER_BE_PERSISTED',
  rawText: 'THIS MUST NEVER BE STORED',
  ...overrides,
});

const trip = () => ({
  id: 'trip-1',
  route_points: [
    { lat: 43.7, lng: -79.4, heading: 90, timestamp: new Date(Date.now() - 2_000).toISOString() },
    { lat: 43.7002, lng: -79.3998, heading: 91, timestamp: new Date(Date.now()).toISOString() },
    { lat: 43.7004, lng: -79.3996, heading: 92, timestamp: new Date(Date.now() + 2_000).toISOString() },
  ],
});

describe('speed sign evidence', () => {
  beforeEach(() => {
    mocks.encrypted.clear();
    mocks.nativeEvidence = [];
    mocks.saveUserCorrection.mockReset();
    mocks.saveUserCorrection.mockResolvedValue({ id: 'correction-1', limitKmh: 50 });
    mocks.listUserCorrections.mockReset();
    mocks.listUserCorrections.mockResolvedValue([]);
    mocks.updateUserCorrection.mockReset();
    mocks.updateUserCorrection.mockResolvedValue(true);
    mocks.deleteEvidenceImage.mockReset();
    mocks.deleteEvidenceImage.mockResolvedValue(true);
    mocks.correctionMatchesPoint.mockReset();
    mocks.correctionMatchesPoint.mockReturnValue(true);
  });

  it('stores only minimal normalized evidence and never activates it', async () => {
    await importSpeedSignEvidence([evidence()]);
    const stored = mocks.encrypted.get(SPEED_SIGN_EVIDENCE_STORAGE_KEY);

    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toHaveProperty('rawText');
    expect(stored[0]).not.toHaveProperty('reviewImageDataUrl');
    expect(stored[0]).toMatchObject({
      requiresParkedConfirmation: true,
      affectsScore: false,
      affectsVoiceAlerts: false,
      reviewImageAvailable: true,
      frameCount: 2,
      detectorMode: 'local_sign_proposal_v1',
      signTargetFound: true,
      signTargetScore: 0.73,
    });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['unknown', 'conditional_unrecognized'],
  ])('rejects a %s qualifier instead of converting it to an always-active rule', async (_label, qualifierStatus) => {
    await importSpeedSignEvidence([evidence({ qualifierStatus })]);

    expect(await listSpeedSignEvidence()).toHaveLength(0);
    await expect(reviewSpeedSignEvidence('sign_123', {
      action: 'confirm_posted',
      trip: trip(),
    })).resolves.toBeNull();
    expect(mocks.saveUserCorrection).not.toHaveBeenCalled();
    expect(mocks.updateUserCorrection).not.toHaveBeenCalled();
  });

  it('imports queued native evidence idempotently', async () => {
    mocks.nativeEvidence = [evidence(), evidence()];
    await syncNativeSpeedSignEvidence();

    expect(await listSpeedSignEvidence()).toHaveLength(1);
  });

  it('matches a camera timestamp to an existing public route without storing coordinates in evidence', () => {
    const candidate = evidence();
    expect(candidate).not.toHaveProperty('lat');
    expect(routeContextForSpeedSignEvidence(trip(), candidate)).toMatchObject({
      lat: 43.7002,
      lng: -79.3998,
      heading: 91,
    });
  });

  it('does not create a speed correction until the parked user confirms', async () => {
    await importSpeedSignEvidence([evidence()]);
    expect(mocks.saveUserCorrection).not.toHaveBeenCalled();

    await reviewSpeedSignEvidence('sign_123', {
      action: 'confirm_posted',
      trip: trip(),
      privacyZones: [],
    });

    expect(mocks.saveUserCorrection).toHaveBeenCalledWith(
      43.7002,
      -79.3998,
      50,
      expect.stringContaining('Confirmed by the user after parking'),
      null,
      [],
      'user_confirmed_posted_sign',
      expect.objectContaining({
        directionMode: 'forward',
        directionBearing: 91,
      })
    );
    expect(await listSpeedSignEvidence()).toHaveLength(0);
    expect(mocks.deleteEvidenceImage).toHaveBeenCalledWith('sign_123');
  });

  it('reverifies an existing matching confirmed road instead of creating a duplicate', async () => {
    const existing = {
      id: 'confirmed-road-1',
      source: 'user_confirmed_posted_sign',
      limitKmh: 50,
    };
    mocks.listUserCorrections.mockResolvedValue([existing]);
    await importSpeedSignEvidence([evidence()]);

    const result = await reviewSpeedSignEvidence('sign_123', {
      action: 'confirm_posted',
      trip: trip(),
    });

    expect(result.reverifiedExisting).toBe(true);
    expect(mocks.updateUserCorrection).toHaveBeenCalledWith(
      'confirmed-road-1',
      50,
      'user_confirmed_posted_sign',
      expect.any(String),
      expect.objectContaining({ evidenceIncrement: 1 })
    );
    expect(mocks.saveUserCorrection).not.toHaveBeenCalled();
  });

  it('matches an existing confirmed corridor outside its active schedule without creating a duplicate', async () => {
    const capturedAt = Date.now() - 10_000;
    const scheduledRule = {
      enabled: true,
      days: [1, 2, 3, 4, 5],
      startMinutes: 480,
      endMinutes: 540,
    };
    const existing = {
      id: 'confirmed-scheduled-road-1',
      source: 'user_confirmed_posted_sign',
      limitKmh: 40,
      qualifierStatus: 'conditional_school',
      timeRule: scheduledRule,
    };
    mocks.listUserCorrections.mockResolvedValue([existing]);
    mocks.correctionMatchesPoint.mockImplementation((correction, _lat, _lng, _radius, options = {}) => (
      correction === existing &&
      options.timestampMs === capturedAt &&
      options.ignoreSchedule === true
    ));
    await importSpeedSignEvidence([evidence({
      timestamp: capturedAt,
      limitKmh: 40,
      qualifierStatus: 'conditional_school',
    })]);

    const result = await reviewSpeedSignEvidence('sign_123', {
      action: 'confirm_posted',
      trip: trip(),
      condition: { days: [1, 2, 3, 4, 5], startMinutes: 480, endMinutes: 540 },
    });

    expect(result.reverifiedExisting).toBe(true);
    expect(mocks.correctionMatchesPoint).toHaveBeenCalledWith(
      existing,
      43.7,
      -79.4,
      undefined,
      expect.objectContaining({
        headingDeg: 90,
        timestampMs: capturedAt,
        ignoreSchedule: true,
      })
    );
    expect(mocks.correctionMatchesPoint).toHaveBeenCalledTimes(2);
    expect(mocks.updateUserCorrection).toHaveBeenCalledWith(
      existing.id,
      40,
      'user_confirmed_posted_sign',
      expect.any(String),
      expect.objectContaining({ timeRule: scheduledRule })
    );
    expect(mocks.saveUserCorrection).not.toHaveBeenCalled();
  });

  it('does not replace a different confirmed road speed without a second confirmation', async () => {
    mocks.listUserCorrections.mockResolvedValue([{
      id: 'confirmed-road-1',
      source: 'user_confirmed_posted_sign',
      limitKmh: 60,
    }]);
    await importSpeedSignEvidence([evidence({ limitKmh: 50 })]);

    const result = await reviewSpeedSignEvidence('sign_123', {
      action: 'confirm_posted',
      trip: trip(),
    });

    expect(result).toMatchObject({
      requiresReplacementConfirmation: true,
      proposedLimitKmh: 50,
    });
    expect(mocks.updateUserCorrection).not.toHaveBeenCalled();
    expect(mocks.saveUserCorrection).not.toHaveBeenCalled();
    expect(await listSpeedSignEvidence()).toHaveLength(1);
  });

  it('versions changed sign conditions even when the numeric speed is unchanged', async () => {
    const existing = {
      id: 'confirmed-road-1',
      source: 'user_confirmed_posted_sign',
      limitKmh: 50,
      qualifierStatus: 'regulatory_text_no_qualifiers',
      timeRule: { enabled: false },
    };
    await importSpeedSignEvidence([evidence({
      limitKmh: 50,
      qualifierStatus: 'conditional_school_when_flashing',
    })]);
    mocks.listUserCorrections.mockResolvedValue([existing]);

    const preview = await reviewSpeedSignEvidence('sign_123', {
      action: 'confirm_posted',
      trip: trip(),
      condition: { days: [1, 2, 3, 4, 5], startMinutes: 480, endMinutes: 1020 },
    });
    expect(preview).toMatchObject({
      requiresReplacementConfirmation: true,
      qualifierChanged: true,
      proposedLimitKmh: 50,
    });
    expect(mocks.updateUserCorrection).not.toHaveBeenCalled();

    const replacement = {
      ...existing,
      id: 'confirmed-road-2',
      supersedesCorrectionId: existing.id,
      qualifierStatus: 'conditional_school_when_flashing',
      timeRule: { enabled: true, days: [1, 2, 3, 4, 5], startMinutes: 480, endMinutes: 1020 },
    };
    mocks.listUserCorrections
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([{ ...existing, historicalVersion: true }, replacement]);
    const result = await reviewSpeedSignEvidence('sign_123', {
      action: 'confirm_posted',
      trip: trip(),
      replaceExistingConfirmed: true,
      condition: { days: [1, 2, 3, 4, 5], startMinutes: 480, endMinutes: 1020 },
    });

    expect(result).toMatchObject({ replacedExisting: true, qualifierChanged: true });
    expect(mocks.updateUserCorrection).toHaveBeenCalledWith(
      existing.id,
      50,
      'user_confirmed_posted_sign',
      expect.any(String),
      expect.objectContaining({
        qualifierStatus: 'conditional_school_when_flashing',
        timeRule: { enabled: true, days: [1, 2, 3, 4, 5], startMinutes: 480, endMinutes: 1020 },
        validFrom: expect.any(String),
      })
    );
  });

  it('rejects or defers without changing speed knowledge', async () => {
    await importSpeedSignEvidence([evidence()]);
    await reviewSpeedSignEvidence('sign_123', { action: 'defer' });

    expect(await listSpeedSignEvidence()).toHaveLength(0);
    expect(mocks.saveUserCorrection).not.toHaveBeenCalled();
    expect(mocks.deleteEvidenceImage).not.toHaveBeenCalled();

    const deferred = await listSpeedSignEvidence({ pendingOnly: false });
    expect(deferred[0].reviewState).toBe('deferred');
    expect(deferred[0].reviewImageAvailable).toBe(true);
    await reviewSpeedSignEvidence('sign_123', { action: 'reject' });
    expect(await listSpeedSignEvidence({ pendingOnly: false })).toHaveLength(0);
    expect(mocks.saveUserCorrection).not.toHaveBeenCalled();
    expect(mocks.deleteEvidenceImage).toHaveBeenCalledTimes(1);
  });

  it('refuses confirmation when the matching public route point is unavailable', async () => {
    await importSpeedSignEvidence([evidence()]);

    await expect(reviewSpeedSignEvidence('sign_123', {
      action: 'confirm_posted',
      trip: { id: 'trip-1', route_points: [] },
    })).rejects.toThrow(/public trip location is unavailable/i);
    expect(mocks.saveUserCorrection).not.toHaveBeenCalled();
    expect(mocks.deleteEvidenceImage).not.toHaveBeenCalled();
  });

  it('drops access to an expired review crop while preserving the minimal candidate', async () => {
    await importSpeedSignEvidence([evidence({
      reviewImageExpiresAt: Date.now() - 1,
    })]);

    const [stored] = await listSpeedSignEvidence();
    expect(stored.reviewImageAvailable).toBe(false);
    expect(stored.reviewImageExpiresAt).toBe(0);
  });

  it('requires a schedule before a school qualifier can affect speed knowledge', async () => {
    await importSpeedSignEvidence([evidence({
      qualifierStatus: 'conditional_school_when_flashing',
      conditional: true,
    })]);
    await expect(reviewSpeedSignEvidence('sign_123', {
      action: 'confirm_posted',
      trip: trip(),
    })).rejects.toThrow(/days and active hours/i);

    await reviewSpeedSignEvidence('sign_123', {
      action: 'confirm_posted',
      trip: trip(),
      condition: { days: [1, 2, 3, 4, 5], startMinutes: 480, endMinutes: 1020 },
    });
    expect(mocks.saveUserCorrection).toHaveBeenCalledWith(
      expect.any(Number), expect.any(Number), 50, expect.any(String), null, [],
      'user_confirmed_posted_sign',
      expect.objectContaining({
        qualifierStatus: 'conditional_school_when_flashing',
        timeRule: { enabled: true, days: [1, 2, 3, 4, 5], startMinutes: 480, endMinutes: 1020 },
      })
    );
  });

  it('requires a future expiry for temporary work-zone evidence', async () => {
    await importSpeedSignEvidence([evidence({
      qualifierStatus: 'conditional_temporary_work_zone',
      conditional: true,
    })]);
    await expect(reviewSpeedSignEvidence('sign_123', {
      action: 'confirm_posted',
      trip: trip(),
      condition: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    })).rejects.toThrow(/future expiry/i);
  });
});
