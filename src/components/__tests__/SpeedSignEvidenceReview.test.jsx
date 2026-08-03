import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  android: false,
  settings: {
    speed_sign_scanner_enabled: false,
    units: 'metric',
  },
}));

vi.mock('@/hooks/useLocalSettings', () => ({
  default: () => mocks.settings,
}));

vi.mock('@/lib/nativePlatform', () => ({
  isAndroid: () => mocks.android,
  openNativeSettings: vi.fn(async () => true),
}));

vi.mock('@/lib/speedSignScanner', () => ({
  getSpeedSignEvidenceImage: vi.fn(async () => null),
  getSpeedSignScannerStatus: vi.fn(async () => ({
    cameraPermission: 'prompt',
    pendingEvidenceCount: 0,
  })),
  requestSpeedSignCameraPermission: vi.fn(async () => ({
    cameraPermission: 'granted',
    pendingEvidenceCount: 0,
  })),
}));

vi.mock('@/lib/speedSignEvidence', () => ({
  listSpeedSignEvidence: vi.fn(async () => []),
  reviewSpeedSignEvidence: vi.fn(),
  SPEED_SIGN_EVIDENCE_CHANGED_EVENT: 'roadsage-speed-sign-evidence-changed',
  syncNativeSpeedSignEvidence: vi.fn(async () => []),
}));

import SpeedSignEvidenceReview, {
  emptySpeedSignConditionDraft,
  SPEED_SIGN_CONDITION_INSTRUCTION,
  speedSignConditionDraftError,
} from '@/components/SpeedSignEvidenceReview';

const renderReview = () => renderToStaticMarkup(
  <MemoryRouter>
    <SpeedSignEvidenceReview showAll showEmpty />
  </MemoryRouter>
);

describe('SpeedSignEvidenceReview empty workspace', () => {
  beforeEach(() => {
    mocks.android = false;
    mocks.settings = {
      speed_sign_scanner_enabled: false,
      units: 'metric',
    };
  });

  it('stays visible with a clear browser-versus-Android explanation', () => {
    const html = renderReview();

    expect(html).toContain('Camera sign review');
    expect(html).toContain('No speed-sign pictures are waiting');
    expect(html).toContain('Android app only');
    expect(html).toContain('cannot request the phone’s Android camera permission');
    expect(html).toContain('/settings?section=settings-speed-warning');
  });

  it('shows a real permission action when enabled in the Android app', () => {
    mocks.android = true;
    mocks.settings = {
      speed_sign_scanner_enabled: true,
      units: 'metric',
    };

    const html = renderReview();
    expect(html).toContain('Scanner enabled');
    expect(html).toContain('Checking camera');
    expect(html).toContain('Grant camera access');
  });
});

describe('SpeedSignEvidenceReview conditional confirmation', () => {
  const scheduledEvidence = {
    conditional: true,
    qualifierStatus: 'conditional_school_when_flashing',
  };
  const temporaryEvidence = {
    conditional: true,
    qualifierStatus: 'conditional_temporary_work_zone',
  };
  const nowMs = Date.parse('2026-08-02T12:00:00.000Z');

  it('starts every candidate with blank, explicitly user-entered condition fields', () => {
    expect(emptySpeedSignConditionDraft()).toEqual({
      days: '',
      start: '',
      end: '',
      expiry: '',
    });
    expect(SPEED_SIGN_CONDITION_INSTRUCTION).toContain('No schedule is guessed');
    expect(speedSignConditionDraftError(scheduledEvidence, emptySpeedSignConditionDraft(), nowMs))
      .toContain('Choose the active days');
  });

  it('requires days and two distinct valid times before a scheduled condition can be confirmed', () => {
    expect(speedSignConditionDraftError(scheduledEvidence, {
      days: 'weekdays',
      start: '',
      end: '',
    }, nowMs)).toContain('Enter both active times');
    expect(speedSignConditionDraftError(scheduledEvidence, {
      days: 'weekdays',
      start: '08:00',
      end: '08:00',
    }, nowMs)).toContain('must be different');
    expect(speedSignConditionDraftError(scheduledEvidence, {
      days: 'weekdays',
      start: '08:00',
      end: '17:00',
    }, nowMs)).toBe('');
  });

  it('requires a future explicit expiry for a temporary work-zone condition', () => {
    expect(speedSignConditionDraftError(temporaryEvidence, { expiry: '' }, nowMs))
      .toContain('Choose a future expiry date');
    expect(speedSignConditionDraftError(temporaryEvidence, { expiry: '2026-08-01' }, nowMs))
      .toContain('Choose a future expiry date');
    expect(speedSignConditionDraftError(temporaryEvidence, { expiry: '2026-08-03' }, nowMs))
      .toBe('');
  });

  it('does not require condition fields for an unconditional sign', () => {
    expect(speedSignConditionDraftError({
      conditional: false,
      qualifierStatus: 'regulatory_text_no_qualifiers',
    }, emptySpeedSignConditionDraft(), nowMs)).toBe('');
  });
});
