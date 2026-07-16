import { useDeferredValue, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Database,
  FileText,
  Info,
  Layers,
  Search,
} from 'lucide-react';
import { limitedTripSummaryQueryOptions, tripDetailQueryOptions } from '@/api/trips';
import useLocalSettings from '@/hooks/useLocalSettings';
import { formatDistance } from '@/lib/tripEngine';
import { buildTrackingEvidenceConsoleData } from '@/lib/trackingEvidence';

const SUMMARY_LIMIT = 50;

const formatTripLabel = (trip = {}, units = 'metric') => {
  const date = trip.start_time ? new Date(trip.start_time) : null;
  const when = date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
    : 'Trip time unavailable';
  const distance = Number.isFinite(Number(trip.distance_km)) ? formatDistance(Number(trip.distance_km), units) : 'distance unavailable';
  return `${when} / ${distance}`;
};

const rowTone = (row = {}) => {
  if (row.confidence === 'unavailable' || row.value === 'unavailable') return 'bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-200';
  if (row.confidence === 'diagnostic' || row.provisional) return 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200';
  return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200';
};

export default function TrackingEvidenceConsole() {
  const settings = useLocalSettings();
  const units = settings.units || 'metric';
  const [selectedTripId, setSelectedTripId] = useState('');
  const [tab, setTab] = useState('metrics');
  const [selectedRowId, setSelectedRowId] = useState('');
  const deferredTab = useDeferredValue(tab);

  const { data: summaries = [], isLoading: summariesLoading } = useQuery({
    ...limitedTripSummaryQueryOptions(SUMMARY_LIMIT),
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });
  const effectiveSelectedTripId = selectedTripId || (summaries[0]?.id ? String(summaries[0].id) : '');
  const deferredSelectedTripId = useDeferredValue(effectiveSelectedTripId);
  const evidencePending = deferredTab !== tab || deferredSelectedTripId !== effectiveSelectedTripId;
  const { data: selectedTripRaw, isLoading: selectedTripLoading } = useQuery(tripDetailQueryOptions(deferredSelectedTripId));
  const selectedTrip = selectedTripRaw || summaries.find((trip) => String(trip.id) === String(deferredSelectedTripId)) || null;

  const data = useMemo(
    () => buildTrackingEvidenceConsoleData({ trip: selectedTrip, settings }),
    [selectedTrip, settings]
  );
  const activeRows = deferredTab === 'sources'
    ? data.sourceRows
    : deferredTab === 'provenance'
      ? data.provenanceRows.map((row) => ({
        ...row,
        kind: 'provenance',
        confidence: row.value === 'unavailable' ? 'unavailable' : 'recorded',
        sampleCount: 'unavailable',
        dataSourceLabel: 'scoring engine',
        calibrationNote: row.detail,
      }))
      : data.metricRows;
  const selectedRow = activeRows.find((row) => row.id === selectedRowId) || activeRows[0] || null;

  return (
    <div className="flex min-h-[calc(100dvh-8.5rem)] min-w-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-background/80 px-3 py-2">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] font-bold text-muted-foreground">Advanced trip tracking</div>
            <h1 className="font-grotesk text-xl font-bold tracking-normal">Data Quality</h1>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Evidence inventory for recorded metrics, route samples, lookup status, sensor sources, and scoring provenance.
            </p>
          </div>
          <label className="grid min-w-0 gap-1 text-xs font-semibold text-muted-foreground sm:min-w-80">
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
                <option key={trip.id} value={trip.id}>{formatTripLabel(trip, units)}</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <section className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-5">
          <Metric icon={Database} label="Metrics" value={data.summary.metricCount} detail="registered or stored rows" />
          <Metric icon={Layers} label="Sources" value={data.summary.sourceCount} detail="route and context sources" />
          <Metric icon={Info} label="Unavailable" value={data.summary.unavailableCount} detail="missing evidence, not zero" />
          <Metric icon={Activity} label="Approximate" value={data.summary.provisionalCount} detail="provisional notes visible" />
          <Metric icon={FileText} label="Scoring version" value={data.summary.scoringVersion} detail="score provenance" />
        </section>

        <section className="grid min-h-[32rem] min-w-0 gap-3 px-3 pb-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 rounded-md border border-border bg-card/80">
            <div className="flex flex-col gap-2 border-b border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Search className="h-4 w-4 text-muted-foreground" />
                Evidence Rows
              </div>
              <div className="flex rounded-md border border-border bg-background p-1 text-xs font-semibold">
                {evidencePending && <span className="px-2 py-1.5 text-muted-foreground">Applying</span>}
                {[
                  ['metrics', 'Metrics'],
                  ['sources', 'Sources'],
                  ['provenance', 'Provenance'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setTab(value);
                      setSelectedRowId('');
                    }}
                    className={`rounded-sm px-3 py-1.5 ${tab === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[58rem] w-full text-left text-xs">
                <thead className="border-b border-border text-[11px] uppercase tracking-normal text-muted-foreground">
                  <tr>
                    <Th>Evidence item</Th>
                    <Th>Value/status</Th>
                    <Th>Samples</Th>
                    <Th>Confidence</Th>
                    <Th>Data source</Th>
                    <Th>Calibration note</Th>
                  </tr>
                </thead>
                <tbody>
                  {activeRows.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => setSelectedRowId(row.id)}
                      className={`cursor-pointer border-b border-border/70 hover:bg-secondary/70 ${selectedRow?.id === row.id ? 'bg-primary/10' : ''}`}
                    >
                      <Td>
                        <div className="font-semibold text-foreground">{row.label}</div>
                        <div className="text-muted-foreground">{row.metricKey || row.kind || 'evidence'}</div>
                      </Td>
                      <Td>{row.value}</Td>
                      <Td>{row.sampleCount}</Td>
                      <Td>
                        <span className={`rounded-sm px-1.5 py-1 font-semibold ${rowTone(row)}`}>{row.confidence || 'recorded'}</span>
                      </Td>
                      <Td>{row.dataSourceLabel}</Td>
                      <Td>{row.calibrationNote || row.detail || 'unavailable'}</Td>
                    </tr>
                  ))}
                  {!activeRows.length && (
                    <tr>
                      <td colSpan={6} className="px-3 py-12 text-center text-sm text-muted-foreground">
                        {summariesLoading || selectedTripLoading ? 'Reading local trip evidence.' : 'No evidence rows available for this trip.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="min-w-0 rounded-md border border-border bg-card/80">
            <div className="border-b border-border px-3 py-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Info className="h-4 w-4 text-muted-foreground" />
                Measurement details
              </div>
              <div className="text-xs text-muted-foreground">What data exists and how reliable it is</div>
            </div>
            {selectedRow ? (
              <div className="space-y-3 p-3 text-sm">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Selected</div>
                  <div className="mt-1 font-semibold">{selectedRow.label}</div>
                </div>
                <InspectorRow label="Value/status" value={selectedRow.value} />
                <InspectorRow label="Sample count" value={selectedRow.sampleCount} />
                <InspectorRow label="Evidence level" value={selectedRow.confidence || 'recorded'} />
                <InspectorRow label="Data source" value={selectedRow.dataSourceLabel} />
                <InspectorRow label="Scoring version" value={selectedRow.provenance || data.summary.scoringVersion} />
                <div className="rounded-md border border-border bg-background/70 p-3 text-xs leading-relaxed text-muted-foreground">
                  <div className="font-semibold text-foreground">Calibration / limitation</div>
                  <p className="mt-2">{selectedRow.calibrationNote || selectedRow.detail || 'unavailable'}</p>
                </div>
              </div>
            ) : (
              <div className="p-6 text-center text-sm text-muted-foreground">Select an evidence row.</div>
            )}
          </aside>
        </section>
      </main>
    </div>
  );
}

function Metric({ icon: Icon, label, value, detail }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 line-clamp-2 text-lg font-bold leading-tight">{value}</div>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function InspectorRow({ label, value }) {
  return (
    <div className="rounded-md border border-border bg-background/70 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm font-semibold">{value}</div>
    </div>
  );
}

function Th({ children }) {
  return <th className="whitespace-nowrap px-3 py-2 font-semibold">{children}</th>;
}

function Td({ children }) {
  return <td className="align-top px-3 py-3">{children}</td>;
}
