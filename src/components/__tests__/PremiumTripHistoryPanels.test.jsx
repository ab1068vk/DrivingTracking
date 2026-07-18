import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  PREMIUM_HISTORY_PAGE_SIZE,
  PremiumFilteredSnapshot,
  PremiumHistoryResultsPager,
  PremiumHistorySearch,
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
    expect(html).toContain('value="night Toronto"');
    expect(html).toContain('Search place, month, date, distance, score');
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
          totalDurationLabel: '13h 14m',
          averageScore: 67,
          averageScoreLabel: '67',
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
    expect(html).toContain('Includes 3 favorites and 8 night drives');
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
