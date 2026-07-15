import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Clock,
  Filter,
  Info,
  ListFilter,
  Search,
  Shield,
} from 'lucide-react';
import { limitedTripSummaryQueryOptions, tripDetailQueryOptions } from '@/api/trips';
import useLocalSettings from '@/hooks/useLocalSettings';
import {
  filterTrackingEventRows,
  formatTrackingEventTime,
  normalizeTrackingEventRows,
  trackingEventSourceOptions,
  trackingEventTypeOptions,
} from '@/lib/trackingEvents';

const SUMMARY_LIMIT = 50;

const formatTripLabel = (trip = {}) => {
  const date = trip.start_time ? new Date(trip.start_time) : null;
  const when = date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
    : 'Trip time unavailable';
  const distance = Number.isFinite(Number(trip.distance_km)) ? `${Number(trip.distance_km).toFixed(1)} km` : 'distance unavailable';
  return `${when} / ${distance}`;
};

const compactValue = (value) => (value == null || value === '' ? 'source unavailable' : String(value));

export default function TrackingEvents() {
  const settings = useLocalSettings();
  const [selectedTripId, setSelectedTripId] = useState('');
  const [selectedRowId, setSelectedRowId] = useState('');
  const [filters, setFilters] = useState({
    date: '',
    eventType: 'all',
    severity: 'all',
    source: 'all',
    privacy: 'all',
  });
  const deferredFilters = useDeferredValue(filters);
  const filtersPending = deferredFilters !== filters;

  const { data: summaries = [], isLoading: summariesLoading } = useQuery({
    ...limitedTripSummaryQueryOptions(SUMMARY_LIMIT),
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });

  const effectiveSelectedTripId = selectedTripId || (summaries[0]?.id ? String(summaries[0].id) : '');
  const { data: selectedTripRaw, isLoading: selectedTripLoading } = useQuery(tripDetailQueryOptions(effectiveSelectedTripId));
  const selectedTrip = selectedTripRaw || summaries.find((trip) => String(trip.id) === String(effectiveSelectedTripId)) || null;

  const rows = useMemo(
    () => selectedTrip ? normalizeTrackingEventRows(selectedTrip, { settings }) : [],
    [selectedTrip, settings]
  );
  const filteredRows = useMemo(
    () => filterTrackingEventRows(rows, deferredFilters),
    [deferredFilters, rows]
  );
  const eventTypeOptions = useMemo(() => trackingEventTypeOptions(rows), [rows]);
  const sourceOptions = useMemo(() => trackingEventSourceOptions(rows), [rows]);
  const selectedRow = filteredRows.find((row) => row.id === selectedRowId) || filteredRows[0] || null;

  useEffect(() => {
    if (!filteredRows.length) {
      setSelectedRowId('');
      return;
    }
    if (!filteredRows.some((row) => row.id === selectedRowId)) {
      setSelectedRowId(filteredRows[0].id);
    }
  }, [filteredRows, selectedRowId]);

  const updateFilter = (key, value) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setSelectedRowId('');
  };

  return (
    <div className="flex min-h-[calc(100dvh-8.5rem)] min-w-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-background/80 px-3 py-2">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] font-bold text-muted-foreground">Advanced trip tracking</div>
            <h1 className="font-grotesk text-xl font-bold tracking-normal">Drive Event Timeline</h1>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs sm:flex sm:flex-wrap sm:items-center">
            <StatusChip label="Rows" value={filteredRows.length} />
            <StatusChip label="Diagnostic" value={rows.filter((row) => row.diagnostic).length} />
            <StatusChip label="Privacy masked" value={rows.filter((row) => row.privacyStatus === 'privacy masked').length} />
            <StatusChip label="Sources" value={sourceOptions.length} />
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[minmax(13rem,1.5fr)_repeat(5,minmax(8rem,1fr))]">
          <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
            Trip
            <select
              value={effectiveSelectedTripId}
              onChange={(event) => {
                setSelectedTripId(event.target.value);
                setSelectedRowId('');
              }}
              className="h-9 rounded-md border border-border bg-card px-2 text-sm text-foreground"
            >
              {!summaries.length && <option value="">No completed trips</option>}
              {summaries.map((trip) => (
                <option key={trip.id} value={trip.id}>{formatTripLabel(trip)}</option>
              ))}
            </select>
          </label>
          <FilterSelect label="Event type" value={filters.eventType} onChange={(value) => updateFilter('eventType', value)} options={[{ value: 'all', label: 'All event types' }, ...eventTypeOptions]} />
          <FilterSelect
            label="Severity/confidence"
            value={filters.severity}
            onChange={(value) => updateFilter('severity', value)}
            options={[
              { value: 'all', label: 'All levels' },
              { value: 'high', label: 'High' },
              { value: 'medium', label: 'Medium' },
              { value: 'low', label: 'Low' },
              { value: 'diagnostic', label: 'Diagnostic' },
            ]}
          />
          <FilterSelect label="Source" value={filters.source} onChange={(value) => updateFilter('source', value)} options={[{ value: 'all', label: 'All sources' }, ...sourceOptions]} />
          <FilterSelect
            label="Privacy"
            value={filters.privacy}
            onChange={(value) => updateFilter('privacy', value)}
            options={[
              { value: 'all', label: 'All privacy states' },
              { value: 'masked', label: 'Privacy masked' },
              { value: 'retained', label: 'Retained' },
            ]}
          />
          <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
            Date
            <input
              type="date"
              value={filters.date}
              onChange={(event) => updateFilter('date', event.target.value)}
              className="h-9 rounded-md border border-border bg-card px-2 text-sm text-foreground"
            />
          </label>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <main className="min-h-0 min-w-0 border-b border-border lg:border-b-0 lg:border-r">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card/70 px-3 py-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <ListFilter className="h-4 w-4 text-muted-foreground" />
                Recorded events
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Search className="h-3.5 w-3.5" />
                {filtersPending
                  ? 'Applying filter'
                  : summariesLoading || selectedTripLoading
                    ? 'Reading local trip detail'
                    : `${rows.length} normalized rows`}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="min-w-[58rem] w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 z-10 bg-background text-[11px] uppercase tracking-normal text-muted-foreground">
                  <tr className="border-b border-border">
                    <Th>Time</Th>
                    <Th>Event type</Th>
                    <Th>Value</Th>
                    <Th>Speed</Th>
                    <Th>Limit/source</Th>
                    <Th>Confidence</Th>
                    <Th>Source</Th>
                    <Th>Privacy status</Th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => setSelectedRowId(row.id)}
                      className={`cursor-pointer border-b border-border/70 hover:bg-secondary/70 ${selectedRow?.id === row.id ? 'bg-primary/10' : ''}`}
                    >
                      <Td>{formatTrackingEventTime(row.timestamp)}</Td>
                      <Td>
                        <div className="font-semibold text-foreground">{row.label}</div>
                        <div className="mt-0.5 text-muted-foreground">{row.scoringStatus}</div>
                      </Td>
                      <Td>{row.valueLabel}</Td>
                      <Td>{row.speedLabel}</Td>
                      <Td>{row.limitLabel}</Td>
                      <Td>{row.confidence}</Td>
                      <Td>{row.sourceLabel}</Td>
                      <Td>
                        <span className={`rounded-sm px-1.5 py-1 font-semibold ${row.privacyStatus === 'privacy masked' ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'}`}>
                          {row.privacyStatus}
                        </span>
                      </Td>
                    </tr>
                  ))}
                  {!filteredRows.length && (
                    <tr>
                      <td colSpan={8} className="px-4 py-14 text-center text-sm text-muted-foreground">
                        {selectedTrip ? 'No events recorded for the selected filters.' : 'No completed trip selected.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </main>

        <aside className="min-h-0 bg-card/80">
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-border px-3 py-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Info className="h-4 w-4 text-muted-foreground" />
                Event details
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">Detection context and evidence notes</div>
            </div>
            <div className="space-y-3 overflow-y-auto p-3">
              {selectedRow ? (
                <>
                  <InspectorBlock title={selectedRow.label} icon={Clock}>
                    <InspectorRow label="Time" value={formatTrackingEventTime(selectedRow.timestamp)} />
                    <InspectorRow label="Event type" value={selectedRow.type} />
                    <InspectorRow label="Scoring" value={selectedRow.scoringStatus} />
                    <InspectorRow label="Severity" value={selectedRow.severity} />
                    <InspectorRow label="Confidence" value={selectedRow.confidence} />
                    <InspectorRow label="Privacy" value={selectedRow.privacyStatus} />
                  </InspectorBlock>

                  <InspectorBlock title="Why Detected" icon={AlertTriangle}>
                    <p className="text-xs leading-relaxed text-muted-foreground">{selectedRow.detectionReason}</p>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{selectedRow.thresholdNote}</p>
                  </InspectorBlock>

                  <InspectorBlock title="Evidence" icon={Filter}>
                    <InspectorRow label="Metric" value={selectedRow.metricLabel} />
                    <InspectorRow label="Source" value={selectedRow.sourceLabel} />
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{selectedRow.dataSourceNote}</p>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{selectedRow.evidenceNote}</p>
                  </InspectorBlock>

                  <InspectorBlock title="Related Route Point" icon={Shield}>
                    {selectedRow.relatedRoutePoint ? (
                      <>
                        <InspectorRow label="Point index" value={selectedRow.relatedRoutePoint.index} />
                        <InspectorRow label="Point time" value={formatTrackingEventTime(selectedRow.relatedRoutePoint.timestamp)} />
                        <InspectorRow label="Point speed" value={selectedRow.relatedRoutePoint.speedKmh == null ? 'source unavailable' : `${Math.round(selectedRow.relatedRoutePoint.speedKmh)} km/h`} />
                        <InspectorRow label="Delta" value={`${selectedRow.relatedRoutePoint.deltaSeconds}s`} />
                        <InspectorRow label="Coordinates" value={selectedRow.relatedRoutePoint.privacyStatus === 'privacy masked' ? 'privacy masked' : 'available on map surface'} />
                      </>
                    ) : (
                      <p className="text-xs leading-relaxed text-muted-foreground">Related route point source unavailable.</p>
                    )}
                  </InspectorBlock>
                </>
              ) : (
                <div className="grid min-h-64 place-items-center rounded-md border border-dashed border-border p-6 text-center">
                  <div>
                    <Info className="mx-auto h-6 w-6 text-muted-foreground" />
                    <p className="mt-2 text-sm font-semibold">No event selected</p>
                    <p className="mt-1 text-xs text-muted-foreground">Select a log row to inspect thresholds, sources, and route context.</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function StatusChip({ label, value }) {
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-2 font-semibold text-foreground">{value}</span>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-border bg-card px-2 text-sm text-foreground"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function Th({ children }) {
  return <th className="whitespace-nowrap px-3 py-2 font-semibold">{children}</th>;
}

function Td({ children }) {
  return <td className="align-top px-3 py-2.5">{children}</td>;
}

function InspectorBlock({ title, icon: Icon, children }) {
  return (
    <section className="rounded-md border border-border bg-background/70 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
        <Icon className="h-4 w-4" />
        {title}
      </div>
      {children}
    </section>
  );
}

function InspectorRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/50 py-1.5 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="max-w-[62%] text-right text-xs font-semibold">{compactValue(value)}</span>
    </div>
  );
}
