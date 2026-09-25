import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPORT_STATE } from '@/lib/reportPresentation';
import { reportPreviousWindow, reportWindow } from '@/hooks/useReportData';

/**
 * DPD-019 — one period definition, and a label that matches it.
 *
 * Observed on the A54, on one card, at one moment:
 *
 *   "No completed trips in this period"
 *   "15 trips covered 205.2 km"
 *   "6 active days"
 *
 * and, with 500 trips on the device, "No completed trips in this period" on the
 * **All Time** tab as well. Two independent faults produced that:
 *
 *  1. The labels named CALENDAR windows ("This Week", "This Month") over
 *     reducers bound to a ROLLING one (`reportWindow` = `now - days` → `now`).
 *  2. `buildReportExportSummary` concluded the emptiness sentence from an EMPTY
 *     ROW ARRAY — and since P7 the page deliberately passes `[]`, because
 *     nothing on it renders from a row fold. So the sentence printed
 *     unconditionally, whatever the period actually held.
 *
 * The clock is pinned here so week boundaries are facts rather than whatever
 * day the suite happens to run on. 2026-09-20 is a Sunday — the exact date of
 * the device reading, chosen because a Sunday is the worst case: the calendar
 * week has just started and is empty while the rolling week is full.
 */

const SUNDAY_2026_09_20 = new Date('2026-09-20T18:00:00.000Z');
const DAY_MS = 86_400_000;

let buildReportExportSummary;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(SUNDAY_2026_09_20);
  ({ buildReportExportSummary } = await import('@/pages/Report'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('report period labels name the window the reducers actually use', () => {
  it('is a rolling window, so it is not called a calendar one', () => {
    const now = SUNDAY_2026_09_20.getTime();
    const week = reportWindow('week', 7, now);

    // The definition itself: seven days back from now, not Sunday 00:00.
    expect(week.toMs).toBe(now);
    expect(week.fromMs).toBe(now - 7 * DAY_MS);
    expect(new Date(week.fromMs).getTime()).toBeLessThan(
      new Date('2026-09-20T00:00:00.000Z').getTime(),
    );

    const summary = buildReportExportSummary([], 'week', { totalTrips: 15, state: REPORT_STATE.EXACT });
    expect(summary.periodLabel).toBe('Last 7 days');
    expect(summary.periodLabel).not.toContain('This Week');
    expect(summary.formats).toContain('Last 7 days PDF');
  });

  it('names the month window by its length too', () => {
    expect(buildReportExportSummary([], 'month', { totalTrips: 40, state: REPORT_STATE.EXACT }).periodLabel)
      .toBe('Last 30 days');
    expect(buildReportExportSummary([], 'all', { totalTrips: 500, state: REPORT_STATE.EXACT }).periodLabel)
      .toBe('All time');
  });

  it('keeps the prior window immediately adjacent and equal in length', () => {
    const now = SUNDAY_2026_09_20.getTime();
    const current = reportWindow('week', 7, now);
    const previous = reportPreviousWindow('week', 7, now);
    expect(previous.toMs).toBe(current.fromMs);
    expect(previous.toMs - previous.fromMs).toBe(current.toMs - current.fromMs);
    // All Time has no prior window by design, and the UI says so rather than
    // rendering a zero delta.
    expect(reportWindow('all', Infinity, now)).toBeNull();
    expect(reportPreviousWindow('all', Infinity, now)).toBeNull();
  });
});

describe('the export card cannot call a populated period empty', () => {
  it('does not conclude emptiness from an empty row array', () => {
    // The exact device case: a Sunday, whose calendar week holds nothing, while
    // the rolling week the page actually totals holds 15 trips.
    const summary = buildReportExportSummary([], 'week', {
      totalTrips: 15,
      state: REPORT_STATE.EXACT,
    });

    expect(summary.dateRangeLabel).not.toBe('No completed trips in this period');
    expect(summary.dateRangeLabel).toBe('15 trips in this period');
    expect(summary.description).toBe('15 completed trips included');
    expect(summary.tripCount).toBe(15);
  });

  it('cannot report All Time as empty while the device holds 500 trips', () => {
    const summary = buildReportExportSummary([], 'all', {
      totalTrips: 500,
      state: REPORT_STATE.PARTIAL,
    });

    expect(summary.dateRangeLabel).not.toContain('No completed trips');
    expect(summary.tripCount).toBe(500);
    // Partial All Time is a floor, and says so rather than claiming completion.
    expect(summary.description).toBe('500 completed trips included so far');
  });

  it('still shows the genuine empty state when the period really is empty', () => {
    const summary = buildReportExportSummary([], 'week', {
      totalTrips: 0,
      state: REPORT_STATE.EXACT_EMPTY,
    });
    // The one truthful no-trips sentence, preserved deliberately.
    expect(summary.dateRangeLabel).toBe('No completed trips in this period');
    expect(summary.description).toBe('Exports unlock after a completed trip matches the selected period.');
  });

  it('does not call a still-loading period empty', () => {
    const summary = buildReportExportSummary([], 'all', {
      totalTrips: 0,
      state: REPORT_STATE.LOADING,
      periodStart: null,
      periodEnd: null,
    });
    expect(summary.description).toBe('Counting the trips in this period…');
    expect(summary.description).not.toMatch(/Exports unlock/); // the A54 All-time reading while loading
    expect(summary.dateRangeLabel).toBe('Counting this period…');
  });

  it('does not render null period bounds as the epoch (DPD-038)', () => {
    // The page passes the reducers' null bounds for an empty period, not undefined.
    const summary = buildReportExportSummary([], 'week', {
      totalTrips: 0,
      state: REPORT_STATE.EXACT_EMPTY,
      periodStart: null,
      periodEnd: null,
    });
    expect(summary.dateRangeLabel).toBe('No completed trips in this period');
    expect(summary.dateRangeLabel).not.toMatch(/Dec 31/); // the A54 reading
  });

  it('separates "nothing counted yet" from "nothing recorded"', () => {
    const partial = buildReportExportSummary([], 'week', { totalTrips: 0, state: REPORT_STATE.PARTIAL });
    expect(partial.dateRangeLabel).toBe('No trips counted so far');
    expect(partial.dateRangeLabel).not.toBe('No completed trips in this period');
  });

  it('separates a refusal from both of them', () => {
    const refused = buildReportExportSummary([], 'week', { totalTrips: 0, state: REPORT_STATE.UNAVAILABLE });
    expect(refused.dateRangeLabel).toBe('Date range could not be read');
    expect(refused.description).toContain('Your saved trips were not changed.');
  });

  it('uses the observed period bounds when the rows themselves are not fetched', () => {
    const summary = buildReportExportSummary([], 'week', {
      totalTrips: 15,
      state: REPORT_STATE.EXACT,
      periodStart: '2026-09-14T08:00:00.000Z',
      periodEnd: '2026-09-18T19:30:00.000Z',
    });
    expect(summary.dateRangeLabel).toContain(' to ');
    expect(summary.dateRangeLabel).not.toContain('No completed trips');
  });

  it('marks a bounded range as still growing rather than as the final span', () => {
    const summary = buildReportExportSummary([], 'all', {
      totalTrips: 200,
      state: REPORT_STATE.PARTIAL,
      periodStart: '2026-01-02T08:00:00.000Z',
      periodEnd: '2026-09-18T19:30:00.000Z',
    });
    expect(summary.dateRangeLabel).toMatch(/ so far$/);
  });

  it('still reads the rows when the caller does have them', () => {
    const rows = [
      { start_time: '2026-09-14T08:00:00.000Z' },
      { start_time: '2026-09-18T19:30:00.000Z' },
    ];
    const summary = buildReportExportSummary(rows, 'month');
    expect(summary.tripCount).toBe(2);
    expect(summary.dateRangeLabel).toContain(' to ');
  });
});
