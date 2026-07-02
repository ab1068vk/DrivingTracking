// @ts-check
import { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { CalendarDays, Car, Clock, Gauge, Route, Search } from 'lucide-react';
import { limitedTripSummaryQueryOptions, tripDetailQueryOptions } from '@/api/trips';
import TripDrive3DPage from '@/pages/TripDrive3DPage';
import { formatDate, formatDistance, formatDuration, formatSpeed } from '@/lib/tripEngine';
import { getTripDisplayName } from '@/lib/tripMetadata';
import useLocalSettings from '@/hooks/useLocalSettings';
import { recordSystemEvent } from '@/lib/systemLog';

const PICKER_LIMIT = 80;

const replayableSummary = (trip = {}) => (
  trip.route_replay_available === true &&
  trip.privacy_mode !== 'summary_only' &&
  !trip.route_data_expired_at
);

export default function Trip3DReplay() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('tripId') || '';
  const settings = useLocalSettings();
  const units = settings.units || 'metric';
  const { data: summaries = [], isLoading: summariesLoading } = useQuery(limitedTripSummaryQueryOptions(PICKER_LIMIT));
  const { data: selectedTrip, isLoading: selectedLoading } = useQuery({
    ...tripDetailQueryOptions(selectedId),
    enabled: Boolean(selectedId),
  });

  const replayableTrips = useMemo(
    () => summaries.filter(replayableSummary),
    [summaries]
  );

  useEffect(() => {
    recordSystemEvent('trip_3d_replay_page_opened', {
      selected_trip_id: selectedId || null,
      summary_limit: PICKER_LIMIT,
      summary_count: summaries.length,
    }, {
      category: 'navigation',
      title: '3D replay opened',
    });
  }, [selectedId, summaries.length]);

  const selectTrip = (tripId) => {
    setParams(tripId ? { tripId: String(tripId) } : {});
    recordSystemEvent('trip_3d_replay_trip_selected', {
      trip_id: tripId || null,
    }, {
      category: 'user_action',
      title: '3D replay trip selected',
    });
  };

  if (selectedId) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => selectTrip('')}
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-secondary"
        >
          <Search className="h-4 w-4" />
          Choose another trip
        </button>
        <TripDrive3DPage embeddedTrip={selectedTrip} embeddedLoading={selectedLoading} />
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-grotesk text-2xl font-bold">3D Replay</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Pick one trip to load its full 3D route. This page only loads lightweight trip summaries until you choose a trip.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground">
          Showing latest {Math.min(PICKER_LIMIT, summaries.length)} summaries
        </div>
      </div>

      {summariesLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="h-32 animate-pulse rounded-2xl border border-border bg-secondary/50" />
          ))}
        </div>
      ) : replayableTrips.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {replayableTrips.map((trip, index) => (
            <motion.button
              key={trip.id}
              type="button"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(index * 0.015, 0.16) }}
              onClick={() => selectTrip(trip.id)}
              className="rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-secondary/30"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
                      <Car className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{getTripDisplayName(trip)}</div>
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <CalendarDays className="h-3.5 w-3.5" />
                        {formatDate(trip.start_time)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div className="rounded-xl bg-secondary/60 px-2 py-2">
                      <div className="flex items-center gap-1 text-muted-foreground"><Route className="h-3 w-3" /> Distance</div>
                      <div className="mt-1 font-semibold">{formatDistance(trip.distance_km || 0, units)}</div>
                    </div>
                    <div className="rounded-xl bg-secondary/60 px-2 py-2">
                      <div className="flex items-center gap-1 text-muted-foreground"><Clock className="h-3 w-3" /> Duration</div>
                      <div className="mt-1 font-semibold">{formatDuration(trip.duration_seconds || 0)}</div>
                    </div>
                    <div className="rounded-xl bg-secondary/60 px-2 py-2">
                      <div className="flex items-center gap-1 text-muted-foreground"><Gauge className="h-3 w-3" /> Avg</div>
                      <div className="mt-1 font-semibold">{formatSpeed(trip.avg_running_speed_kmh ?? trip.avg_speed_kmh ?? 0, units)}</div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.button>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border bg-secondary/30 p-8 text-center text-sm text-muted-foreground">
          No replayable trips found in the latest {PICKER_LIMIT} summaries.
          <div className="mt-3">
            <Link to="/trips" className="font-semibold text-primary">Open trip history</Link>
          </div>
        </div>
      )}
    </div>
  );
}
