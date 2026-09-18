import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Database,
  Download,
  FileJson,
  FileText,
  ShieldCheck,
  Table,
} from 'lucide-react';
import { p7QueryKeys, p7TripQueries, tripService } from '@/api/trips';
import useLocalSettings from '@/hooks/useLocalSettings';
import { Button } from '@/components/ui/button';
import { downloadCSV } from '@/lib/tripEngine';
import { readSpeedKnowledgeSample } from '@/lib/speedKnowledgeRepository';
import { getSystemLogs } from '@/lib/systemLog';
import { resolveBackupCapabilities } from '@/lib/backupCapabilities';
import {
  buildRouteQualityRows,
  buildSpeedSourceAuditRows,
  buildSpeedSourceCoverageRows,
  buildTechnicalReportPayload,
  buildTechnicalTripCsvStream,
  buildTripEventExportRows,
  buildVoiceAlertLogCsv,
  ROUTE_QUALITY_CSV_HEADERS,
  rowsToCsv,
  SPEED_SOURCE_CSV_HEADERS,
  TRIP_EVENT_CSV_HEADERS,
} from '@/lib/trackingExportLab';
import {
  createEvidenceSummaryAccumulator,
  EVIDENCE_FAILURE,
  streamTripEvidence,
} from '@/lib/trackingEvidenceExport';

const todayStamp = () => new Date().toISOString().slice(0, 10);

const exportFilename = (name, ext) => `road-sage-${name}-${todayStamp()}.${ext}`;

/**
 * HPR-019 - what the user is told when a scan did not finish.
 *
 * Each of these ends the export. A file that stopped early must never be handed
 * over as a finished one, and a signed manifest must never authenticate a
 * population the walk did not actually reach the end of.
 */
const EVIDENCE_FAILURE_MESSAGE = {
  [EVIDENCE_FAILURE.PAGE_UNAVAILABLE]:
    'The full history could not be read, so nothing was exported. Your saved trips were not changed.',
  [EVIDENCE_FAILURE.SOURCE_MOVED]:
    'Your trips changed while the export was being prepared, so nothing was exported. Run it again to get one complete file.',
  [EVIDENCE_FAILURE.DETAIL_READ_FAILED]:
    'One trip could not be read, so nothing was exported rather than a file that silently leaves it out.',
  [EVIDENCE_FAILURE.SCAN_LIMIT_REACHED]:
    'The history is larger than one export run can cover, so nothing was exported.',
};

const yieldToPaint = () => new Promise((resolve) => {
  if (typeof window === 'undefined') {
    resolve();
    return;
  }
  window.setTimeout(resolve, 0);
});

export default function TrackingReportsLab() {
  const settings = useLocalSettings();
  const backupCapabilities = resolveBackupCapabilities();
  const [status, setStatus] = useState('');
  const [busyId, setBusyId] = useState('');

  // P7 Stage 8 (ledger entry #18, O27). `tripService.list({limit:250})` read
  // and decrypted **every** trip in the store on mount, to render a table of
  // five row counts. This page now holds **no trip array at render**: the trip
  // count comes from the completed-only D1 owner, and every export streams its
  // own bounded scan when the user runs it, one trip resident at a time.
  const { data: completedTotals, isLoading: tripsLoading } = useQuery({
    queryKey: p7QueryKeys.aggregate('reports-lab', 'lifetime'),
    queryFn: () => p7TripQueries.aggregate({ scope: 'global' }),
    staleTime: 2 * 60 * 1000,
  });
  const lifetimeTripCount = completedTotals?.unavailable
    ? null
    : (Number.isFinite(completedTotals?.data?.totals?.completedCount)
      ? completedTotals.data.totals.completedCount
      : null);

  /**
   * **O27**, corrected by HPR-019 - the export scan.
   *
   * It used to accumulate every Q1 **projection row** and hand that array to the
   * evidence builders. The projection has no `route_points` and no
   * `driving_events`, so those builders recorded zeros for trips whose canonical
   * records hold both, and the array itself grew with the whole history.
   *
   * Now the walk hands the caller one bounded chunk of **canonical records** at a
   * time and keeps none of them. Evidence comes from the per-trip authority; what
   * each export retains is its own output, not the population.
   */
  const streamEvidence = async (onChunk) => {
    const result = await streamTripEvidence({
      readPage: (request) => p7TripQueries.historyPage(request),
      // The export read does not persist its own preparation, so the walk cannot
      // move the source it is about to claim; the snapshot read is how it proves
      // nothing else moved it either.
      readTrip: (id) => tripService.readFullByIdForExport(id),
      readSourceSnapshot: () => tripService.readQuerySnapshot(),
      onChunk,
    });
    if (!result.complete) {
      setStatus(EVIDENCE_FAILURE_MESSAGE[result.failure?.code]
        || 'The export did not finish, so no file was created.');
      return null;
    }
    return result;
  };

  const { data: speedKnowledgeData = { cells: {}, corrections: [] } } = useQuery({
    queryKey: ['tracking-reports-speed-knowledge'],
    queryFn: () => readSpeedKnowledgeSample(8).then((data) => data || { cells: {}, corrections: [] }),
    staleTime: 30 * 1000,
  });
  const { data: systemLogs = [] } = useQuery({
    queryKey: ['tracking-reports-system-logs'],
    queryFn: () => getSystemLogs(),
    staleTime: 10 * 1000,
  });
  const { data: nativeDiagnostics = { events: [] } } = useQuery({
    queryKey: ['tracking-reports-native-diagnostics'],
    queryFn: () => import('@/lib/activityRecognition')
      .then(({ getNativeDiagnostics }) => getNativeDiagnostics())
      .catch(() => ({ events: [] })),
    staleTime: 15 * 1000,
  });

  /**
   * The render payload describes only what this page holds without a scan: the
   * diagnostics rows, which come from the system log rather than from trips.
   *
   * HPR-019: it is no longer the payload that gets signed or printed. Building a
   * manifest from `trips: []` while the card beside it advertised the lifetime
   * count is the defect this wave removes - the signed artifact now comes from
   * the same walk that produced its evidence, so its population claim and its
   * counts cannot disagree.
   */
  const diagnosticsPayload = useMemo(
    () => buildTechnicalReportPayload({
      trips: [],
      settings,
      speedKnowledgeData,
      systemLogs,
      nativeDiagnostics,
    }),
    [nativeDiagnostics, settings, speedKnowledgeData, systemLogs]
  );

  /**
   * One bounded walk of the population, reduced to O(1) totals plus a bounded
   * row extract, then turned into the signed/printed artifact. Nothing here
   * grows with how much the user has driven.
   */
  const buildPopulationSummaryPayload = async () => {
    const accumulator = createEvidenceSummaryAccumulator();
    const scan = await streamEvidence(({ trips }) => {
      accumulator.addChunk({
        routeQualityRows: buildRouteQualityRows(trips, settings),
        eventRows: buildTripEventExportRows(trips, settings),
      });
    });
    if (!scan) return null;
    return buildTechnicalReportPayload({
      summary: {
        population: { complete: scan.complete, source: scan.snapshot },
        totals: accumulator.totals(),
        extracts: accumulator.extracts(),
      },
      settings,
      speedKnowledgeData,
      systemLogs,
      nativeDiagnostics,
    });
  };

  const runExport = async (id, task) => {
    setBusyId(id);
    setStatus('Preparing export.');
    try {
      await yieldToPaint();
      const result = await task();
      // A task that stopped has already said why. Announcing "prepared" over it
      // would be the same untruth in a different place.
      if (result === null) return;
      setStatus(`${result?.filename || 'Export'} prepared.`);
    } catch (error) {
      setStatus(error?.message || 'Export did not complete.');
    } finally {
      setBusyId('');
    }
  };

  const actions = [
    {
      id: 'trip-table',
      label: 'Trip table CSV',
      detail: 'Existing trip CSV export with privacy-export masking applied first.',
      format: 'CSV',
      count: lifetimeTripCount,
      icon: Table,
      privacy: 'maskTripForPrivacyExport + existing tripsToCSV',
      run: async () => {
        const csv = buildTechnicalTripCsvStream(settings);
        const scan = await streamEvidence(({ trips }) => csv.addChunk(trips));
        if (!scan) return null;
        return downloadCSV(csv.csv(), exportFilename('technical-trip-table', 'csv'));
      },
    },
    {
      id: 'event-csv',
      label: 'Trip event CSV',
      detail: 'Event log rows with neutral labels, source, confidence, privacy status, and scoring status.',
      format: 'CSV',
      count: null,
      icon: Database,
      privacy: 'No coordinate columns; privacy rows use masked status.',
      run: async () => {
        const rows = [];
        const scan = await streamEvidence(({ trips }) => {
          rows.push(...buildTripEventExportRows(trips, settings));
        });
        if (!scan) return null;
        return downloadCSV(rowsToCsv(TRIP_EVENT_CSV_HEADERS, rows), exportFilename('trip-event-technical-log', 'csv'));
      },
    },
    {
      id: 'route-quality',
      label: 'Route point quality summary',
      detail: 'Raw, retained, map/playback, gap, speed sample, and privacy placeholder counts.',
      format: 'CSV',
      count: lifetimeTripCount,
      icon: ShieldCheck,
      privacy: 'Counts only; private route samples remain placeholders.',
      run: async () => {
        const rows = [];
        const scan = await streamEvidence(({ trips }) => {
          rows.push(...buildRouteQualityRows(trips, settings));
        });
        if (!scan) return null;
        return downloadCSV(rowsToCsv(ROUTE_QUALITY_CSV_HEADERS, rows), exportFilename('route-quality-summary', 'csv'));
      },
    },
    {
      id: 'speed-audit',
      label: 'Speed-source audit CSV',
      detail: 'Posted, estimated, learned, and voice-marker source rows with confidence and fallback reason.',
      format: 'CSV',
      count: null,
      icon: Table,
      privacy: 'No raw coordinates or learned cell geohash keys.',
      run: async () => {
        // The knowledge-base rows do not depend on trips, so they are built once;
        // the per-trip coverage rows are appended chunk by chunk. Before HPR-019
        // this export scanned the whole history and then discarded every row of
        // it, because the builder it fed reads only the knowledge base.
        const rows = buildSpeedSourceAuditRows({ trips: [], settings, speedKnowledgeData });
        const scan = await streamEvidence(({ trips }) => {
          rows.push(...buildSpeedSourceCoverageRows(trips, settings));
        });
        if (!scan) return null;
        return downloadCSV(rowsToCsv(SPEED_SOURCE_CSV_HEADERS, rows), exportFilename('speed-source-audit', 'csv'));
      },
    },
    {
      id: 'voice-log',
      label: 'Voice alert log export',
      detail: 'Recent WebView and native alert diagnostics when available.',
      format: 'CSV',
      count: diagnosticsPayload.counts.voice_alert_row_count,
      icon: Database,
      privacy: 'Sanitized log fields only; full diagnostic details are not included.',
      run: () => downloadCSV(buildVoiceAlertLogCsv({ systemLogs, nativeDiagnostics }), exportFilename('voice-alert-log', 'csv')),
    },
    {
      id: 'technical-pdf',
      label: 'Privacy-safe technical PDF',
      detail: 'Table-based report for route quality, event evidence, and speed-source summaries.',
      format: 'PDF',
      count: lifetimeTripCount,
      icon: FileText,
      privacy: 'PDF uses the same privacy-safe payload as the technical manifest.',
      run: async () => {
        const reportPayload = await buildPopulationSummaryPayload();
        if (!reportPayload) return null;
        const { exportTechnicalReportPDF } = await import('@/lib/pdfExport');
        return exportTechnicalReportPDF(reportPayload, settings);
      },
    },
    {
      id: 'manifest',
      label: 'Signed technical manifest',
      detail: 'JSON manifest signed with the existing export integrity envelope.',
      format: 'JSON',
      count: lifetimeTripCount,
      icon: FileJson,
      privacy: 'Signed payload declares zero coordinate columns and no private-zone geometry.',
      run: async () => {
        // HPR-019: the signed bytes now carry the population they describe, read
        // by the same walk that produced the evidence totals beside it.
        const reportPayload = await buildPopulationSummaryPayload();
        if (!reportPayload) return null;
        const { signExport } = await import('@/lib/exportIntegrity');
        const { downloadJsonFile } = await import('@/lib/dataRights');
        const signed = await signExport(reportPayload);
        return downloadJsonFile(exportFilename('signed-technical-manifest', 'json'), signed);
      },
    },
    {
      id: 'portability',
      label: 'Data portability bundle',
      detail: 'Existing data-rights export path with privacy-safe trip and privacy-zone placeholders.',
      format: 'JSON',
      count: lifetimeTripCount,
      icon: FileJson,
      privacy: 'Reuses dataRights.js portability masking.',
      run: async () => {
        const { exportDataPortabilityBundle } = await import('@/lib/dataRights');
        return exportDataPortabilityBundle();
      },
    },
  ];

  return (
    <div className="flex min-h-[calc(100dvh-8.5rem)] min-w-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-background/80 px-3 py-2">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] font-bold text-muted-foreground">Advanced trip tracking</div>
            <h1 className="font-grotesk text-xl font-bold tracking-normal">Share and Export Trips</h1>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Technical exports reuse existing privacy-safe CSV, PDF, data-rights, and export-integrity paths.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs sm:flex sm:flex-wrap">
            <StatusChip label="Trips" value={tripsLoading ? '...' : (lifetimeTripCount ?? 'unavailable')} />
            <StatusChip label="Voice alert rows" value={diagnosticsPayload.counts.voice_alert_row_count} />
            <StatusChip label="Private coords" value="0" />
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <section className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 rounded-md border border-border bg-card/80">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <div>
                <div className="text-sm font-semibold">Export options</div>
                <div className="text-xs text-muted-foreground">{tripsLoading ? 'Reading local trips.' : `${actions.length} export paths available`}</div>
              </div>
              <div className="text-xs font-semibold text-muted-foreground">{status || 'No export running.'}</div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[62rem] w-full text-left text-xs">
                <thead className="border-b border-border text-[11px] uppercase tracking-normal text-muted-foreground">
                  <tr>
                    <Th>Export</Th>
                    <Th>Format</Th>
                    <Th>Rows</Th>
                    <Th>Privacy path</Th>
                    <Th>Action</Th>
                  </tr>
                </thead>
                <tbody>
                  {actions.map((action) => {
                    const Icon = action.icon;
                    return (
                      <tr key={action.id} className="border-b border-border/70">
                        <Td>
                          <div className="flex items-start gap-2">
                            <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
                            <div>
                              <div className="font-semibold text-foreground">{action.label}</div>
                              <div className="text-muted-foreground">{action.detail}</div>
                            </div>
                          </div>
                        </Td>
                        <Td>{action.format}</Td>
                        {/* O27: a row count that only the export scan can
                            know is not guessed from a loaded sample. */}
                        <Td>{action.count == null ? 'Counted on export' : action.count}</Td>
                        <Td>{action.privacy}</Td>
                        <Td>
                          <Button
                            type="button"
                            onClick={() => runExport(action.id, action.run)}
                            disabled={Boolean(busyId)}
                            loading={busyId === action.id}
                            loadingText="Preparing export..."
                            size="sm"
                          >
                            <Download className="h-4 w-4" />
                            Export
                          </Button>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="min-w-0 rounded-md border border-border bg-card/80">
            <div className="border-b border-border px-3 py-2">
              <div className="text-sm font-semibold">Export details</div>
              <div className="text-xs text-muted-foreground">Privacy and estimate labels</div>
            </div>
            <div className="space-y-3 p-3 text-sm">
              <InspectorRow label="Format" value={`${diagnosticsPayload.format} v${diagnosticsPayload.version}`} />
              <InspectorRow label="Score output" value={diagnosticsPayload.score_notice} />
              <InspectorRow label="Coordinate columns" value={diagnosticsPayload.privacy.coordinate_columns_exported.length} />
              <InspectorRow label="Private-zone geometry" value={diagnosticsPayload.privacy.private_zone_geometry_exported ? 'exported' : 'not exported'} />
              <InspectorRow label="Privacy transform" value={diagnosticsPayload.privacy.transform} />
              <InspectorRow
                label="Full backup"
                value={backupCapabilities.browserJsonExportAvailable
                  ? 'Use Settings for encrypted or disclosure-gated readable JSON backup.'
                  : 'Use Settings for encrypted native .rsb2 backup and restore.'}
              />
              <div className="rounded-md border border-border bg-background/70 p-3 text-xs leading-relaxed text-muted-foreground">
                Coaching reports remain available in <a href="/reports" className="font-semibold text-primary">Reports</a>. This view adds privacy-safe formats for advanced trip tracking.
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

function StatusChip({ label, value }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-bold">{value}</div>
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
