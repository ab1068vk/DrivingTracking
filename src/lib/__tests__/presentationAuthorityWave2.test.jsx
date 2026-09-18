import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildTripHistorySummary, TripHistoryFilteredSnapshot } from '@/pages/TripHistory';
import { derivePopulationState } from '@/hooks/useTripHistoryPageData';
import { PremiumFilteredSnapshot } from '@/components/PremiumTripHistoryPanels';
import TripCard from '@/components/TripCard';
import { CurrentFormReadout, MasteryCard } from '@/pages/Achievements';
import { buildDriverProgression } from '@/lib/driverProgression';
import { getScoreProvenanceStatus } from '@/lib/tripEngine';
import { SCORE_ESTIMATE_NOTICE, deriveAggregateScoreProvenance, isApproximateScoreOutput } from '@/lib/scoreDisplay';
import {
  MEASUREMENT_UNAVAILABLE_LABEL,
  summarizeMeasurementCoverage,
  tripDistanceKm,
  tripDurationSeconds,
} from '@/lib/measurementAvailability';

/**
 * Presentation Authority Wave 2 — HPR-001, HPR-008 and HPR-009.
 *
 * The three authorities stay separate on purpose and are asserted separately:
 * population completeness, measurement availability, and score provenance are
 * different claims and must not collapse into one "partial" flag.
 */

afterEach(() => { vi.unstubAllGlobals(); });

const ALL_COMPLETED_CLAIM = 'All completed trips matching the search and filters above.';

const historyTrip = (index, overrides = {}) => ({
  id: `wave2-trip-${index}`,
  status: 'completed',
  start_time: new Date(Date.UTC(2026, 7, 1 + index, 8, 0, 0)).toISOString(),
  end_time: new Date(Date.UTC(2026, 7, 1 + index, 8, 30, 0)).toISOString(),
  distance_km: 10,
  duration_seconds: 1_800,
  score_overall: 80,
  driver_metric_eligible: true,
  ...overrides,
});

const historyRows = (count, overrides = {}) => Array.from(
  { length: count },
  (_, index) => historyTrip(index, overrides),
);

const renderSnapshot = (summary) => renderToStaticMarkup(
  <TripHistoryFilteredSnapshot
    summary={summary}
    activeDateLabel="Any date"
    activeFilterLabel="All trips"
    activeTagLabel=""
    filterBy="all"
    selectedTags={[]}
    hasActiveFilters={false}
    onClearFilters={() => {}}
  />,
);

const renderPremiumSnapshot = (summary) => renderToStaticMarkup(
  <PremiumFilteredSnapshot summary={summary} filterLabel="All trips" tagLabel="" />,
);

const renderTripCard = (trip) => renderToStaticMarkup(
  <MemoryRouter><TripCard trip={trip} units="metric" /></MemoryRouter>,
);

/** Only what the card actually shows: class names and attributes are not copy. */
const visibleText = (html) => html
  .replace(/<[^>]*>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const progressionTrip = (index, overrides = {}) => ({
  id: `wave2-progression-${index}`,
  status: 'completed',
  start_time: new Date(Date.UTC(2026, 7, 1 + index, 9, 0, 0)).toISOString(),
  distance_km: 14,
  duration_seconds: 2_400,
  score_overall: 78,
  score_safety: 80,
  score_smoothness: 76,
  ...overrides,
});

describe('HPR-001 — population completeness authority', () => {
  it('A: a loaded prefix must not claim all matching completed trips', () => {
    const summary = buildTripHistorySummary(historyRows(60), 'metric', { populationState: 'MORE_AVAILABLE' });

    expect(summary.population.complete).toBe(false);
    expect(summary.population.moreAvailable).toBe(true);
    expect(summary.population.countLabel).toBe('at least 60');
    expect(summary.population.scopeSentence).not.toBe(ALL_COMPLETED_CLAIM);
    expect(summary.population.scopeSentence).toMatch(/read so far|loaded/i);
    expect(summary.population.scopeSentence).toMatch(/more/i);

    const classic = renderSnapshot(summary);
    expect(classic).not.toContain(ALL_COMPLETED_CLAIM);
    expect(classic).toContain('at least 60');
    expect(classic).toMatch(/more matching history/i);

    const premium = renderPremiumSnapshot(summary);
    expect(premium).not.toContain(ALL_COMPLETED_CLAIM);
    expect(premium).toMatch(/more matching history/i);
    expect(premium).toContain('at least 60');
  });

  it('B: a terminal population may state the stronger claim', () => {
    const summary = buildTripHistorySummary(historyRows(61), 'metric', { populationState: 'COMPLETE' });

    expect(summary.population.complete).toBe(true);
    expect(summary.population.moreAvailable).toBe(false);
    expect(summary.population.countLabel).toBe('61');
    expect(summary.population.scopeSentence).toBe(ALL_COMPLETED_CLAIM);

    const classic = renderSnapshot(summary);
    expect(classic).toContain(ALL_COMPLETED_CLAIM);
    expect(classic).not.toMatch(/more matching history/i);
    expect(renderPremiumSnapshot(summary)).not.toMatch(/more matching history/i);
  });

  it('C: a locally searched prefix is still a prefix', () => {
    // The caller filtered the loaded rows locally; unread history can hold more
    // matches, so exhausting the local matches proves nothing about the population.
    const searched = historyRows(60).filter((trip) => trip.id.endsWith('7'));
    const summary = buildTripHistorySummary(searched, 'metric', { populationState: 'MORE_AVAILABLE', locallyFiltered: true });

    expect(summary.population.complete).toBe(false);
    expect(summary.population.scopeSentence).not.toBe(ALL_COMPLETED_CLAIM);
    expect(summary.population.scopeSentence).toMatch(/read so far|loaded/i);
    expect(renderSnapshot(summary)).not.toContain(ALL_COMPLETED_CLAIM);
  });
});

describe('HPR-008 — measurement availability authority', () => {
  const degradedRow = {
    id: 'wave2-degraded',
    start_time: '2026-08-02T08:00:00.000Z',
    status: 'completed',
    projection_status: 'degraded',
    privacy_mode: 'unknown',
    route_replay_available: false,
  };

  it('reads absence and genuine zero as different measurements', () => {
    expect(tripDistanceKm(degradedRow)).toEqual({ known: false, value: null });
    expect(tripDurationSeconds(degradedRow)).toEqual({ known: false, value: null });
    expect(tripDistanceKm({ distance_km: 0 })).toEqual({ known: true, value: 0 });
    expect(tripDurationSeconds({ duration_seconds: 0 })).toEqual({ known: true, value: 0 });
    expect(tripDistanceKm({ distance_km: Number.NaN })).toEqual({ known: false, value: null });
  });

  it('renders an unreadable projection as unavailable, never as zero', () => {
    const text = visibleText(renderTripCard(degradedRow));
    expect(text).toContain(MEASUREMENT_UNAVAILABLE_LABEL);
    expect(text).not.toMatch(/(^|\s)0 m(\s|$)/);
    expect(text).not.toMatch(/(^|\s)0m(\s|$)/);
    expect(text).not.toMatch(/0\.0 km/);
  });

  it('keeps a genuine zero measurement rendered as zero', () => {
    const html = renderTripCard({
      ...degradedRow,
      id: 'wave2-known-zero',
      projection_status: 'ok',
      distance_km: 0,
      duration_seconds: 0,
      // A scored row: the score path has its own unavailable label, and this
      // case is about the measurement authority, not that one.
      score_overall: 80,
      score_provenance: { calibration_status: 'calibrated' },
    });
    const text = visibleText(html);
    expect(text).toMatch(/(^|\s)0 m(\s|$)/);
    expect(text).toMatch(/(^|\s)0m(\s|$)/);
    expect(text).not.toContain(MEASUREMENT_UNAVAILABLE_LABEL);
  });

  it('discloses incomplete measurement coverage instead of summing absence as zero', () => {
    const rows = [...historyRows(2), degradedRow];
    const coverage = summarizeMeasurementCoverage(rows, tripDistanceKm);
    expect(coverage).toMatchObject({ total: 20, knownCount: 2, unknownCount: 1, complete: false });

    const summary = buildTripHistorySummary(rows, 'metric', { populationState: 'COMPLETE' });
    expect(summary.distanceCoverage).toMatchObject({ knownCount: 2, unknownCount: 1, complete: false });
    expect(summary.durationCoverage).toMatchObject({ knownCount: 2, unknownCount: 1, complete: false });
    expect(summary.totalDistanceKm).toBe(20);
    expect(summary.measurementCoverageNote).toMatch(/1 trip/i);
    expect(summary.measurementCoverageNote).toMatch(/unavailable|not included/i);

    const classic = renderSnapshot(summary);
    expect(classic).toMatch(/unavailable|not included/i);
    expect(renderPremiumSnapshot(summary)).toMatch(/unavailable|not included/i);
  });

  it('says nothing about coverage when every measurement is known', () => {
    const summary = buildTripHistorySummary(historyRows(3), 'metric', { populationState: 'COMPLETE' });
    expect(summary.distanceCoverage.complete).toBe(true);
    expect(summary.measurementCoverageNote).toBeNull();
    expect(renderSnapshot(summary)).not.toMatch(/measurement/i);
  });
});

describe('HPR-009 — derived score provenance authority', () => {
  it('derives aggregate provenance conservatively from its constituents', () => {
    expect(deriveAggregateScoreProvenance([])).toEqual({ calibration_status: 'approximate' });
    expect(deriveAggregateScoreProvenance([{ calibration_status: 'calibrated' }, { calibration_status: 'calibrated' }]))
      .toEqual({ calibration_status: 'calibrated' });
    expect(deriveAggregateScoreProvenance([{ calibration_status: 'calibrated' }, null]))
      .toEqual({ calibration_status: 'approximate' });
    expect(deriveAggregateScoreProvenance([{ calibration_status: 'calibrated' }, { calibration_status: 'heuristic_beta' }]))
      .toEqual({ calibration_status: 'approximate' });
    expect(isApproximateScoreOutput(deriveAggregateScoreProvenance([{ calibration_status: 'calibrated' }]))).toBe(false);
  });

  it('marks derived mastery and current-form scores estimated when their inputs are', () => {
    const trips = Array.from({ length: 12 }, (_, index) => progressionTrip(index, {
      score_provenance: { calibration_status: 'approximate' },
    }));
    const progression = buildDriverProgression(trips, {}, { now: '2026-08-20T00:00:00.000Z' });

    expect(progression.currentForm.score).not.toBeNull();
    expect(isApproximateScoreOutput(progression.currentForm.scoreProvenance)).toBe(true);
    for (const track of progression.masteryTracks) {
      expect(isApproximateScoreOutput(track.scoreProvenance)).toBe(true);
    }

    const scored = progression.masteryTracks.find((track) => track.score != null);
    const html = renderToStaticMarkup(<MasteryCard track={scored} index={0} onOpen={() => {}} />);
    expect(html).toContain(`~${scored.score}`);
  });

  it('does not mark a fully calibrated derivation estimated', () => {
    const trips = Array.from({ length: 12 }, (_, index) => progressionTrip(index, {
      score_provenance: { calibration_status: 'calibrated' },
    }));
    const progression = buildDriverProgression(trips, {}, { now: '2026-08-20T00:00:00.000Z' });

    expect(isApproximateScoreOutput(progression.currentForm.scoreProvenance)).toBe(false);
    const scored = progression.masteryTracks.find((track) => track.score != null);
    const html = renderToStaticMarkup(<MasteryCard track={scored} index={0} onOpen={() => {}} />);
    expect(html).toContain(`Form ${scored.score}`);
    expect(html).not.toContain(`~${scored.score}`);
  });

  it('keeps the two inline Achievements score readouts on the central display rule', async () => {
    const source = await import('node:fs').then(({ readFileSync }) => readFileSync(
      new URL('../../pages/Achievements.jsx', import.meta.url), 'utf8',
    ));
    // The mastery grid and Current Form readouts are inline in the page body, so the
    // behavioural proof above is complemented by pinning them to the shared helper
    // rather than to a bare value. This is a structural guard, not runtime evidence.
    expect(source).not.toMatch(/\{track\.score \?\? '—'\}/);
    expect(source).not.toMatch(/\{progression\.currentForm\.score \?\? '—'\}/);
    expect(source).toContain('formatScoreWithProvenance');
  });
});

describe('Wave 2 — composed presentation authority', () => {
  it('keeps population, measurement and provenance claims separate and truthful together', () => {
    const rows = [
      ...historyRows(4),
      {
        id: 'wave2-composed-degraded',
        status: 'completed',
        start_time: '2026-08-09T08:00:00.000Z',
        projection_status: 'degraded',
      },
    ];
    const summary = buildTripHistorySummary(rows, 'metric', { populationState: 'MORE_AVAILABLE' });

    // Population: a prefix, and it says so.
    expect(summary.population.complete).toBe(false);
    expect(summary.population.countLabel).toBe('at least 5');
    // Measurement: the known rows still aggregate exactly; the unknown one is disclosed.
    expect(summary.totalDistanceKm).toBe(40);
    expect(summary.distanceCoverage).toMatchObject({ knownCount: 4, unknownCount: 1, complete: false });
    // HPR-014 preservation: the driver score stays distance-weighted over the
    // eligible population and keeps its completeness-neutral explanation.
    expect(summary.averageScore).toBe(80);
    expect(summary.averageScoreTripCount).toBe(4);
    expect(summary.averageScoreDescription).toMatch(/represented in this History view/);
    expect(summary.averageScoreDescription).not.toMatch(/all completed/i);

    const classic = renderSnapshot(summary);
    expect(classic).not.toContain(ALL_COMPLETED_CLAIM);
    expect(classic).toContain('at least 5');
    expect(classic).toMatch(/unavailable|not included/i);

    // Provenance is a different authority and is not implied by either of the above.
    expect(summary.population).not.toHaveProperty('approximate');
    expect(summary.distanceCoverage).not.toHaveProperty('approximate');

    const progression = buildDriverProgression(
      Array.from({ length: 12 }, (_, index) => progressionTrip(index, {
        score_provenance: { calibration_status: 'approximate' },
      })),
      {},
      { now: '2026-08-20T00:00:00.000Z' },
    );
    expect(isApproximateScoreOutput(progression.currentForm.scoreProvenance)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wave 2 correction pass — the four mechanisms CODEX reproduced against the
// frozen implementation. Each is asserted through the production path that
// actually produces the claim, not through a helper stand-in.
// ---------------------------------------------------------------------------

describe('HPR-001 correction — blocked continuation is not authoritative EOF', () => {
  const STORAGE_UNAVAILABLE = { code: 'STORAGE_UNAVAILABLE', reason: 'page_read_failed' };

  it('classifies the three population states from the real pagination inputs', () => {
    expect(derivePopulationState({ cursor: 'c1', unavailable: null })).toBe('MORE_AVAILABLE');
    expect(derivePopulationState({ cursor: null, unavailable: null })).toBe('COMPLETE');
    // A retained prefix whose next page failed still has unread history behind it.
    expect(derivePopulationState({ cursor: 'c1', unavailable: STORAGE_UNAVAILABLE })).toBe('COMPLETENESS_UNKNOWN');
    // Even a lost cursor is not proof of EOF once a read has failed.
    expect(derivePopulationState({ cursor: null, unavailable: STORAGE_UNAVAILABLE })).toBe('COMPLETENESS_UNKNOWN');
  });

  it('never claims the whole population while a continuation is blocked', () => {
    const blocked = buildTripHistorySummary(historyRows(60), 'metric', {
      populationState: derivePopulationState({ cursor: 'c1', unavailable: STORAGE_UNAVAILABLE }),
    });

    expect(blocked.population.complete).toBe(false);
    expect(blocked.population.state).toBe('COMPLETENESS_UNKNOWN');
    expect(blocked.population.countLabel).toBe('at least 60');
    expect(blocked.population.scopeSentence).not.toBe(ALL_COMPLETED_CLAIM);
    expect(blocked.population.scopeSentence).toMatch(/could not be read/i);

    const classic = renderSnapshot(blocked);
    expect(classic).not.toContain(ALL_COMPLETED_CLAIM);
    expect(classic).toContain('at least 60');
    expect(classic).toMatch(/could not be read/i);

    const premium = renderPremiumSnapshot(blocked);
    expect(premium).not.toContain(ALL_COMPLETED_CLAIM);
    expect(premium).toMatch(/could not be read/i);

    // Recovery: only an authoritative terminal read restores the stronger claim.
    const recovered = buildTripHistorySummary(historyRows(61), 'metric', {
      populationState: derivePopulationState({ cursor: null, unavailable: null }),
    });
    expect(recovered.population.state).toBe('COMPLETE');
    expect(renderSnapshot(recovered)).toContain(ALL_COMPLETED_CLAIM);
  });

  it('keeps the pagination authority as the only source of completeness', () => {
    const hook = readFileSync(new URL('../../hooks/useTripHistoryPageData.js', import.meta.url), 'utf8');
    const page = readFileSync(new URL('../../pages/TripHistory.jsx', import.meta.url), 'utf8');
    // The hook owns the cursor and the typed unavailable state, so it computes the
    // population state; the page transports it without re-deriving completeness.
    expect(hook).toContain('populationState: derivePopulationState(');
    expect(page).toContain('populationState: historyPopulationState');
    expect(page).not.toMatch(/populationState:\s*(historyHasMore|sorted\.length|completed\.length)/);
  });
});

describe('HPR-008 correction — premium cards share the measurement authority', () => {
  const premiumDegraded = {
    id: 'wave2-premium-degraded',
    status: 'completed',
    start_time: '2026-08-03T08:00:00.000Z',
    projection_status: 'degraded',
    score_overall: 80,
    score_provenance: { calibration_status: 'calibrated' },
  };
  const renderPremiumCard = (trip, compact) => visibleText(renderToStaticMarkup(
    <MemoryRouter><TripCard trip={trip} units="metric" premium compact={compact} /></MemoryRouter>,
  ));

  it.each([['compact', true], ['expanded', false]])(
    'renders unavailable measurements as unavailable in the %s premium path',
    (_label, compact) => {
      const text = renderPremiumCard(premiumDegraded, compact);
      expect(text).toContain(MEASUREMENT_UNAVAILABLE_LABEL);
      expect(text).not.toMatch(/(^|\s)0 m(\s|$)/);
      expect(text).not.toMatch(/(^|\s)0m(\s|$)/);
      expect(text).not.toMatch(/0\.0 km/);
    },
  );

  it('keeps a genuine zero numeric in the premium path', () => {
    const text = renderPremiumCard({ ...premiumDegraded, distance_km: 0, duration_seconds: 0 }, false);
    expect(text).toMatch(/(^|\s)0 m(\s|$)/);
    expect(text).toMatch(/(^|\s)0m(\s|$)/);
    expect(text).not.toContain(MEASUREMENT_UNAVAILABLE_LABEL);
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('treats %s distance and duration as unavailable in the premium path', (_label, value) => {
    const text = renderPremiumCard({ ...premiumDegraded, distance_km: value, duration_seconds: value }, false);
    expect(text).toContain(MEASUREMENT_UNAVAILABLE_LABEL);
    expect(text).not.toMatch(/(^|\s)0 m(\s|$)/);
    expect(text).not.toMatch(/(^|\s)0m(\s|$)/);
  });
});

describe('HPR-009 correction — supported unknown legacy provenance is not exact', () => {
  it('classifies every supported score-output status', () => {
    expect(isApproximateScoreOutput({ calibration_status: 'calibrated' })).toBe(false);
    expect(isApproximateScoreOutput({ calibration_status: 'approximate' })).toBe(true);
    expect(isApproximateScoreOutput(null)).toBe(true);
    expect(isApproximateScoreOutput({ calibration_status: 'unknown_legacy_unrescored' })).toBe(true);
    // An unrecognised token is not proof of calibration.
    expect(isApproximateScoreOutput({ calibration_status: 'something_new' })).toBe(true);
    expect(deriveAggregateScoreProvenance([
      { calibration_status: 'unknown_legacy_unrescored' },
      { calibration_status: 'unknown_legacy_unrescored' },
    ])).toEqual({ calibration_status: 'approximate' });
  });

  it('qualifies unknown-legacy derivations through the projection and progression chain', () => {
    // `localTripRepository.create` recomputes provenance on write, so this status
    // is produced only by the repository's own legacy tagging and then carried by
    // the projection. The row shape below is exactly what that transport delivers,
    // and the trip-engine contract already classifies it as unrescored.
    expect(getScoreProvenanceStatus({
      score_provenance: { calibration_status: 'unknown_legacy_unrescored' },
    })).toMatchObject({ status: 'unknown_legacy_unrescored', needsRescore: true });

    const rows = Array.from({ length: 24 }, (_, index) => progressionTrip(index, {
      driver_metric_eligible: true,
      score_provenance: { calibration_status: 'unknown_legacy_unrescored' },
    }));
    const progression = buildDriverProgression(rows, {}, { now: '2026-08-20T00:00:00.000Z' });
    expect(progression.currentForm.score).not.toBeNull();
    expect(isApproximateScoreOutput(progression.currentForm.scoreProvenance)).toBe(true);

    const scored = progression.masteryTracks.find((track) => track.score != null);
    const card = renderToStaticMarkup(<MasteryCard track={scored} index={0} onOpen={() => {}} />);
    expect(card).toContain(`~${scored.score}`);
    const form = visibleText(renderToStaticMarkup(<CurrentFormReadout currentForm={progression.currentForm} />));
    expect(form).toMatch(/~\d+/);
  });
});

describe('HPR-009 correction — the Current Form notice follows the shown score', () => {
  const formProgression = (status) => buildDriverProgression(
    Array.from({ length: 12 }, (_, index) => progressionTrip(index, {
      ...(status ? { score_provenance: { calibration_status: status } } : {}),
    })),
    {},
    { now: '2026-08-20T00:00:00.000Z' },
  );
  const renderForm = (progression) => renderToStaticMarkup(
    <CurrentFormReadout currentForm={progression.currentForm} />,
  );
  const noticeCount = (html) => html.split(SCORE_ESTIMATE_NOTICE).length - 1;

  it('shows exactly one estimate notice for an approximate derived score', () => {
    const html = renderForm(formProgression('approximate'));
    expect(noticeCount(html)).toBe(1);
    expect(visibleText(html)).toMatch(/~\d+/);
  });

  it('shows no estimate notice for a fully calibrated derived score', () => {
    const progression = formProgression('calibrated');
    const html = renderForm(progression);
    expect(noticeCount(html)).toBe(0);
    expect(visibleText(html)).toContain(String(progression.currentForm.score));
    expect(visibleText(html)).not.toMatch(/~\d+/);
  });

  it('shows no estimate notice and fabricates nothing when there is no form score', () => {
    // Completed but ineligible: below the progression distance/duration minimums.
    const progression = buildDriverProgression(
      Array.from({ length: 6 }, (_, index) => progressionTrip(index, { distance_km: 0.4, duration_seconds: 60 })),
      {},
      { now: '2026-08-20T00:00:00.000Z' },
    );
    expect(progression.currentForm.score).toBeNull();
    const html = renderForm(progression);
    expect(noticeCount(html)).toBe(0);
    expect(html).not.toContain('~null');
    expect(html).not.toContain('NaN');
    expect(visibleText(html)).toContain('—');
  });
});

describe('Wave 2 correction — composed', () => {
  it('holds all four authorities together, then relaxes only on real evidence', () => {
    const blocked = buildTripHistorySummary(
      [...historyRows(4), { id: 'composed-degraded', status: 'completed', start_time: '2026-08-09T08:00:00.000Z', projection_status: 'degraded' }],
      'metric',
      { populationState: derivePopulationState({ cursor: 'c1', unavailable: { code: 'STORAGE_UNAVAILABLE', reason: 'page_read_failed' } }) },
    );
    expect(blocked.population.state).toBe('COMPLETENESS_UNKNOWN');
    expect(renderSnapshot(blocked)).not.toContain(ALL_COMPLETED_CLAIM);
    expect(blocked.distanceCoverage).toMatchObject({ knownCount: 4, unknownCount: 1, complete: false });

    const premiumText = visibleText(renderToStaticMarkup(
      <MemoryRouter>
        <TripCard
          trip={{
            id: 'composed-degraded',
            status: 'completed',
            start_time: '2026-08-09T08:00:00.000Z',
            projection_status: 'degraded',
            score_overall: 80,
            score_provenance: { calibration_status: 'calibrated' },
          }}
          units="metric"
          premium
        />
      </MemoryRouter>,
    ));
    expect(premiumText).toContain(MEASUREMENT_UNAVAILABLE_LABEL);
    expect(premiumText).not.toMatch(/(^|\s)0 m(\s|$)/);

    const legacy = buildDriverProgression(
      Array.from({ length: 12 }, (_, index) => progressionTrip(index, {
        score_provenance: { calibration_status: 'unknown_legacy_unrescored' },
      })),
      {},
      { now: '2026-08-20T00:00:00.000Z' },
    );
    expect(isApproximateScoreOutput(legacy.currentForm.scoreProvenance)).toBe(true);
    const legacyForm = renderToStaticMarkup(<CurrentFormReadout currentForm={legacy.currentForm} />);
    expect(legacyForm.split(SCORE_ESTIMATE_NOTICE).length - 1).toBe(1);
    expect(visibleText(legacyForm)).toMatch(/~\d+/);

    // Real evidence arrives: terminal EOF, recorded zeros, calibrated inputs.
    const complete = buildTripHistorySummary(historyRows(3, { distance_km: 0, duration_seconds: 0 }), 'metric', {
      populationState: derivePopulationState({ cursor: null, unavailable: null }),
    });
    expect(complete.population.state).toBe('COMPLETE');
    expect(renderSnapshot(complete)).toContain(ALL_COMPLETED_CLAIM);
    expect(complete.distanceCoverage).toMatchObject({ knownCount: 3, unknownCount: 0, complete: true });
    expect(complete.totalDistanceKm).toBe(0);
    expect(complete.measurementCoverageNote).toBeNull();

    const calibrated = buildDriverProgression(
      Array.from({ length: 12 }, (_, index) => progressionTrip(index, {
        score_provenance: { calibration_status: 'calibrated' },
      })),
      {},
      { now: '2026-08-20T00:00:00.000Z' },
    );
    const calibratedForm = renderToStaticMarkup(<CurrentFormReadout currentForm={calibrated.currentForm} />);
    expect(calibratedForm.split(SCORE_ESTIMATE_NOTICE).length - 1).toBe(0);
    expect(visibleText(calibratedForm)).not.toMatch(/~\d+/);
  });
});
