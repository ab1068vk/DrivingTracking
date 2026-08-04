import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readDashboardSource } from '@/lib/__tests__/helpers/pageSourceBundle';

describe('post-drive review lifecycle wiring', () => {
  it('reserves dismissal for the explicit X action', () => {
    const dashboard = readDashboardSource();
    const trackingOverview = readFileSync(new URL('../../pages/TrackingOverview.jsx', import.meta.url), 'utf8');

    expect(dashboard).toContain('onDismiss={dismissPostDriveReview}');
    expect(dashboard).toContain('onOpenTrip={() => navigate(');
    expect(dashboard).not.toContain('await dismissPostDriveReview();');
    expect(trackingOverview).toContain('onDismiss={dismissPostDriveReview}');
    expect(trackingOverview).toContain('onOpenTrip={() => navigate(');
    expect(trackingOverview).not.toContain('await dismissPostDriveReview();');
  });

  it('does not dismiss the pending review merely because Trip Detail was opened', () => {
    const tripDetail = readFileSync(new URL('../../pages/TripDetail.jsx', import.meta.url), 'utf8');
    const trackingTripDetail = readFileSync(new URL('../../pages/TrackingTripDetail.jsx', import.meta.url), 'utf8');

    expect(tripDetail).not.toContain('clearPendingPostDriveReview');
    expect(trackingTripDetail).not.toContain('clearPendingPostDriveReview');
  });

  it('hydrates the full saved trip after restart so advanced evidence is not limited to summaries', () => {
    const hook = readFileSync(new URL('../../hooks/usePendingPostDriveReview.js', import.meta.url), 'utf8');

    expect(hook).toContain('tripService.getById(entry.tripId)');
    expect(hook).toContain('setTripSnapshot(savedTrip)');
    expect(hook).toContain("'post_drive_review_trip_hydrate'");
  });
});
