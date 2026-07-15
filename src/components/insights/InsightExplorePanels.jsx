import { useMemo } from 'react';
import { ArrowRight, MapPinned, Navigation } from 'lucide-react';
import { formatDistance } from '@/lib/tripEngine';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import { Notice, PanelHeader } from '@/components/insights/InsightPrimitives';

const hotspotColors = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#d97706',
  low: '#2563eb',
};
const contextOptions = [
  { value: 'time', label: 'Time' },
  { value: 'day', label: 'Day' },
  { value: 'road', label: 'Road type' },
  { value: 'route', label: 'Route' },
  { value: 'vehicle', label: 'Vehicle' },
];

export function RiskMapPanel({ hotspots, selected, onSelect, onOpenMap }) {
  const bounds = useMemo(() => {
    if (!hotspots.length) return null;
    const lats = hotspots.map((zone) => zone.lat);
    const lngs = hotspots.map((zone) => zone.lng);
    return {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLng: Math.min(...lngs),
      maxLng: Math.max(...lngs),
    };
  }, [hotspots]);
  const position = (zone) => {
    if (!bounds) return { x: 50, y: 50 };
    const lngSpan = Math.max(0.00001, bounds.maxLng - bounds.minLng);
    const latSpan = Math.max(0.00001, bounds.maxLat - bounds.minLat);
    return {
      x: 8 + ((zone.lng - bounds.minLng) / lngSpan) * 84,
      y: 92 - ((zone.lat - bounds.minLat) / latSpan) * 84,
    };
  };
  return (
    <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
      <PanelHeader
        eyebrow="Where"
        title="Repeated risk locations"
        description="Only clusters with repeated scored events appear. Precise addresses are not inferred here."
        icon={MapPinned}
        action={(
          <button type="button" onClick={onOpenMap} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold hover:bg-secondary">
            Full map <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      />
      {hotspots.length === 0 ? (
        <div className="mt-5 grid min-h-64 place-items-center rounded-2xl border border-dashed border-border bg-secondary/25 p-6 text-center">
          <div>
            <MapPinned className="mx-auto h-8 w-8 text-muted-foreground" />
            <div className="mt-3 text-sm font-semibold">No repeated coordinate cluster in this period</div>
            <div className="mt-1 max-w-md text-xs text-muted-foreground">
              The pattern may be dispersed, route detail may have expired, or fewer than two scored events occurred near one another.
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="relative mt-5 aspect-[16/8] min-h-64 overflow-hidden rounded-2xl border border-border bg-[radial-gradient(circle_at_center,hsl(var(--secondary))_1px,transparent_1px)] [background-size:24px_24px]">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-orange-500/10" />
            {hotspots.map((zone) => {
              const point = position(zone);
              const active = selected?.id === zone.id;
              return (
                <button
                  key={zone.id}
                  type="button"
                  aria-label={`${zone.eventCount} events, ${zone.riskLevel} risk`}
                  onClick={() => onSelect(zone.id)}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-lg transition hover:scale-110 focus:outline-none focus:ring-2 focus:ring-primary ${active ? 'scale-110 ring-4 ring-primary/20' : ''}`}
                  style={{
                    left: `${point.x}%`,
                    top: `${point.y}%`,
                    width: `${Math.min(44, 22 + zone.eventCount * 3)}px`,
                    height: `${Math.min(44, 22 + zone.eventCount * 3)}px`,
                    backgroundColor: hotspotColors[zone.riskLevel] || hotspotColors.low,
                  }}
                >
                  <span className="text-[10px] font-bold text-white">{zone.eventCount}</span>
                </button>
              );
            })}
          </div>
          {selected && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-secondary/40 p-4">
              <div>
                <div className="text-sm font-semibold capitalize">{String(selected.dominantType || 'risk event').replace(/_/g, ' ')}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {selected.eventCount} events / {selected.riskLevel} risk / last seen {selected.lastSeen ? new Date(selected.lastSeen).toLocaleDateString() : 'unknown'}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(selected.typeBreakdown || {}).map(([type, count]) => (
                  <span key={type} className="rounded-full bg-background px-2.5 py-1 text-[10px] font-semibold capitalize">
                    {type.replace(/_/g, ' ')} {count}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function ContextExplorer({ analysis, type, onTypeChange, units, onOpenTrip }) {
  const availableOptions = analysis.privacySafeSnapshot
    ? contextOptions.filter((option) => ['road', 'vehicle'].includes(option.value))
    : contextOptions;
  const rows = useMemo(() => {
    if (type === 'route') return analysis.routes.map((route) => ({
      id: route.route_key,
      label: route.label,
      tripCount: route.trip_count,
      distanceKm: route.avg_distance_km * route.trip_count,
      score: route.avg_score,
      eventRate: null,
      latestTripId: route.last_trip_id,
      detail: `${route.trend} / strongest near ${route.safest_time}`,
    }));
    return analysis.contexts.filter((row) => row.type === type).map((row) => ({
      ...row,
      detail: `${row.eventCount} events / ${formatDistance(row.distanceKm, units)}`,
    }));
  }, [analysis.contexts, analysis.routes, type, units]);
  const sorted = [...rows].sort((a, b) => (
    Number(b.tripCount >= 2) - Number(a.tripCount >= 2) || (b.score || 0) - (a.score || 0)
  ));
  const bestScore = Math.max(1, ...sorted.map((row) => row.score || 0));
  return (
    <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
      <PanelHeader
        eyebrow={analysis.privacySafeSnapshot ? 'Stored trip conditions' : 'When and under what conditions'}
        title="Personal context explorer"
        description={analysis.privacySafeSnapshot
          ? 'Road and vehicle context can use stored summaries. Protected time, day, and repeated-route trends stay hidden.'
          : 'Compare only your own recorded driving. Small samples stay visible but are marked as developing.'}
        icon={Navigation}
      />
      <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
        {availableOptions.map((option) => {
          const available = option.value === 'route'
            ? analysis.routes.length > 0
            : analysis.contexts.some((row) => row.type === option.value);
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onTypeChange(option.value)}
              disabled={!available}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
                type === option.value
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border hover:bg-secondary disabled:opacity-40'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {sorted.length === 0 ? (
        <Notice text={`No ${type} evidence is available in the loaded trips.`} />
      ) : (
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((row) => (
            <button
              key={row.id}
              type="button"
              disabled={!row.latestTripId}
              onClick={() => row.latestTripId && onOpenTrip(row.latestTripId)}
              className="rounded-2xl border border-border p-4 text-left transition hover:border-primary/40 disabled:cursor-default"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">{row.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {row.tripCount} trip{row.tripCount === 1 ? '' : 's'} / {row.tripCount < 2 ? 'developing' : 'comparable'}
                  </div>
                </div>
                <div className="font-grotesk text-2xl font-bold">{formatEstimatedScore(row.score)}</div>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.max(2, (row.score || 0) / bestScore * 100)}%` }}
                />
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                {row.detail}{row.eventRate != null ? ` / ${row.eventRate}/100 km` : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
