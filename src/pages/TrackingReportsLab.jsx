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
import { tripService } from '@/api/trips';
import useLocalSettings from '@/hooks/useLocalSettings';
import { downloadCSV } from '@/lib/tripEngine';
import { readSpeedKnowledgeData } from '@/lib/speedKnowledgeRepository';
import { getSystemLogs } from '@/lib/systemLog';
import {
  buildRouteQualityCsv,
  buildSpeedSourceAuditCsv,
  buildTechnicalReportPayload,
  buildTechnicalTripCsv,
  buildTripEventCsv,
  buildVoiceAlertLogCsv,
} from '@/lib/trackingExportLab';

const todayStamp = () => new Date().toISOString().slice(0, 10);

const exportFilename = (name, ext) => `road-sage-${name}-${todayStamp()}.${ext}`;

const yieldToPaint = () => new Promise((resolve) => {
  if (typeof window === 'undefined') {
    resolve();
    return;
  }
  window.setTimeout(resolve, 0);
});

export default function TrackingReportsLab() {
  const settings = useLocalSettings();
  const [status, setStatus] = useState('');
  const [busyId, setBusyId] = useState('');

  const { data: trips = [], isLoading: tripsLoading } = useQuery({
    queryKey: ['tracking-reports-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 250 }),
    staleTime: 2 * 60 * 1000,
  });
  const { data: speedKnowledgeData = { cells: {}, corrections: [] } } = useQuery({
    queryKey: ['tracking-reports-speed-knowledge'],
    queryFn: () => readSpeedKnowledgeData().then((data) => data || { cells: {}, corrections: [] }),
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

  const payload = useMemo(
    () => buildTechnicalReportPayload({
      trips,
      settings,
      speedKnowledgeData,
      systemLogs,
      nativeDiagnostics,
    }),
    [nativeDiagnostics, settings, speedKnowledgeData, systemLogs, trips]
  );

  const runExport = async (id, task) => {
    setBusyId(id);
    setStatus('Preparing export.');
    try {
      await yieldToPaint();
      const result = await task();
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
      count: payload.counts.trip_count,
      icon: Table,
      privacy: 'maskTripForPrivacyExport + existing tripsToCSV',
      run: () => downloadCSV(buildTechnicalTripCsv(trips, settings), exportFilename('technical-trip-table', 'csv')),
    },
    {
      id: 'event-csv',
      label: 'Trip event CSV',
      detail: 'Event log rows with neutral labels, source, confidence, privacy status, and scoring status.',
      format: 'CSV',
      count: payload.counts.event_row_count,
      icon: Database,
      privacy: 'No coordinate columns; privacy rows use masked status.',
      run: () => downloadCSV(buildTripEventCsv(trips, settings), exportFilename('trip-event-technical-log', 'csv')),
    },
    {
      id: 'route-quality',
      label: 'Route point quality summary',
      detail: 'Raw, retained, map/playback, gap, speed sample, and privacy placeholder counts.',
      format: 'CSV',
      count: payload.counts.route_quality_row_count,
      icon: ShieldCheck,
      privacy: 'Counts only; private route samples remain placeholders.',
      run: () => downloadCSV(buildRouteQualityCsv(trips, settings), exportFilename('route-quality-summary', 'csv')),
    },
    {
      id: 'speed-audit',
      label: 'Speed-source audit CSV',
      detail: 'Posted, estimated, learned, and voice-marker source rows with confidence and fallback reason.',
      format: 'CSV',
      count: payload.counts.speed_source_row_count,
      icon: Table,
      privacy: 'No raw coordinates or learned cell geohash keys.',
      run: () => downloadCSV(buildSpeedSourceAuditCsv({ trips, settings, speedKnowledgeData }), exportFilename('speed-source-audit', 'csv')),
    },
    {
      id: 'voice-log',
      label: 'Voice alert log export',
      detail: 'Recent WebView and native alert diagnostics when available.',
      format: 'CSV',
      count: payload.counts.voice_alert_row_count,
      icon: Database,
      privacy: 'Sanitized log fields only; full diagnostic details are not included.',
      run: () => downloadCSV(buildVoiceAlertLogCsv({ systemLogs, nativeDiagnostics }), exportFilename('voice-alert-log', 'csv')),
    },
    {
      id: 'technical-pdf',
      label: 'Privacy-safe technical PDF',
      detail: 'Table-based report for route quality, event evidence, and speed-source summaries.',
      format: 'PDF',
      count: payload.counts.trip_count,
      icon: FileText,
      privacy: 'PDF uses the same privacy-safe payload as the technical manifest.',
      run: async () => {
        const { exportTechnicalReportPDF } = await import('@/lib/pdfExport');
        return exportTechnicalReportPDF(payload, settings);
      },
    },
    {
      id: 'manifest',
      label: 'Signed technical manifest',
      detail: 'JSON manifest signed with the existing export integrity envelope.',
      format: 'JSON',
      count: payload.counts.trip_count,
      icon: FileJson,
      privacy: 'Signed payload declares zero coordinate columns and no private-zone geometry.',
      run: async () => {
        const { signExport } = await import('@/lib/exportIntegrity');
        const { downloadJsonFile } = await import('@/lib/dataRights');
        const signed = await signExport(payload);
        return downloadJsonFile(exportFilename('signed-technical-manifest', 'json'), signed);
      },
    },
    {
      id: 'portability',
      label: 'Data portability bundle',
      detail: 'Existing data-rights export path with privacy-safe trip and privacy-zone placeholders.',
      format: 'JSON',
      count: payload.counts.trip_count,
      icon: FileJson,
      privacy: 'Reuses dataRights.js portability masking.',
      run: async () => {
        const { exportDataPortabilityBundle } = await import('@/lib/dataRights');
        return exportDataPortabilityBundle();
      },
    },
    {
      id: 'backup',
      label: 'Signed backup export',
      detail: 'Existing backup path with HMAC envelope and privacy-zone commitments.',
      format: 'JSON',
      count: payload.counts.trip_count,
      icon: FileJson,
      privacy: 'Reuses dataBackup.js privacy transform and exportIntegrity signing.',
      run: async () => {
        const { exportDriveSenseBackup } = await import('@/lib/dataBackup');
        return exportDriveSenseBackup({
          trips,
          settings,
          filename: exportFilename('tracking-signed-backup', 'json'),
        });
      },
    },
  ];

  return (
    <div className="flex min-h-[calc(100dvh-8.5rem)] min-w-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-background/80 px-3 py-2">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-normal text-muted-foreground">Advanced Tracking Mode</div>
            <h1 className="font-grotesk text-xl font-bold tracking-normal">Reports and Export Lab</h1>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Technical exports reuse existing privacy-safe CSV, PDF, backup, data-rights, and export-integrity paths.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs sm:flex sm:flex-wrap">
            <StatusChip label="Trips" value={payload.counts.trip_count} />
            <StatusChip label="Events" value={payload.counts.event_row_count} />
            <StatusChip label="Private coords" value="0" />
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <section className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 rounded-md border border-border bg-card/80">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <div>
                <div className="text-sm font-semibold">Technical Export Options</div>
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
                        <Td>{action.count}</Td>
                        <Td>{action.privacy}</Td>
                        <Td>
                          <button
                            type="button"
                            onClick={() => runExport(action.id, action.run)}
                            disabled={Boolean(busyId)}
                            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
                          >
                            <Download className="h-4 w-4" />
                            {busyId === action.id ? 'Preparing' : 'Export'}
                          </button>
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
              <div className="text-sm font-semibold">Payload Inspector</div>
              <div className="text-xs text-muted-foreground">Privacy and estimate labels</div>
            </div>
            <div className="space-y-3 p-3 text-sm">
              <InspectorRow label="Format" value={`${payload.format} v${payload.version}`} />
              <InspectorRow label="Score output" value={payload.score_notice} />
              <InspectorRow label="Coordinate columns" value={payload.privacy.coordinate_columns_exported.length} />
              <InspectorRow label="Private-zone geometry" value={payload.privacy.private_zone_geometry_exported ? 'exported' : 'not exported'} />
              <InspectorRow label="Privacy transform" value={payload.privacy.transform} />
              <div className="rounded-md border border-border bg-background/70 p-3 text-xs leading-relaxed text-muted-foreground">
                Existing coaching reports remain on <a href="/reports" className="font-semibold text-primary">/reports</a>. This lab exposes technical export paths for Advanced Tracking Mode.
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
