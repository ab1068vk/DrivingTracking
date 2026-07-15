import { lazy, Suspense, useDeferredValue, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Box,
  GitCompare,
  Layers,
  Map,
} from 'lucide-react';
import { tripService } from '@/api/trips';
import TripPlayback from '@/components/TripPlayback';
import useLocalSettings from '@/hooks/useLocalSettings';
import {
  buildCompareReplayData,
  buildReplayTripOptions,
} from '@/lib/trackingReplayPro';

const TripDrive3D = lazy(() => import('@/components/TripDrive3D'));

const PLAYBACK_MODES = [
  { id: 'real_time', label: 'Real-time' },
  { id: 'normalized', label: 'Normalized' },
  { id: 'event_to_event', label: 'Event-to-event' },
];

const formatDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
    : 'source unavailable';
};

const formatDistance = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)} km` : 'source unavailable';
};

export default function TrackingReplayPro() {
  const settings = useLocalSettings();
  const [primaryTripId, setPrimaryTripId] = useState('');
  const [secondaryTripId, setSecondaryTripId] = useState('');
  const [playbackMode, setPlaybackMode] = useState('real_time');
  const [surface, setSurface] = useState('map');

  const { data: trips = [], isLoading } = useQuery({
    queryKey: ['tracking-replay-pro-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 120 }),
    staleTime: 2 * 60 * 1000,
  });

  const options = useMemo(() => buildReplayTripOptions(trips), [trips]);
  const availableOptions = options.filter((option) => option.available);
  const effectivePrimaryId = primaryTripId || availableOptions[0]?.id || '';
  const effectiveSecondaryId = secondaryTripId ||
    availableOptions.find((option) => option.id !== effectivePrimaryId)?.id ||
    '';
  const deferredPrimaryId = useDeferredValue(effectivePrimaryId);
  const deferredSecondaryId = useDeferredValue(effectiveSecondaryId);
  const deferredPlaybackMode = useDeferredValue(playbackMode);
  const deferredSurface = useDeferredValue(surface);
  const replayPending = deferredPrimaryId !== effectivePrimaryId ||
    deferredSecondaryId !== effectiveSecondaryId ||
    deferredPlaybackMode !== playbackMode ||
    deferredSurface !== surface;
  const primaryTrip = trips.find((trip) => String(trip.id) === String(deferredPrimaryId)) || null;
  const secondaryTrip = trips.find((trip) => String(trip.id) === String(deferredSecondaryId)) || null;
  const compareData = useMemo(
    () => buildCompareReplayData({
      primaryTrip,
      secondaryTrip,
      settings,
      playbackMode: deferredPlaybackMode,
    }),
    [deferredPlaybackMode, primaryTrip, secondaryTrip, settings]
  );

  const canShowPlayback = compareData.primaryAvailable && compareData.secondaryAvailable;
  const canShow3D = compareData.primaryAvailable && deferredSurface === '3d';

  return (
    <div className="flex min-h-[calc(100dvh-8.5rem)] min-w-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-background/80 px-3 py-2">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] font-bold text-muted-foreground">Advanced trip tracking</div>
            <h1 className="font-grotesk text-xl font-bold tracking-normal">Compare Drive Replays</h1>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Compare retained routes with playback overlays, route gaps, speed-source changes, privacy indicators, and 3D replay chapters.
            </p>
          </div>

          <div className="grid gap-2 text-xs sm:grid-cols-2 xl:w-[44rem]">
            <TripSelect
              label="Primary trip"
              value={effectivePrimaryId}
              options={options}
              onChange={(value) => {
                setPrimaryTripId(value);
                if (value === effectiveSecondaryId) setSecondaryTripId('');
              }}
            />
            <TripSelect
              label="Comparison trip"
              value={effectiveSecondaryId}
              options={options.filter((option) => option.id !== effectivePrimaryId)}
              onChange={setSecondaryTripId}
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-border bg-card p-1 text-xs font-semibold">
            {PLAYBACK_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                onClick={() => setPlaybackMode(mode.id)}
                className={`rounded-sm px-3 py-1.5 ${playbackMode === mode.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <IconToggle active={surface === 'map'} onClick={() => setSurface('map')} icon={Map} label="Map playback" />
          <IconToggle active={surface === '3d'} onClick={() => setSurface('3d')} icon={Box} label="3D replay" />
          {replayPending && <StatusChip label="State" value="Applying selection" />}
          <StatusChip label="Similarity" value={compareData.routeSimilarity.label} />
          <StatusChip label="Route gaps" value={compareData.routeGapRows.length} />
          <StatusChip label="Privacy gaps" value={compareData.privacyGapRows.length} />
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[18rem_minmax(0,1fr)_22rem]">
        <aside className="min-h-0 border-b border-border bg-card/70 xl:border-b-0 xl:border-r">
          <PaneHeader icon={GitCompare} title="Drives being compared" detail={`${availableOptions.length} replayable trips`} />
          <div className="space-y-3 overflow-y-auto p-3 text-sm">
            <TripSummary title="Primary" trip={primaryTrip} available={compareData.primaryAvailable} reason={compareData.primaryUnavailableReason} />
            <TripSummary title="Comparison" trip={secondaryTrip} available={compareData.secondaryAvailable} reason={compareData.secondaryUnavailableReason} />
            <div className="rounded-md border border-border bg-background/70 p-3 text-xs">
              <div className="font-semibold">Similarity</div>
              <div className="mt-2 grid gap-1 text-muted-foreground">
                <div>Start delta: {compareData.routeSimilarity.startDeltaM ?? 'unavailable'} m</div>
                <div>End delta: {compareData.routeSimilarity.endDeltaM ?? 'unavailable'} m</div>
                <div>Distance delta: {compareData.routeSimilarity.distanceDeltaPct ?? 'unavailable'}%</div>
              </div>
            </div>
            {isLoading && <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">Reading local trips.</div>}
            {!isLoading && !availableOptions.length && (
              <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
                No replayable trips found. Summary-only private trips and expired route data remain blocked.
              </div>
            )}
          </div>
        </aside>

        <section className="min-h-[34rem] min-w-0 bg-secondary/30 p-2">
          {canShowPlayback && deferredSurface === 'map' ? (
            <TripPlayback
              trip={primaryTrip}
              secondaryTrip={secondaryTrip}
              height="calc(100dvh - 18rem)"
              colorMode="speedLimit"
            />
          ) : canShow3D ? (
            <Suspense fallback={<WorkspaceEmpty title="Loading 3D replay" detail="Preparing retained route geometry." />}>
              <TripDrive3D
                trip={primaryTrip}
                events={primaryTrip?.driving_events || []}
                height="calc(100dvh - 18rem)"
                colorMode="speedLimit"
              />
            </Suspense>
          ) : (
            <WorkspaceEmpty
              title={deferredSurface === '3d' ? '3D replay blocked' : 'Compare playback blocked'}
              detail={compareData.primaryUnavailableReason || compareData.secondaryUnavailableReason || 'Select two replayable trips with retained route data.'}
            />
          )}
        </section>

        <aside className="min-h-0 border-t border-border bg-card/80 xl:border-l xl:border-t-0">
          <PaneHeader icon={Layers} title="Replay details" detail="Overlay, chapters, and route comparison" />
          <div className="space-y-3 overflow-y-auto p-3">
            <Panel title="Route Comparison" detail={`${compareData.routeComparison.rows.length} metrics`}>
              <div className="grid gap-1 text-xs">
                {compareData.routeComparison.rows.map((row) => (
                  <div key={row.label} className="grid grid-cols-3 gap-2 rounded-md bg-background/70 px-2 py-1.5">
                    <span className="font-semibold">{row.label}</span>
                    <span>{String(row.current)}</span>
                    <span>{String(row.other)}</span>
                  </div>
                ))}
                {!compareData.routeComparison.rows.length && <EmptyText text="Select two replayable trips." />}
              </div>
            </Panel>

            <Panel title="3D Replay Event Chapters" detail={`${compareData.chapterRows.length} chapters`}>
              <div className="grid gap-1 text-xs">
                {compareData.chapterRows.map((chapter) => (
                  <button
                    key={chapter.id}
                    type="button"
                    onClick={() => setSurface('3d')}
                    className="rounded-md border border-border bg-background/70 px-2 py-1.5 text-left hover:bg-secondary"
                  >
                    <div className="font-semibold">{chapter.label}</div>
                    <div className="text-muted-foreground">{chapter.detail} / {Math.round(chapter.offsetSeconds)}s</div>
                  </button>
                ))}
                {!compareData.chapterRows.length && <EmptyText text="No event chapters available." />}
              </div>
            </Panel>

            <Panel title="Speed-Limit Source Changes" detail={`${compareData.speedLimitSourceRows.length} rows`}>
              <div className="grid gap-1 text-xs">
                {compareData.speedLimitSourceRows.slice(0, 8).map((row) => (
                  <div key={row.id} className="rounded-md bg-background/70 px-2 py-1.5">
                    <div className="font-semibold">{row.source}</div>
                    <div className="text-muted-foreground">{row.limitKmh == null ? 'limit unavailable' : `${Math.round(row.limitKmh)} km/h`} at {Math.round(row.offsetSeconds)}s</div>
                  </div>
                ))}
                {!compareData.speedLimitSourceRows.length && <EmptyText text="No speed-source changes recorded." />}
              </div>
            </Panel>
          </div>
        </aside>
      </main>

      <TimelineTracks data={compareData} playbackMode={playbackMode} />
    </div>
  );
}

function TripSelect({ label, value, options, onChange }) {
  return (
    <label className="grid min-w-0 gap-1 font-semibold text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-border bg-card px-2 text-sm text-foreground"
      >
        {!options.length && <option value="">No replayable trip</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id} disabled={!option.available}>
            {formatDate(option.startTime)} / {formatDistance(option.distanceKm)}{option.available ? '' : ' / blocked'}
          </option>
        ))}
      </select>
    </label>
  );
}

function TripSummary({ title, trip, available, reason }) {
  return (
    <div className="rounded-md border border-border bg-background/70 p-3 text-xs">
      <div className="font-semibold">{title}</div>
      <div className="mt-2 grid gap-1 text-muted-foreground">
        <div>{trip?.nickname || trip?.tag || trip?.id || 'No trip selected'}</div>
        <div>{formatDate(trip?.start_time)}</div>
        <div>{formatDistance(trip?.distance_km)}</div>
        <div>{available ? 'replay available' : reason}</div>
      </div>
    </div>
  );
}

function TimelineTracks({ data, playbackMode }) {
  const tracks = [
    { id: 'speed', label: 'Speed timeline overlay', rows: data.speedOverlayRows, color: 'bg-blue-500' },
    { id: 'events', label: 'Event timeline overlay', rows: data.eventOverlayRows, color: 'bg-amber-500' },
    { id: 'gaps', label: 'Route gap comparison', rows: data.routeGapRows, color: 'bg-red-500' },
    { id: 'privacy', label: 'Privacy gap indicators', rows: data.privacyGapRows, color: 'bg-slate-500' },
  ];
  return (
    <footer className="shrink-0 border-t border-border bg-background px-3 py-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="font-semibold">Timeline Tracks</div>
        <div className="text-muted-foreground">Playback mode: {PLAYBACK_MODES.find((mode) => mode.id === playbackMode)?.label}</div>
      </div>
      <div className="grid gap-2 lg:grid-cols-4">
        {tracks.map((track) => (
          <div key={track.id} className="min-w-0 rounded-md border border-border bg-card p-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold">{track.label}</span>
              <span className="text-muted-foreground">{track.rows.length}</span>
            </div>
            <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-secondary">
              <div className={`${track.color} h-full`} style={{ width: `${Math.min(100, Math.max(8, track.rows.length * 10))}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2 overflow-x-auto text-[11px] text-muted-foreground thin-scrollbar">
        {data.playbackRows.slice(0, 14).map((row) => (
          <span key={row.id} className="shrink-0 rounded-md border border-border bg-card px-2 py-1">
            {row.label}: {row.start} / {row.end}
          </span>
        ))}
      </div>
    </footer>
  );
}

function IconToggle({ active, onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground hover:bg-secondary'}`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function StatusChip({ label, value }) {
  return (
    <div className="inline-flex min-h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs">
      <span className="font-semibold text-muted-foreground">{label}</span>
      <span className="font-bold">{value}</span>
    </div>
  );
}

function PaneHeader({ icon: Icon, title, detail }) {
  return (
    <div className="border-b border-border px-3 py-2">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </div>
      <div className="text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function Panel({ title, detail, children }) {
  return (
    <section className="rounded-md border border-border bg-secondary/30">
      <div className="border-b border-border px-3 py-2">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function EmptyText({ text }) {
  return <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">{text}</div>;
}

function WorkspaceEmpty({ title, detail }) {
  return (
    <div className="flex h-full min-h-[30rem] items-center justify-center rounded-md border border-dashed border-border bg-card/70 p-6 text-center">
      <div>
        <div className="font-semibold">{title}</div>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
