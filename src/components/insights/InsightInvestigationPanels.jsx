import { lazy, Suspense, useMemo, useState } from 'react';
import {
  ArrowRight, Bot, Clock3, Crosshair, MapPinned, Search, ShieldCheck,
} from 'lucide-react';
import { answerDriveQuestion } from '@/lib/advancedInsightIntelligence';
import { Notice, PanelHeader } from '@/components/insights/InsightPrimitives';

const typeLabel = (value) => String(value || 'event').replace(/_/g, ' ');
const TripMap = lazy(() => import('@/components/TripMap'));
const routeColors = ['#2563eb', '#8b5cf6', '#0891b2', '#ea580c', '#16a34a', '#dc2626'];
const questions = [
  'Why did my score change?',
  'Am I improving?',
  'Which route is safest?',
  'How is my braking?',
  'What is my next-drive risk?',
  'Show phone-use evidence',
];

export function GeographicInvestigationWorkspace({
  intelligence, hotspots, trips = [], onOpenTrip, onOpenFullMap,
}) {
  const evidence = intelligence.eventEvidence;
  const eventTypes = [...new Set(evidence.map((row) => row.type))];
  const [type, setType] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedTripId, setSelectedTripId] = useState(null);
  const filtered = type === 'all' ? evidence : evidence.filter((row) => row.type === type);
  const selected = filtered.find((row) => row.id === selectedId) || filtered[0] || null;
  const detailedTrips = useMemo(() => {
    const seen = new Set();
    return [...trips, ...evidence.map((row) => row.trip)].filter((trip) => {
      if (!trip?.id || seen.has(String(trip.id))) return false;
      if (!Array.isArray(trip.route_points) || trip.route_points.length < 2) return false;
      seen.add(String(trip.id));
      return true;
    });
  }, [evidence, trips]);
  const selectedTrip = selected?.trip
    || detailedTrips.find((trip) => String(trip.id) === String(selectedTripId))
    || detailedTrips[0]
    || null;
  const routes = detailedTrips.slice(0, 8).map((trip, index) => ({
    id: trip.id,
    label: new Date(trip.start_time).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    }),
    route_points: trip.route_points,
    color: routeColors[index % routeColors.length],
    selected: String(selectedTrip?.id) === String(trip.id),
    opacity: String(selectedTrip?.id) === String(trip.id) ? 1 : 0.38,
  }));
  const allEvents = evidence.map((row) => row.event);
  const chooseEvent = (row) => {
    setSelectedId(row.id);
    setSelectedTripId(row.tripId);
  };
  const selectMapEvent = (event) => {
    const match = evidence.find((row) => (
      row.event === event || (
        row.timestamp === (event.timestamp || event.startTime)
        && row.type === event.type
      )
    ));
    if (match) {
      setType(match.type);
      chooseEvent(match);
    }
  };
  const hasMapEvidence = routes.length > 0;

  return (
    <section id="event-investigation" className="scroll-mt-24 rounded-3xl border border-border bg-card p-5 shadow-sm">
      <PanelHeader
        eyebrow="Mapped trip evidence"
        title="Trip map and event investigation"
        description="Stored privacy-masked routes render directly here. Select a route or recorded event to inspect it without leaving Insights."
        icon={Crosshair}
        action={(
          <button type="button" onClick={onOpenFullMap} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold hover:bg-secondary">
            Open map page <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      />

      {eventTypes.length > 0 && (
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => {
              setType('all');
              setSelectedId(null);
            }}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${type === 'all' ? 'bg-primary text-primary-foreground' : 'border border-border'}`}
          >
            All events
          </button>
          {eventTypes.map((eventType) => (
            <button
              key={eventType}
              type="button"
              onClick={() => {
                setType(eventType);
                setSelectedId(null);
              }}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold capitalize ${type === eventType ? 'bg-primary text-primary-foreground' : 'border border-border'}`}
            >
              {typeLabel(eventType)}
            </button>
          ))}
        </div>
      )}

      {!hasMapEvidence && evidence.length === 0 ? (
        <Notice text="No stored route geometry or exact event coordinates are available in the loaded trips." />
      ) : (
        <div className="mt-5 grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
          <div className="overflow-hidden rounded-2xl border border-border bg-secondary/20">
            {hasMapEvidence ? (
              <Suspense fallback={<div className="grid min-h-[420px] place-items-center text-sm text-muted-foreground">Loading evidence map...</div>}>
                <TripMap
                  routes={routes}
                  routePoints={selectedTrip?.route_points || []}
                  events={allEvents}
                  dangerZones={hotspots}
                  showDangerZones={hotspots.length > 0}
                  focusPoint={selected?.event || null}
                  onEventSelect={selectMapEvent}
                  height="420px"
                  className="rounded-2xl"
                />
              </Suspense>
            ) : (
              <div className="grid min-h-[320px] place-items-center p-6">
                <Notice text="Exact events exist, but their parent routes do not contain replayable stored geometry." />
              </div>
            )}
          </div>

          <div>
            {selected ? (
              <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-bold uppercase tracking-wide text-primary">Selected event</div>
                    <div className="mt-1 text-lg font-bold capitalize">{typeLabel(selected.type)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {new Date(selected.timestamp).toLocaleString()} / {selected.severity} severity
                    </div>
                  </div>
                  <MapPinned className="h-5 w-5 text-primary" />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <EvidenceMetric label="Speed" value={selected.speedKmh == null ? 'Unavailable' : `${Math.round(selected.speedKmh)} km/h`} />
                  <EvidenceMetric label="Limit evidence" value={selected.speedLimitKmh == null ? 'Unavailable' : `${Math.round(selected.speedLimitKmh)} km/h`} />
                  <EvidenceMetric label="Trip score" value={selected.tripScore ?? 'Unavailable'} />
                  <EvidenceMetric label="Road" value={selected.roadName || selected.trip?.dominant_road_type || 'Unlabelled'} />
                </div>
                <button type="button" onClick={() => onOpenTrip(selected.tripId)} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
                  Open complete trip analysis <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            ) : selectedTrip ? (
              <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-bold uppercase tracking-wide text-primary">Selected stored route</div>
                    <div className="mt-1 text-lg font-bold">
                      {new Date(selectedTrip.start_time).toLocaleDateString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {Number(selectedTrip.distance_km || 0).toFixed(1)} km / score {selectedTrip.score_overall ?? 'unavailable'}
                    </div>
                  </div>
                  <MapPinned className="h-5 w-5 text-primary" />
                </div>
                <button type="button" onClick={() => onOpenTrip(selectedTrip.id)} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
                  Open complete trip analysis <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            ) : null}

            {evidence.length === 0 && (
              <div className="mt-3">
                <Notice text="These trips have replayable routes but no stored exact event records. The routes still remain available for inspection." />
              </div>
            )}

            <div className="mt-3 max-h-[330px] space-y-2 overflow-y-auto pr-1">
              {filtered.length > 0 ? filtered.slice(0, 30).map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => chooseEvent(row)}
                  className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left ${
                    selected?.id === row.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                  }`}
                >
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary">
                    <Clock3 className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold capitalize">{typeLabel(row.type)}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {new Date(row.timestamp).toLocaleDateString()} / {row.speedKmh == null ? 'speed unavailable' : `${Math.round(row.speedKmh)} km/h`}
                    </div>
                  </div>
                  <span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-bold capitalize">{row.severity}</span>
                </button>
              )) : detailedTrips.slice(0, 12).map((trip, index) => (
                <button
                  key={trip.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(null);
                    setSelectedTripId(trip.id);
                  }}
                  className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left ${
                    String(selectedTrip?.id) === String(trip.id)
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/40'
                  }`}
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-bold">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">
                      {new Date(trip.start_time).toLocaleDateString()}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {Number(trip.distance_km || 0).toFixed(1)} km / score {trip.score_overall ?? 'unavailable'}
                    </div>
                  </div>
                  <MapPinned className="h-4 w-4 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
function EvidenceMetric({ label, value }) {
  return (
    <div className="rounded-xl bg-background/80 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-bold capitalize">{value}</div>
    </div>
  );
}

export function AskYourDrivesPanel({ analysis, intelligence, onOpenTrip }) {
  const [query, setQuery] = useState('Why did my score change?');
  const [submittedQuery, setSubmittedQuery] = useState('Why did my score change?');
  const result = useMemo(
    () => answerDriveQuestion(submittedQuery, analysis, intelligence),
    [submittedQuery, analysis, intelligence]
  );
  const ask = (question = query) => {
    const clean = String(question || '').trim();
    if (!clean) return;
    setQuery(clean);
    setSubmittedQuery(clean);
  };
  return (
    <section className="rounded-3xl border border-primary/20 bg-card p-5 shadow-sm">
      <PanelHeader
        eyebrow="Ask your drives"
        title="Cited local answers"
        description="Choose a supported prompt or ask about score changes, improvement, routes, braking, phone use, or next-drive risk. Unsupported questions are identified clearly."
        icon={Bot}
        action={(
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <ShieldCheck className="h-3.5 w-3.5" /> Local only
          </span>
        )}
      />
      <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
        {questions.map((question) => (
          <button key={question} type="button" onClick={() => ask(question)} aria-pressed={submittedQuery === question} className="shrink-0 rounded-full border border-border px-3 py-1.5 text-xs font-semibold hover:bg-secondary aria-pressed:border-primary aria-pressed:bg-primary/5">
            {question}
          </button>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && ask()}
          aria-label="Ask a question about your drives"
          className="min-w-0 flex-1 rounded-full border border-input bg-background px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
          placeholder="Why was this month worse?"
        />
        <button type="button" onClick={() => ask()} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground" aria-label="Analyze question">
          <Search className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-5 rounded-2xl bg-secondary/30 p-5">
        <div className="text-xs font-bold uppercase tracking-wide text-primary">{result.title}</div>
        <div className="mt-2 text-sm leading-6">{result.answer}</div>
        <div className="mt-4 border-t border-border pt-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Supporting trips</div>
          {result.citations.length === 0 ? (
            <div className="mt-2 text-xs text-muted-foreground">Aggregate personal-history signals; no single trip is presented as proof.</div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {result.citations.map((citation, index) => (
                <button
                  key={`${citation.tripId}-${citation.eventId || index}`}
                  type="button"
                  onClick={() => onOpenTrip(citation.tripId)}
                  className="rounded-full border border-border bg-background px-3 py-1 text-xs font-semibold hover:border-primary"
                >
                  Trip {index + 1} / {citation.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
