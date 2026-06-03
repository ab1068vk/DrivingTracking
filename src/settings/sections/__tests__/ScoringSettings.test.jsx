import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/lib/trackingStore';
import { ScoringSettings } from '@/settings/sections/ScoringSettings';

const Icon = (props) => <svg {...props} />;
const CalibrationStatusTag = () => <span>Provisional</span>;

function scoringContext(overrides = {}) {
  const cfg = {
    ...DEFAULT_SETTINGS,
    ...overrides.cfg,
  };
  return {
    AlertTriangle: Icon,
    Bell: Icon,
    ChevronRight: Icon,
    Check: Icon,
    Clock: Icon,
    Droplets: Icon,
    Gauge: Icon,
    Info: Icon,
    Lock: Icon,
    Route: Icon,
    SlidersHorizontal: Icon,
    Unlock: Icon,
    AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO: 0.25,
    CALIBRATION_STATUSES: { PROVISIONAL: 'provisional' },
    CalibrationStatusTag,
    COMMUTE_MATCH_RADIUS_M: 150,
    NIGHT_END_TIME: '05:00',
    NIGHT_START_TIME: '22:00',
    PENALTY_SCALE_CALIBRATION: {
      affected_metrics: [],
      calibration_note: 'Shared calibration note',
      calibration_status: 'provisional',
      label: 'Penalty scale',
      value: 40,
    },
    PROVISIONAL_SCORING_CONSTANTS: [],
    PUBLIC_OSRM_DEMO_URL: 'https://router.project-osrm.org',
    SCORING_VERSION: 'test',
    SPEED_LIMIT_DEFAULT_COUNTRY_LABELS: { global: 'Global' },
    autoRescoreVisible: false,
    calibLoading: false,
    calibProfile: null,
    calibrationEntryForSetting: vi.fn(() => null),
    calibrationStatusLabel: (status) => status,
    cfg,
    dismissCalibration: vi.fn(),
    ecoScoreWarning: vi.fn(() => null),
    enableOsrmMapMatching: vi.fn(),
    isPublicOsrmDemoUrl: vi.fn(() => false),
    osrmEndpointDraft: '',
    rescoreCompleted: 0,
    rescoreProgress: null,
    rescoreProgressPct: 0,
    rescoreStatus: '',
    rescoreTotal: 0,
    rescoreTrips: vi.fn(),
    runCalibration: vi.fn(),
    scoreMigrationSummary: {
      auto_rescore_threshold_ratio: 0.25,
      mismatch_count: 0,
      recent_mismatch_ratio: 0,
      scoring_version: 'test',
      trips: [],
      unavailable_score_count: 0,
    },
    setPatternGuideOpen: vi.fn(),
    setThresholdEditingEnabled: vi.fn(),
    sliderWarning: vi.fn(() => null),
    speedLimitDefaultCountryKey: vi.fn(() => 'global'),
    thresholdEditingEnabled: false,
    updateCfg: vi.fn(),
    updateExternalContextAutoFetch: vi.fn(),
    updateNightMode: vi.fn(),
    ...overrides,
  };
}

describe('ScoringSettings', () => {
  it('renders detection thresholds with the split settings context', () => {
    const html = renderToStaticMarkup(
      <ScoringSettings
        ctx={scoringContext()}
        visibleSectionIds={['settings-detection-thresholds']}
      />
    );

    expect(html).toContain('Detection Features');
    expect(html).toContain('Eco Cruise Multiplier');
    expect(html).not.toContain('Something went wrong');
  });
});
