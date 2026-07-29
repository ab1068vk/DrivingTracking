import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  PREMIUM_HISTORY_PAGE_SIZE,
  PremiumFilteredSnapshot,
  PremiumHistoryResultsPager,
  PremiumHistorySearch,
  buildPremiumHistorySparkline,
  getPremiumHistoryTimePresentation,
  getPremiumHistoryValueSize,
  getPremiumHistoryPageWindow,
} from '@/components/PremiumTripHistoryPanels';

describe('PremiumTripHistoryPanels', () => {
  it('builds safe 30-result windows for first, last, and reduced result sets', () => {
    expect(PREMIUM_HISTORY_PAGE_SIZE).toBe(30);
    expect(getPremiumHistoryPageWindow(61, 0)).toEqual({
      page: 0,
      pageCount: 3,
      offset: 0,
      start: 1,
      end: 30,
    });
    expect(getPremiumHistoryPageWindow(61, 2)).toEqual({
      page: 2,
      pageCount: 3,
      offset: 60,
      start: 61,
      end: 61,
    });
    expect(getPremiumHistoryPageWindow(4, 8)).toMatchObject({ page: 0, pageCount: 1, start: 1, end: 4 });
    expect(getPremiumHistoryPageWindow(0, 0)).toMatchObject({ page: 0, pageCount: 1, start: 0, end: 0 });
  });

  it('preserves the search value and exposes the complete premium filter controls', () => {
    const html = renderToStaticMarkup(
      <PremiumHistorySearch
        value="night Toronto"
        onChange={vi.fn()}
        sortOptions={[{ id: 'date_desc', label: 'Newest First' }]}
        quickFilters={[
          { id: 'all', label: 'All Trips' },
          { id: 'this_week', label: 'This Week' },
          { id: 'night', label: 'Night Drives' },
        ]}
        showFilters
        expandedFilters={<div>Saved filter controls</div>}
      />
    );

    expect(html).toContain('aria-label="Search trip history"');
    expect(html).toContain('type="search"');
    expect(html).toContain('value="night Toronto"');
    expect(html).toContain('Search place, month, date, distance, score');
    expect(html).toContain('data-visual="bmw-mountain-road"');
    expect(html).toContain('premium-history-search-bmw-v2.jpg');
    expect(html).toContain('data-control="date"');
    expect(html).toContain('data-control="trip-type"');
    expect(html).toContain('data-control="sort"');
    expect(html).toContain('data-control="tags"');
    expect(html).toContain('premium-history-date-v2.jpg');
    expect(html).toContain('premium-history-trip-type-v2.jpg');
    expect(html).toContain('premium-history-sort-v2.jpg');
    expect(html).toContain('premium-history-tags-v2.jpg');
    expect(html).toContain('aria-label="Filter trips by date"');
    expect(html).toContain('aria-label="Filter trips by type"');
    expect(html).toContain('aria-label="Sort trips"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Saved filter controls');
  });

  it('renders real summary labels and semantic metric cards', () => {
    const html = renderToStaticMarkup(
      <PremiumFilteredSnapshot
        summary={{
          count: 61,
          totalDistanceLabel: '504.0 km',
          totalDurationSeconds: 13 * 60 * 60 + 14 * 60,
          totalDurationLabel: '13h 14m',
          averageScore: 67,
          averageScoreLabel: '67',
          scoreTrend: [72, 68, 75, 67],
          favoriteCount: 3,
          nightCount: 8,
        }}
        filterLabel="This Month"
        tagLabel="Night"
      />
    );

    expect(html).toContain('61');
    expect(html).toContain('504.0 km');
    expect(html).toContain('13h 14m');
    expect(html).toContain('data-tone="score"');
    expect(html).toContain('data-score-band="steady"');
    expect(html).toContain('data-time-band="extended"');
    expect(html).toContain('Adaptive drive-time scale: 0h, 8h, 15h+');
    expect(html).toContain('data-direction="down"');
    expect(html).toContain('Average score trend from 72 to 67 across 4 scored trips');
    expect(html).toContain('premium-history-snapshot-hero-v3.webp');
    expect(html).toContain('premium-history-snapshot-trips-v3.webp');
    expect(html).toContain('premium-history-snapshot-distance-v3.webp');
    expect(html).toContain('premium-history-snapshot-time-v3.webp');
    expect(html).toContain('premium-history-snapshot-score-v3.webp');
    expect(html).toContain('Includes 3 favorites and 8 night drives');
  });

  it('scales long live values and builds score paths from the supplied data', () => {
    expect(getPremiumHistoryValueSize('123h 45m')).toBe('short');
    expect(getPremiumHistoryValueSize('1,234h 45m')).toBe('medium');
    expect(getPremiumHistoryValueSize('No score yet')).toBe('medium');
    expect(getPremiumHistoryValueSize('Distance unavailable')).toBe('long');

    const rising = buildPremiumHistorySparkline([42, 61, 55, 88]);
    expect(rising.direction).toBe('up');
    expect(rising.start).toBe(42);
    expect(rising.end).toBe(88);
    expect(rising.points).toHaveLength(4);
    expect(rising.path).toContain('M ');
    expect(rising.path).toContain('C ');

    expect(buildPremiumHistorySparkline([91, 78]).direction).toBe('down');
    expect(buildPremiumHistorySparkline([72, 72.4]).direction).toBe('flat');
    expect(buildPremiumHistorySparkline([])).toMatchObject({
      direction: 'flat',
      end: null,
      path: '',
      points: [],
      start: null,
    });
  });

  it('adapts the live elapsed-time scale without speed labels or capped durations', () => {
    expect(getPremiumHistoryTimePresentation(45 * 60)).toMatchObject({
      band: 'minutes',
      label: 'Adaptive drive-time scale',
      markers: ['0m', '30m', '1h+'],
      progressPercent: 75,
    });
    expect(getPremiumHistoryTimePresentation(3 * 60 * 60)).toMatchObject({
      band: 'hours',
      label: 'Adaptive drive-time scale',
      markers: ['0h', '2h', '4h+'],
      progressPercent: 75,
    });
    expect(getPremiumHistoryTimePresentation(18 * 60 * 60)).toMatchObject({
      band: 'extended',
      label: 'Adaptive drive-time scale',
      markers: ['0h', '10h', '20h+'],
      progressPercent: 90,
    });
    expect(getPremiumHistoryTimePresentation(72 * 60 * 60)).toMatchObject({
      band: 'multi-day',
      label: 'Adaptive drive-time scale',
      markers: ['0h', '40h', '80h+'],
      progressPercent: 90,
    });
    expect(getPremiumHistoryTimePresentation(123 * 60 * 60)).toMatchObject({
      band: 'high-volume',
      label: 'Adaptive drive-time scale',
      markers: ['0h', '75h', '150h+'],
      progressPercent: 82,
    });
  });

  it('keeps result navigation labeled and disables unavailable directions', () => {
    const firstPage = renderToStaticMarkup(
      <PremiumHistoryResultsPager
        start={1}
        end={30}
        total={61}
        page={0}
        pageCount={3}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
      />
    );

    expect(firstPage).toContain('Showing <strong>1–30</strong> of <strong>61</strong> matching trips');
    expect(firstPage).toContain('disabled="" aria-label="Show previous matching trips"');
    expect(firstPage).toContain('aria-label="Show next matching trips"');
    expect(firstPage).toContain('aria-label="Page 1 of 3"');
  });
});
