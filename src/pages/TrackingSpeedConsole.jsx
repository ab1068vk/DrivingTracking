import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Gauge,
  MapPinned,
  Mic,
  Pencil,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { tripService } from '@/api/trips';
import { readSpeedKnowledgeData } from '@/lib/speedKnowledgeRepository';
import {
  buildTrackingSpeedConsoleData,
  speedThresholdStatus,
} from '@/lib/trackingSpeedConsole';

const formatDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
    : 'source unavailable';
};

const formatLimit = (value) => {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 ? `${Math.round(limit)} km/h` : 'source unavailable';
};

export default function TrackingSpeedConsole() {
  const { data: trips = [], isLoading: tripsLoading } = useQuery({
    queryKey: ['tracking-speed-console-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 100 }),
    staleTime: 2 * 60 * 1000,
  });
  const { data: speedKnowledgeData = { cells: {}, corrections: [] }, isLoading: knowledgeLoading } = useQuery({
    queryKey: ['tracking-speed-console-knowledge'],
    queryFn: () => readSpeedKnowledgeData().then((data) => data || { cells: {}, corrections: [] }),
    staleTime: 30 * 1000,
  });
  const consoleData = useMemo(
    () => buildTrackingSpeedConsoleData({ trips, speedKnowledgeData }),
    [speedKnowledgeData, trips]
  );

  const sourceRows = consoleData.sourceSummary.slice(0, 8);
  const reviewRows = consoleData.pendingReviewRows.slice(0, 8);
  const tripRows = consoleData.tripCoverageRows.slice(0, 10);
  const loading = tripsLoading || knowledgeLoading;

  return (
    <div className="flex min-h-[calc(100dvh-8.5rem)] min-w-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-background/80 px-3 py-2">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] font-bold text-muted-foreground">Advanced trip tracking</div>
            <h1 className="font-grotesk text-xl font-bold tracking-normal">Speed Intelligence</h1>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Posted, estimated, learned, and user-entered speed sources are shown separately. Posted signs override app estimates.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ToolbarLink to="/speed-limits?view=review" icon={SlidersHorizontal}>Review rules</ToolbarLink>
            <ToolbarLink to="/speed-limits?view=saved" icon={Pencil}>Edit saved</ToolbarLink>
            <ToolbarLink to="/speed-limits?view=map" icon={MapPinned}>Map editor</ToolbarLink>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <section className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-6">
          <MetricStrip label="Saved rules" value={consoleData.counts.savedRuleCount} icon={Gauge} />
          <MetricStrip label="Posted sources" value={consoleData.counts.postedSourceCount} icon={ShieldCheck} />
          <MetricStrip label="Estimated sources" value={consoleData.counts.estimatedSourceCount} icon={AlertTriangle} />
          <MetricStrip label="Learned cells" value={consoleData.counts.learnedCellCount} icon={MapPinned} />
          <MetricStrip label="Voice markers" value={consoleData.counts.pendingVoiceMarkerCount} icon={Mic} />
          <MetricStrip label="Review queue" value={consoleData.counts.pendingReviewCount} icon={SlidersHorizontal} />
        </section>

        <section className="grid min-w-0 gap-3 px-3 pb-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <Panel title="Source Confidence" detail={loading ? 'Reading local speed data' : `${sourceRows.length} source classes`}>
            <div className="overflow-x-auto">
              <table className="min-w-[42rem] w-full text-left text-xs">
                <thead className="border-b border-border text-[11px] uppercase tracking-normal text-muted-foreground">
                  <tr>
                    <Th>Source</Th>
                    <Th>Type</Th>
                    <Th>Count</Th>
                    <Th>Avg confidence</Th>
                    <Th>Review</Th>
                    <Th>Fallback reason</Th>
                  </tr>
                </thead>
                <tbody>
                  {sourceRows.map((row) => (
                    <tr key={row.source} className="border-b border-border/70">
                      <Td><span className="font-semibold text-foreground">{row.sourceLabel}</span></Td>
                      <Td>{row.sourceGroup}</Td>
                      <Td>{row.count}</Td>
                      <Td>{row.averageConfidencePercent}%</Td>
                      <Td>{row.needsReview}</Td>
                      <Td>{row.fallbackReason}</Td>
                    </tr>
                  ))}
                  {!sourceRows.length && <EmptyRow colSpan={6} text="No local speed sources recorded." />}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Review Queue" detail={`${consoleData.counts.expiringRuleCount} expiring / ${consoleData.counts.expiredRuleCount} expired`}>
            <div className="grid gap-2">
              {reviewRows.map((row) => (
                <Link key={row.id} to={row.editHref} className="rounded-md border border-border bg-background/70 p-3 text-sm hover:bg-secondary/70">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{row.roadName}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{row.sourceLabel} / {formatLimit(row.limitKmh)} / {row.confidenceLabel}</div>
                    </div>
                    <span className="rounded-sm bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                      {row.expiry?.label || row.recommendation?.action || 'Review'}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{row.recommendation?.text || row.fallbackReason}</p>
                </Link>
              ))}
              {!reviewRows.length && (
                <div className="rounded-md border border-border bg-background/70 p-5 text-center text-sm text-muted-foreground">
                  No local speed rules currently require review.
                </div>
              )}
            </div>
          </Panel>
        </section>

        <section className="grid min-w-0 gap-3 px-3 pb-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Panel title="Trip Coverage" detail={`${consoleData.counts.tripCoverageCount} trips with route speed context`}>
            <div className="overflow-x-auto">
              <table className="min-w-[52rem] w-full text-left text-xs">
                <thead className="border-b border-border text-[11px] uppercase tracking-normal text-muted-foreground">
                  <tr>
                    <Th>Trip</Th>
                    <Th>Total coverage</Th>
                    <Th>Posted/verified</Th>
                    <Th>Estimated</Th>
                    <Th>Low confidence</Th>
                    <Th>Threshold</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {tripRows.map((row) => (
                    <tr key={row.tripId} className="border-b border-border/70">
                      <Td>
                        <div className="font-semibold text-foreground">{formatDate(row.startTime)}</div>
                        <div className="text-muted-foreground">{row.tripId}</div>
                      </Td>
                      <Td>{row.coveragePercent}%</Td>
                      <Td>{row.verifiedCoveragePercent}%</Td>
                      <Td>{row.estimatedCoveragePercent}%</Td>
                      <Td>{row.lowConfidencePointCount}</Td>
                      <Td>{row.thresholdExceededPointCount} point{row.thresholdExceededPointCount === 1 ? '' : 's'} / max {Math.round(row.maxOverKmh || 0)} km/h</Td>
                      <Td>
                        <div className="flex flex-wrap gap-2">
                          <Link className="rounded-sm border border-border px-2 py-1 font-semibold hover:bg-secondary" to={row.reviewHref}>Review</Link>
                          <Link className="rounded-sm border border-border px-2 py-1 font-semibold hover:bg-secondary" to={row.analysisHref}>Analyze</Link>
                        </div>
                      </Td>
                    </tr>
                  ))}
                  {!tripRows.length && <EmptyRow colSpan={7} text="No completed trips with retained route points." />}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="How road speeds work" detail="Neutral tracking language">
            <div className="space-y-3 text-sm">
              <Note icon={CheckCircle2} title="Posted signs override app estimates" text="User-confirmed posted signs and observed posted data are separated from estimates and learned rules." />
              <Note icon={AlertTriangle} title="Threshold exceeded" text={`Sample language: ${speedThresholdStatus({ speed_kmh: 68, speed_limit_kmh: 60 })}.`} />
              <Note icon={SlidersHorizontal} title="Existing edit flow" text="Rule edits, voice marker review, imports, exports, and rescore actions remain in Saved Road Speeds." />
              <Note icon={Gauge} title="Source confidence" text="Estimated and learned sources stay visible as source-confidence telemetry, not posted-sign evidence." />
            </div>
          </Panel>
        </section>
      </main>
    </div>
  );
}

function ToolbarLink({ to, icon: Icon, children }) {
  return (
    <Link to={to} className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary">
      <Icon className="h-4 w-4" />
      {children}
    </Link>
  );
}

function MetricStrip({ label, value, icon: Icon }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
    </div>
  );
}

function Panel({ title, detail, children }) {
  return (
    <section className="min-w-0 rounded-md border border-border bg-card/80">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="font-semibold">{title}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Note({ icon: Icon, title, text }) {
  return (
    <div className="rounded-md border border-border bg-background/70 p-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
        <Icon className="h-4 w-4" />
        {title}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{text}</p>
    </div>
  );
}

function Th({ children }) {
  return <th className="whitespace-nowrap px-3 py-2 font-semibold">{children}</th>;
}

function Td({ children }) {
  return <td className="align-top px-3 py-2.5">{children}</td>;
}

function EmptyRow({ colSpan, text }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-sm text-muted-foreground">{text}</td>
    </tr>
  );
}
