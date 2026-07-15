import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  EyeOff,
  Lock,
  Radio,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import useLocalSettings from '@/hooks/useLocalSettings';
import { localSettings } from '@/lib/trackingStore';
import { loadPrivacyIntelligence } from '@/lib/privacyIntelligence';
import {
  createPrivacyAppStateHandler,
  runPrivacyAuthentication,
} from '@/pages/PrivacyIntelligence';
import { logSystemFailure } from '@/lib/systemLog';
import { buildTrackingPrivacyConsoleData } from '@/lib/trackingPrivacyConsole';
import { Button } from '@/components/ui/button';

const toneClass = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100',
  warn: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100',
  error: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100',
  unknown: 'border-border bg-secondary/50 text-muted-foreground',
};

const formatTime = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'source unavailable';
};

export default function TrackingPrivacyConsole() {
  const settings = useLocalSettings();
  const [authed, setAuthed] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');

  const authenticate = useCallback(async () => {
    setAuthLoading(true);
    const verified = await runPrivacyAuthentication({
      setAuthed,
      setError: setAuthError,
    });
    setAuthLoading(false);
    return verified;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void authenticate().then(() => {
      if (cancelled) return;
      setAuthLoading(false);
    });
    return () => { cancelled = true; };
  }, [authenticate]);

  useEffect(() => {
    let listener;
    const handleAppStateChange = createPrivacyAppStateHandler({ authenticate, setAuthed });
    CapacitorApp.addListener('appStateChange', handleAppStateChange)
      .then((handle) => { listener = handle; })
      .catch(() => {});
    return () => listener?.remove?.();
  }, [authenticate]);

  const {
    data: intelligence = null,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ['tracking-privacy-console'],
    queryFn: () => loadPrivacyIntelligence(),
    enabled: authed,
    staleTime: 30 * 1000,
    refetchInterval: authed ? 2 * 60 * 1000 : false,
  });

  useEffect(() => {
    if (!error) return;
    logSystemFailure('tracking_privacy_console_load_failed', error, {});
  }, [error]);

  const consoleData = useMemo(
    () => buildTrackingPrivacyConsoleData({
      intelligence: intelligence || {},
      settings: settings || localSettings.get(),
    }),
    [intelligence, settings]
  );

  if (!authed || authLoading) {
    return (
      <div className="grid min-h-[calc(100dvh-8.5rem)] place-items-center p-4">
        <section className="w-full max-w-xl rounded-md border border-border bg-card p-6 text-center">
          <Lock className="mx-auto h-8 w-8 text-primary" />
          <h1 className="mt-3 font-grotesk text-xl font-bold">Unlock Trip Privacy</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Privacy-zone, masking, outbound road-data, and audit evidence require local device authentication.
          </p>
          {authError && <p className="mt-3 text-sm font-medium text-red-600 dark:text-red-300">{authError}</p>}
          <Button
            type="button"
            onClick={() => authenticate()}
            loading={authLoading}
            loadingText="Checking access..."
            className="mt-4"
          >
            <ShieldCheck className="h-4 w-4" />
            Unlock trip privacy
          </Button>
        </section>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100dvh-8.5rem)] min-w-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-background/80 px-3 py-2">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] font-bold text-muted-foreground">Advanced trip tracking</div>
            <h1 className="font-grotesk text-xl font-bold tracking-normal">Trip Privacy</h1>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              App-recorded privacy evidence for zones, masking, private trips, outbound road data, and local audit history.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ToolbarLink to="/privacy-intelligence" icon={ShieldCheck}>Privacy Intelligence</ToolbarLink>
            <ToolbarLink to="/settings#privacy-zones" icon={Database}>Zone settings</ToolbarLink>
            <Button
              type="button"
              onClick={() => refetch()}
              variant="outline"
              size="sm"
              loading={isFetching}
              loadingText="Refreshing privacy..."
            >
              <RefreshCw className="h-4 w-4" />
              Refresh privacy
            </Button>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        {error && (
          <div role="alert" className="m-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100">
            Privacy evidence source unavailable. {error?.message || 'Retry from the toolbar.'}
          </div>
        )}

        <section className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-6">
          {consoleData.topRows.map((row) => (
            <MetricStrip key={row.id} row={row} loading={isLoading} />
          ))}
        </section>

        <section className="grid min-w-0 gap-3 px-3 pb-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <Panel title="Privacy Zones" detail={`${consoleData.zoneRows.length} configured`}>
            <div className="overflow-x-auto">
              <table className="min-w-[48rem] w-full text-left text-xs">
                <thead className="border-b border-border text-[11px] uppercase tracking-normal text-muted-foreground">
                  <tr>
                    <Th>Zone</Th>
                    <Th>Type</Th>
                    <Th>Sensitivity</Th>
                    <Th>Status</Th>
                    <Th>Protected records</Th>
                    <Th>Last activity</Th>
                    <Th>Geometry</Th>
                  </tr>
                </thead>
                <tbody>
                  {consoleData.zoneRows.map((row) => (
                    <tr key={row.displayId} className="border-b border-border/70">
                      <Td>
                        <div className="font-semibold text-foreground">{row.label}</div>
                        <div className="text-muted-foreground">{row.displayId}</div>
                      </Td>
                      <Td>{row.type}</Td>
                      <Td>{row.sensitivity}</Td>
                      <Td><StatusChip tone={row.tone}>{row.status}</StatusChip></Td>
                      <Td>{row.protectedRecords} total / {row.protectedWeek} week</Td>
                      <Td>{row.lastActiveLabel}</Td>
                      <Td>{row.geometry}</Td>
                    </tr>
                  ))}
                  {!consoleData.zoneRows.length && <EmptyRow colSpan={7} text="No configured privacy zones." />}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Masking Status" detail="Route, event, export">
            <div className="grid gap-2">
              {consoleData.maskingRows.map((row) => (
                <EvidenceRow key={row.id} row={row} />
              ))}
            </div>
          </Panel>
        </section>

        <section className="grid min-w-0 gap-3 px-3 pb-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <Panel title="Outbound Road Data" detail="Consent and blocking status">
            <div className="overflow-x-auto">
              <table className="min-w-[54rem] w-full text-left text-xs">
                <thead className="border-b border-border text-[11px] uppercase tracking-normal text-muted-foreground">
                  <tr>
                    <Th>Source</Th>
                    <Th>Enabled</Th>
                    <Th>Status</Th>
                    <Th>Retained</Th>
                    <Th>Expected disclosure</Th>
                    <Th>Consent / block evidence</Th>
                  </tr>
                </thead>
                <tbody>
                  {consoleData.outboundRows.map((row) => (
                    <tr key={row.id} className="border-b border-border/70">
                      <Td>
                        <div className="font-semibold text-foreground">{row.label}</div>
                        <div className="text-muted-foreground">{row.purpose}</div>
                      </Td>
                      <Td>{row.enabled ? 'enabled' : 'blocked'}</Td>
                      <Td><StatusChip tone={row.tone}>{row.status}</StatusChip></Td>
                      <Td>{row.retainedCount} retained / {row.blockedCount} blocked</Td>
                      <Td>{row.expectedDisclosure}</Td>
                      <Td>
                        <div>{row.consentEvidence}</div>
                        <div className="mt-1 text-muted-foreground">{row.safeShape}</div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Privacy details" detail={`Updated ${formatTime(consoleData.generatedAt)}`}>
            <div className="grid gap-2">
              <EvidenceRow row={consoleData.nativeSync} />
              <div className="rounded-md border border-border bg-background/70 p-3 text-sm">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                  <EyeOff className="h-4 w-4" />
                  {consoleData.privateTripMode.label}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{consoleData.privateTripMode.detail}</p>
              </div>
              <div className="rounded-md border border-border bg-background/70 p-3 text-sm">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                  <Radio className="h-4 w-4" />
                  Privacy audit summaries
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <Info label="Today" value={consoleData.auditSummary.todayTotal} />
                  <Info label="Week" value={consoleData.auditSummary.weekTotal} />
                  <Info label="Latest" value={consoleData.auditSummary.latestAtLabel} />
                  <Info label="Chain" value={consoleData.auditSummary.chainValid ? 'recorded' : 'verification unavailable'} />
                </dl>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  This is app-recorded privacy evidence, not an external security audit.
                </p>
              </div>
            </div>
          </Panel>
        </section>

        <section className="px-3 pb-3">
          <Panel title="Audit Operations" detail={`${consoleData.auditRows.length} operation types`}>
            <div className="overflow-x-auto">
              <table className="min-w-[42rem] w-full text-left text-xs">
                <thead className="border-b border-border text-[11px] uppercase tracking-normal text-muted-foreground">
                  <tr>
                    <Th>Operation</Th>
                    <Th>Count</Th>
                    <Th>Status</Th>
                    <Th>Scope</Th>
                  </tr>
                </thead>
                <tbody>
                  {consoleData.auditRows.map((row) => (
                    <tr key={row.id} className="border-b border-border/70">
                      <Td><span className="font-semibold text-foreground">{row.operation}</span></Td>
                      <Td>{row.count}</Td>
                      <Td><StatusChip tone={row.tone}>{row.status}</StatusChip></Td>
                      <Td>{row.detail}</Td>
                    </tr>
                  ))}
                  {!consoleData.auditRows.length && <EmptyRow colSpan={4} text="No privacy audit operations recorded." />}
                </tbody>
              </table>
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

function MetricStrip({ row, loading }) {
  const Icon = row.tone === 'error' ? AlertTriangle : row.tone === 'ok' ? CheckCircle2 : ShieldCheck;
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{row.label}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 line-clamp-2 text-lg font-bold leading-tight">{loading ? 'loading' : row.value}</div>
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

function EvidenceRow({ row }) {
  return (
    <div className="rounded-md border border-border bg-background/70 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{row.label}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{row.detail}</p>
        </div>
        <StatusChip tone={row.tone}>{row.value || row.status}</StatusChip>
      </div>
    </div>
  );
}

function StatusChip({ tone = 'unknown', children }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-sm border px-2 py-1 text-[11px] font-semibold ${toneClass[tone] || toneClass.unknown}`}>
      {children}
    </span>
  );
}

function Info({ label, value }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-foreground">{value}</dd>
    </div>
  );
}

function Th({ children }) {
  return <th className="whitespace-nowrap px-3 py-2 font-semibold">{children}</th>;
}

function Td({ children }) {
  return <td className="align-top px-3 py-3">{children}</td>;
}

function EmptyRow({ colSpan, text }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-sm text-muted-foreground">{text}</td>
    </tr>
  );
}
