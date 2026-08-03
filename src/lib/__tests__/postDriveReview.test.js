import { describe, expect, it } from 'vitest';
import {
  buildPendingPostDriveReview,
  shouldReplacePendingPostDriveReview,
} from '@/lib/postDriveReview';

describe('pending post-drive review', () => {
  it('stores only the durable handoff metadata, not the route payload', () => {
    const entry = buildPendingPostDriveReview({
      id: 'trip-42',
      end_time: '2026-07-29T14:30:00.000Z',
      route_points: [{ lat: 43.1, lng: -79.2 }],
      driving_events: [{ type: 'harsh_brake' }],
    }, 'native_background_import');

    expect(entry).toMatchObject({
      tripId: 'trip-42',
      completedAt: '2026-07-29T14:30:00.000Z',
      source: 'native_background_import',
    });
    expect(entry).not.toHaveProperty('route_points');
    expect(entry).not.toHaveProperty('driving_events');
  });

  it('ignores records that do not have a stable trip id', () => {
    expect(buildPendingPostDriveReview({ status: 'completed' })).toBeNull();
  });

  it('replaces an undismissed review when a newer trip completes', () => {
    expect(shouldReplacePendingPostDriveReview(
      { tripId: 'older', completedAt: '2026-07-29T14:30:00.000Z' },
      { tripId: 'newer', completedAt: '2026-07-29T15:30:00.000Z' }
    )).toBe(true);
  });

  it('does not let a delayed older import replace the newest review', () => {
    expect(shouldReplacePendingPostDriveReview(
      { tripId: 'newer', completedAt: '2026-07-29T15:30:00.000Z' },
      { tripId: 'older', completedAt: '2026-07-29T14:30:00.000Z' }
    )).toBe(false);
  });

  it('allows the same trip review to refresh when its saved summary is updated', () => {
    expect(shouldReplacePendingPostDriveReview(
      { tripId: 'same', completedAt: '2026-07-29T15:30:00.000Z' },
      { tripId: 'same', completedAt: '2026-07-29T15:30:00.000Z' }
    )).toBe(true);
  });
});
