import { useCallback, useEffect, useMemo, useState } from 'react';
import { tripService } from '@/api/trips';
import {
  clearPendingPostDriveReview,
  loadPendingPostDriveReview,
  markTripForPostDriveReview,
  POST_DRIVE_REVIEW_CHANGED_EVENT,
} from '@/lib/postDriveReview';
import { logError } from '@/lib/errorReporting';

const sameTrip = (trip, tripId) => (
  trip?.id != null && tripId != null && String(trip.id) === String(tripId)
);

export default function usePendingPostDriveReview(trips = []) {
  const [entry, setEntry] = useState(null);
  const [tripSnapshot, setTripSnapshot] = useState(null);

  useEffect(() => {
    let active = true;
    loadPendingPostDriveReview()
      .then((stored) => {
        if (active) setEntry(stored);
      })
      .catch((error) => logError('post_drive_review_load', error));

    const onChange = (event) => {
      setEntry(event?.detail?.entry || null);
      setTripSnapshot(event?.detail?.trip || null);
    };
    window.addEventListener(POST_DRIVE_REVIEW_CHANGED_EVENT, onChange);
    return () => {
      active = false;
      window.removeEventListener(POST_DRIVE_REVIEW_CHANGED_EVENT, onChange);
    };
  }, []);

  useEffect(() => {
    if (!entry?.tripId || sameTrip(tripSnapshot, entry.tripId)) return undefined;
    let active = true;
    tripService.getById(entry.tripId)
      .then((savedTrip) => {
        if (active && sameTrip(savedTrip, entry.tripId)) setTripSnapshot(savedTrip);
      })
      .catch((error) => {
        logError('post_drive_review_trip_hydrate', error, { tripId: entry.tripId });
      });
    return () => {
      active = false;
    };
  }, [entry?.tripId, tripSnapshot]);

  const trip = useMemo(() => {
    if (!entry?.tripId) return null;
    if (sameTrip(tripSnapshot, entry.tripId)) return tripSnapshot;
    return (Array.isArray(trips) ? trips : []).find((item) => sameTrip(item, entry.tripId)) || null;
  }, [entry?.tripId, tripSnapshot, trips]);

  const showTrip = useCallback(async (nextTrip, source = 'trip_completed') => {
    if (!nextTrip?.id) return null;
    setTripSnapshot(nextTrip);
    try {
      const nextEntry = await markTripForPostDriveReview(nextTrip, source);
      setEntry(nextEntry);
      return nextEntry;
    } catch (error) {
      logError('post_drive_review_save', error, { tripId: nextTrip.id, source });
      return null;
    }
  }, []);

  const dismiss = useCallback(async () => {
    const expectedTripId = entry?.tripId || null;
    setEntry(null);
    setTripSnapshot(null);
    try {
      await clearPendingPostDriveReview(expectedTripId);
    } catch (error) {
      logError('post_drive_review_clear', error, { tripId: expectedTripId });
    }
  }, [entry?.tripId]);

  return {
    dismiss,
    entry,
    showTrip,
    trip,
  };
}
