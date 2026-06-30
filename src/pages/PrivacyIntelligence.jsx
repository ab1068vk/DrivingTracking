import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Database,
  Download,
  EyeOff,
  Filter,
  History,
  Info,
  Lock,
  MapPin,
  Radio,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Upload,
  XCircle,
} from 'lucide-react';
import { authenticateDevice } from '@/lib/biometricGate';
import { loadPrivacyIntelligence } from '@/lib/privacyIntelligence';
import { clearTransmissionLog } from '@/lib/transmissionLog';
import { exportAuditCheckpoint, verifyCheckpoint } from '@/lib/hashChainLog';
import {
  downloadPrivacyReport as savePrivacyReportDownload,
  PRIVACY_REPORT_PASSWORD_MIN_LENGTH,
} from '@/lib/privacyReport';
import { dismissPrivacyZoneSuggestion } from '@/lib/privacyZoneSuggestions';
import { logSystemFailure } from '@/lib/systemLog';
import ProtectionGuidance from '@/components/privacy/ProtectionGuidance';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'transmissions', label: 'Transmissions', icon: Radio },
  { id: 'protections', label: 'Protections', icon: Shield },
  { id: 'zones', label: 'Zones', icon: MapPin },
  { id: 'audit', label: 'Audit Log', icon: History },
];

export const statusClass = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100',
  configured: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-100',
  warn: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100',
  unknown: 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-200',
  error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100',
  not_applicable: 'border-border bg-secondary/40 text-muted-foreground',
};

export const privacyLevelClass = {
  blocked: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-200',
  raw: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-100',
  protected: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100',
  unverified: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  none: 'bg-secondary text-muted-foreground',
};

export const actionToneClass = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100',
  warn: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100',
  unknown: 'border-slate-300 bg-slate-100 text-slate-800 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-100',
  error: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100',
};

export const STATUS_LABELS = {
  ok: 'Verified',
  configured: 'Configured',
  warn: 'Needs attention',
  unknown: 'Unverified',
  error: 'Failing',
  not_applicable: 'N/A',
};

const V2_BANNER_KEY = 'privacy_intel_v2_banner_dismissed';
const CHECKPOINT_REMINDER_MS = 30 * 24 * 60 * 60 * 1000;
const SHOW_DEVELOPER_ACTIONS = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEBUG_ROUTES === 'true';

const auditLabels = {
  TRANSMISSION: ['External request recorded', 'An outbound request was added to the privacy history.'],
  PRIVATE_GPS_PURGED: ['Private GPS purged', 'Saved GPS samples inside a privacy zone were removed.'],
  POINTS_SUPPRESSED: ['GPS samples suppressed', 'Private route samples were excluded from a public view or export.'],
  EVENTS_SUPPRESSED: ['Driving events suppressed', 'Driving events inside a privacy zone were excluded.'],
  ZONE_SAVED: ['Privacy zone saved', 'A privacy-zone configuration was created or updated.'],
  ZONE_DELETED: ['Privacy zone deleted', 'A privacy-zone configuration was removed.'],
  OSRM_SKIPPED: ['Route matching skipped', 'OSRM route matching did not send coordinates.'],
  OSRM_MATCHED: ['Route matching completed', 'Public route segments were sent to the configured OSRM service.'],
};

const formatTime = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Unknown time';
};

const formatRelativeTime = (value) => {
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} hr ago`;
  return `${Math.floor(ms / 86_400_000)} day${Math.floor(ms / 86_400_000) === 1 ? '' : 's'} ago`;
};

const formatBytes = (value) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const shortHash = (value) => String(value || '').slice(0, 16) || 'none';
const titleCase = (value) => String(value || 'Privacy event')
  .toLowerCase()
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const scoreTrendText = (trend = {}) => {
  const weekly = Number(trend.changeFromLastWeek);
  const monthly = Number(trend.changeFromLastMonth);
  const hasWeekly = trend.changeFromLastWeek != null && Number.isFinite(weekly);
  const hasMonthly = trend.changeFromLastMonth != null && Number.isFinite(monthly);
  const change = hasWeekly ? weekly : hasMonthly ? monthly : null;
  if (change == null) return null;
  const period = hasWeekly ? 'this week' : 'this month';
  if (change === 0) return `No change ${period} · see Protections`;
  return `${change > 0 ? 'Up' : 'Down'} ${Math.abs(change)} pts ${period} · see Protections`;
};

const formatExpiryCountdown = (value) => {
  const remainingMs = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(remainingMs)) return null;
  if (remainingMs <= 0) return 'Expiry pending cleanup';
  const hours = Math.ceil(remainingMs / 3_600_000);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} remaining`;
  const days = Math.ceil(remainingMs / 86_400_000);
  return `${days} day${days === 1 ? '' : 's'} remaining`;
};

const auditMeta = (entry = {}) => {
  const [title, description] = auditLabels[entry.op] || [titleCase(entry.op), 'A privacy-related operation was recorded.'];
  return { title, description };
};

/**
 * @param {{
 *   authenticate?: (reason?: string) => Promise<any>,
 *   setAuthed?: (authed: boolean) => void,
 *   setError?: (error: string) => void,
 *   onRejected?: () => void
 * }} options
 */
export async function runPrivacyAuthentication({
  authenticate = authenticateDevice,
  setAuthed,
  setError,
  onRejected,
} = {}) {
  try {
    const result = await authenticate('Access Privacy Intelligence');
    if (result?.verified) {
      setAuthed?.(true);
      setError?.('');
      return true;
    }
    onRejected?.();
  } catch (authError) {
    setError?.(authError?.message || 'Device authentication is unavailable.');
  }
  return false;
}

/**
 * @param {{
 *   authenticate?: () => any,
 *   setAuthed?: (authed: boolean) => void,
 *   now?: () => number
 * }} options
 */
export function createPrivacyAppStateHandler({
  authenticate,
  setAuthed,
  now = Date.now,
} = {}) {
  let backgroundedAt = 0;
  return ({ isActive }) => {
    if (!isActive) {
      backgroundedAt = now();
      return;
    }
    if (backgroundedAt && now() - backgroundedAt >= 5 * 60 * 1000) {
      setAuthed?.(false);
      void authenticate?.();
    }
    backgroundedAt = 0;
  };
}

/**
 * @param {{
 *   authed: boolean,
 *   loading: boolean,
 *   error: string,
 *   hasData: boolean,
 *   onRetry: () => any,
 *   children?: import('react').ReactNode
 * }} props
 */
export function PrivacyAuthenticationGate({
  authed,
  loading,
  error,
  hasData,
  onRetry,
  children,
}) {
  if (error && !hasData) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <div className="text-sm font-medium text-red-600 dark:text-red-300">{error}</div>
        <button type="button" onClick={onRetry} className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Retry</button>
      </div>
    );
  }
  if (!authed || loading) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
        <Lock className="h-8 w-8 text-primary" />
        <div className="text-sm font-medium text-muted-foreground">Loading privacy intelligence...</div>
      </div>
    );
  }
  return children;
}

export default function PrivacyIntelligence() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [authed, setAuthed] = useState(false);

  const authenticate = useCallback(async () => {
    return runPrivacyAuthentication({
      setAuthed,
      setError,
      onRejected: () => window.history.back(),
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void authenticate().then((verified) => {
      if (cancelled || verified) return;
      setLoading(false);
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

  const loadData = useCallback(async ({ quiet = false } = {}) => {
    if (!authed) return;
    if (!quiet) setRefreshing(true);
    try {
      setData(await loadPrivacyIntelligence());
      setError('');
    } catch (loadError) {
      logSystemFailure('privacy_intelligence_load_failed', loadError, {});
      setError(loadError?.message || 'Privacy data could not be loaded.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [authed]);

  useEffect(() => {
    if (!authed) return undefined;
    loadData({ quiet: true });
    const interval = setInterval(() => loadData({ quiet: true }), 30_000);
    return () => clearInterval(interval);
  }, [authed, loadData]);

  const activeTab = useMemo(() => TABS.find((item) => item.id === tab) || TABS[0], [tab]);

  if (!authed || loading || (error && !data)) {
    return (
      <PrivacyAuthenticationGate
        authed={authed}
        loading={loading}
        error={error}
        hasData={Boolean(data)}
        onRetry={() => (authed ? loadData() : authenticate())}
      />
    );
  }

  const ActiveIcon = activeTab.icon;
  const tabCounts = {
    transmissions: data?.transmissions?.entries?.length || 0,
    protections: (data?.protectionSummary?.warnings || 0) +
      (data?.protectionSummary?.unknown || 0) +
      (data?.protectionSummary?.errors || 0),
    zones: data?.zoneSummary?.zoneCount || 0,
    audit: data?.chain?.length || 0,
  };

  return (
    <div className="space-y-5 pb-6">
      <header className="rounded-3xl border border-border bg-gradient-to-br from-card via-card to-primary/5 p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <h1 className="font-grotesk text-2xl font-bold">Privacy Intelligence</h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Review local privacy activity, protection checks, and recorded outbound data. This shows what the app recorded leaving the device.</p>
              <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" />
                Updated {data?.generatedAt ? formatRelativeTime(data.generatedAt) : 'recently'}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => navigate('/settings')} className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold shadow-sm">
              <Settings className="h-3.5 w-3.5" /> Settings
            </button>
            <button type="button" onClick={() => loadData()} disabled={refreshing} className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-sm disabled:opacity-50">
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
        </div>
      </header>

      {error && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">{error}</div>}

      <nav aria-label="Privacy Intelligence sections" className="overflow-x-auto rounded-2xl border border-border bg-card p-1 shadow-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex min-w-max gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition-colors ${tab === id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}>
              <Icon className="h-3.5 w-3.5" />
              {label}
              {id !== 'overview' && tabCounts[id] > 0 && <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${tab === id ? 'bg-primary-foreground/20' : 'bg-secondary'}`}>{tabCounts[id]}</span>}
            </button>
          ))}
        </div>
      </nav>

      <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground"><ActiveIcon className="h-4 w-4" />{activeTab.label}</div>

      {tab === 'overview' && <OverviewTab data={data} onOpenTab={setTab} onOpenSettings={() => navigate('/settings')} />}
      {tab === 'transmissions' && <TransmissionsTab data={data} onClear={async () => { await clearTransmissionLog(); await loadData(); }} />}
      {tab === 'protections' && <ProtectionsTab data={data} onOpenSettings={() => navigate('/settings')} />}
      {tab === 'zones' && (
        <ZonesTab
          data={data}
          onAcceptSuggestion={(suggestion) => navigate('/settings?section=settings-privacy-data', {
            state: { privacyZoneSuggestion: suggestion, previewPrivacyZoneSuggestion: true },
          })}
          onDismissSuggestion={async (suggestion) => {
            await dismissPrivacyZoneSuggestion(suggestion);
            await loadData({ quiet: true });
          }}
        />
      )}
      {tab === 'audit' && <AuditTab data={data} />}
    </div>
  );
}

export function OverviewTab({ data, onOpenTab, onOpenSettings }) {
  const score = data?.score || {};
  const trendText = scoreTrendText(data?.scoreTrend);
  const zoneSummary = data?.zoneSummary || {};
  const drivingReadout = data?.drivingReadout || {};
  const transmissions = data?.transmissions || {};
  const recommendations = data?.recommendations || [];
  const actionPlan = data?.actionPlan || {};
  const evidenceSnapshot = data?.evidenceSnapshot || {};
  const protectionFindings = data?.protectionSummary?.findings || [];
  const postureRegressionFindings = data?.protectionSummary?.postureRegressionFindings || [];
  const compoundRiskFindings = score.compoundRiskFindings || [];
  const [showThreatModel, setShowThreatModel] = useState(false);
  const [reportError, setReportError] = useState('');
  const [reportSuccess, setReportSuccess] = useState('');
  const [reportPassword, setReportPassword] = useState('');
  const [reportPasswordConfirm, setReportPasswordConfirm] = useState('');
  const [exportingReport, setExportingReport] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(() => (
    globalThis.localStorage?.getItem(V2_BANNER_KEY) === 'true'
  ));
  const downloadPrivacyReport = useCallback(async () => {
    if (reportPassword.length < PRIVACY_REPORT_PASSWORD_MIN_LENGTH) {
      setReportError(`Choose a report password with at least ${PRIVACY_REPORT_PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    if (reportPassword !== reportPasswordConfirm) {
      setReportError('Report passwords do not match.');
      return;
    }
    setExportingReport(true);
    setReportError('');
    setReportSuccess('');
    try {
      const result = await savePrivacyReportDownload(data, reportPassword);
      setReportPassword('');
      setReportPasswordConfirm('');
      setReportSuccess(result?.native
        ? `Encrypted report saved to Downloads as ${result.filename}.`
        : `Encrypted report downloaded as ${result.filename}.`);
    } catch (reportExportError) {
      logSystemFailure('privacy_report_export_failed', reportExportError, {
        has_data: Boolean(data),
        encrypted: true,
      });
      setReportError(reportExportError?.message || 'Privacy Report could not be exported.');
    } finally {
      setExportingReport(false);
    }
  }, [data, reportPassword, reportPasswordConfirm]);
  return (
    <div className="min-w-0 space-y-4 overflow-hidden">
      {!bannerDismissed && (
        <section className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sky-950 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-100">
          <div className="font-semibold">Privacy Intelligence now checks protection status from local evidence</div>
          <p className="mt-1 text-sm opacity-90">Your score may look different because checks that cannot be confirmed in this session no longer receive full credit.</p>
          <button
            type="button"
            onClick={() => {
              globalThis.localStorage?.setItem(V2_BANNER_KEY, 'true');
              setBannerDismissed(true);
            }}
            className="mt-3 rounded-lg bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white"
          >
            Got it
          </button>
        </section>
      )}
      {(score.summary?.unknown || 0) > 0 && (
        <button type="button" onClick={() => onOpenTab('protections')} className="flex w-full items-center gap-2 rounded-xl border border-slate-300 bg-slate-100 p-3 text-left text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-100">
          <Info className="h-4 w-4 shrink-0" />
          {score.summary.unknown} protection{score.summary.unknown === 1 ? '' : 's'} could not be verified this session.
        </button>
      )}
      {(score.summary?.error || 0) > 0 && (
        <button type="button" onClick={() => onOpenTab('protections')} className="flex w-full items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-left text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {score.summary.error} protection{score.summary.error === 1 ? '' : 's'} failed verification.
        </button>
      )}
      {postureRegressionFindings.map((finding) => (
        <button key={finding.id} type="button" onClick={() => onOpenTab(finding.targetTab || 'protections')} className="flex w-full items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-left text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span><span className="font-semibold">{finding.title}</span><span className="mt-1 block text-xs opacity-85">{finding.detail}</span></span>
        </button>
      ))}
      {protectionFindings.map((finding) => (
        <button key={finding.id} type="button" onClick={() => onOpenTab(finding.targetTab || 'transmissions')} className="flex w-full items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-left text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
          <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
          <span><span className="font-semibold">{finding.title}</span><span className="mt-1 block text-xs opacity-85">{finding.detail} {finding.userAction}</span></span>
        </button>
      ))}
      <section className={`rounded-2xl border p-4 shadow-sm ${actionToneClass[actionPlan.tone] || actionToneClass.unknown}`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-xs font-bold uppercase tracking-wide opacity-70">What to do next</div>
            <h2 className="mt-1 break-words text-lg font-semibold">{actionPlan.headline || 'Privacy review unavailable'}</h2>
            <p className="mt-1 break-words text-sm opacity-85">{actionPlan.claim || 'This dashboard reports local evidence only.'}</p>
            {actionPlan.nextStep && <p className="mt-2 break-words text-sm font-semibold opacity-95">Next: {actionPlan.nextStep}</p>}
          </div>
          {actionPlan.primaryAction?.targetTab && actionPlan.primaryAction.targetTab !== 'overview' && (
            <button
              type="button"
              onClick={() => onOpenTab(actionPlan.primaryAction.targetTab)}
              className="shrink-0 rounded-xl bg-background/70 px-3 py-2 text-xs font-bold shadow-sm"
            >
              {actionPlan.primaryAction.action || 'Review'}
            </button>
          )}
        </div>
        {(actionPlan.issues || []).length > 0 && (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {actionPlan.issues.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => item.targetTab && item.targetTab !== 'overview' ? onOpenTab(item.targetTab) : undefined}
                className="min-w-0 rounded-xl border border-current/20 bg-background/55 p-3 text-left"
              >
                <div className="break-words text-sm font-semibold">{item.title}</div>
                <div className="mt-1 break-words text-xs opacity-80">{item.detail}</div>
              </button>
            ))}
          </div>
        )}
      </section>
      {(evidenceSnapshot.items || []).length > 0 && (
        <section className="min-w-0 rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Evidence that matters</div>
            <h2 className="break-words text-lg font-semibold">{evidenceSnapshot.primaryTakeaway || 'Review the current privacy evidence.'}</h2>
          </div>
          <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-3">
            {evidenceSnapshot.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => item.targetTab && onOpenTab(item.targetTab)}
                className={`min-w-0 rounded-xl border p-3 text-left shadow-sm transition-colors hover:bg-secondary/40 ${actionToneClass[item.tone] || actionToneClass.unknown}`}
              >
                <div className="flex min-w-0 items-center gap-2 text-xs font-bold uppercase tracking-wide opacity-70">
                  {item.tone === 'error' ? <AlertTriangle className="h-4 w-4 shrink-0" /> : item.tone === 'ok' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <Info className="h-4 w-4 shrink-0" />}
                  <span className="min-w-0 break-words">{item.label}</span>
                </div>
                <div className="mt-2 break-words text-sm font-semibold">{item.headline}</div>
                <div className="mt-1 break-words text-xs opacity-80">{item.detail}</div>
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section className={`min-w-0 rounded-3xl border p-5 shadow-sm ${statusClass[score.tone] || statusClass.warn}`}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-bold uppercase tracking-wide opacity-80">Local evidence posture</span>
            <span className="rounded-full bg-background/60 px-2 py-1 text-xs font-bold">{score.label || 'Checking'}</span>
          </div>
          <div className="mt-5 flex items-end gap-2"><span className="font-grotesk text-6xl font-bold leading-none">{score.overall ?? 0}</span><span className="pb-1 text-sm font-semibold opacity-70">/ 100</span></div>
          {trendText && (
            <button type="button" onClick={() => onOpenTab('protections')} className="mt-2 text-left text-xs font-semibold underline-offset-2 hover:underline">
              {trendText}
            </button>
          )}
          <p className="mt-3 break-words text-sm opacity-90">{score.detail}</p>
          {score.capReason && <p className="mt-2 break-words text-xs font-medium opacity-85">{score.capReason}</p>}
          {compoundRiskFindings.map((finding) => (
            <p key={finding.id} className="mt-2 break-words text-xs font-semibold opacity-90">{finding.detail}</p>
          ))}
          <p className="mt-2 break-words text-xs opacity-75">Local evidence only. Unknown checks are not evidence of safety.</p>
          <form
            className="mt-4 space-y-2 rounded-2xl bg-background/60 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              downloadPrivacyReport();
            }}
          >
            <div>
              <div className="text-xs font-semibold">Password-protected report</div>
              <p className="mt-1 text-[11px] opacity-75">Exports an encrypted summary with a local integrity signature. Raw coordinates, addresses, tokens, and privacy-zone geometry are excluded.</p>
            </div>
            <label className="block text-[11px] font-semibold">
              Report password
              <input
                type="password"
                value={reportPassword}
                onChange={(event) => setReportPassword(event.target.value)}
                autoComplete="new-password"
                className="mt-1 h-9 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                minLength={PRIVACY_REPORT_PASSWORD_MIN_LENGTH}
              />
            </label>
            <label className="block text-[11px] font-semibold">
              Confirm password
              <input
                type="password"
                value={reportPasswordConfirm}
                onChange={(event) => setReportPasswordConfirm(event.target.value)}
                autoComplete="new-password"
                className="mt-1 h-9 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                minLength={PRIVACY_REPORT_PASSWORD_MIN_LENGTH}
              />
            </label>
            <button
              type="submit"
              disabled={exportingReport}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {exportingReport ? 'Encrypting report...' : 'Export encrypted report'}
            </button>
          </form>
          {reportError && <p className="mt-2 text-xs font-medium text-red-700 dark:text-red-200">{reportError}</p>}
          {reportSuccess && <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-200">{reportSuccess}</p>}
        </section>

        <section className="grid min-w-0 gap-3 sm:grid-cols-2">
          {(score.layers || []).map((layer) => (
            <div key={layer.id} className="min-w-0 rounded-2xl border border-border bg-card p-4 shadow-sm">
              <div className="flex min-w-0 items-center justify-between gap-3"><div className="min-w-0 break-words font-semibold">{layer.label}</div><div className="shrink-0 font-grotesk text-2xl font-bold" style={{ color: layer.color }}>{layer.score ?? 'N/A'}</div></div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full" style={{ width: `${layer.score ?? 0}%`, background: layer.color }} /></div>
            </div>
          ))}
        </section>
      </div>
      <div className="text-center text-xs text-muted-foreground">
        {score.summary?.ok || 0} verified · {score.summary?.configured || 0} configured · {score.summary?.warn || 0} need attention · {score.summary?.unknown || 0} unverified · {score.summary?.error || 0} failing
        {(score.summary?.not_applicable || 0) > 0 ? ` · ${score.summary.not_applicable} not applicable` : ''}
      </div>

      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={EyeOff} label="Protected today" value={(zoneSummary.pointsToday || 0) + (zoneSummary.eventsToday || 0)} detail={`${zoneSummary.pointsToday || 0} GPS samples, ${zoneSummary.eventsToday || 0} events`} />
        <SummaryCard icon={MapPin} label="Recent trip coverage" value={drivingReadout.recentProtectionRate == null ? 'N/A' : `${drivingReadout.recentProtectionRate}%`} detail={`${drivingReadout.recentProtectedTripCount || 0}/${drivingReadout.recentTripCount || 0} recent trips touched a zone`} tone={drivingReadout.recentTripCount && !drivingReadout.recentProtectedTripCount && zoneSummary.zoneCount ? 'warn' : 'default'} onClick={() => onOpenTab('zones')} />
        <SummaryCard icon={Radio} label="Outbound confidence" value={`${transmissions.outboundReadout?.confidence ?? 0}`} detail={`${transmissions.weekTotal || 0} requests this week · ${transmissions.totalRawCoords || 0} raw · ${transmissions.claimedButUnverifiedCount || 0} unverified`} tone={transmissions.outboundReadout?.tone === 'error' ? 'error' : transmissions.outboundReadout?.tone === 'warn' ? 'warn' : 'default'} onClick={() => onOpenTab('transmissions')} />
        <SummaryCard icon={ShieldCheck} label="Protections active" value={data?.protectionSummary?.active || 0} detail={`${data?.protectionSummary?.warnings || 0} warnings, ${data?.protectionSummary?.errors || 0} errors`} onClick={() => onOpenTab('protections')} />
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <section className="min-w-0 rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><h2 className="font-semibold">Driving privacy readout</h2><p className="mt-1 break-words text-xs text-muted-foreground">Derived from saved trips, redacted records, and configured zone guards.</p></div><button type="button" onClick={() => onOpenTab('zones')} className="shrink-0 text-xs font-semibold text-primary">View zones</button></div>
          <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
            <MiniMetric label="Trips analyzed" value={drivingReadout.tripCount || 0} />
            <MiniMetric label="Trips with private endpoints" value={drivingReadout.privateEndpointTripCount || 0} />
            <MiniMetric label="GPS samples this week" value={zoneSummary.pointsWeek || 0} />
            <MiniMetric label="Events this week" value={zoneSummary.eventsWeek || 0} />
            <MiniMetric label="Active zones" value={`${zoneSummary.activeZoneCount || 0}/${zoneSummary.zoneCount || 0}`} />
            <MiniMetric label="Latest protection" value={zoneSummary.latestAt ? formatRelativeTime(zoneSummary.latestAt) : 'None yet'} />
          </div>
          {(drivingReadout.recommendedChecks || []).length > 0 && (
            <div className="mt-3 space-y-2">
              {drivingReadout.recommendedChecks.slice(0, 3).map((item) => (
                <button key={item} type="button" onClick={() => onOpenTab('zones')} className="w-full rounded-xl border border-amber-200 bg-amber-50 p-3 text-left text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                  {item}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="min-w-0 rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><h2 className="font-semibold">Recommended review</h2><p className="mt-1 break-words text-xs text-muted-foreground">Highest-priority items from the current protection checks.</p></div><button type="button" onClick={onOpenSettings} className="shrink-0 text-xs font-semibold text-primary">Open settings</button></div>
          <div className="mt-3 space-y-2">
            {recommendations.length === 0 ? <div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100">No protection issues need attention.</div> : recommendations.map((item) => (
              <button key={item.id} type="button" onClick={onOpenSettings} className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-secondary/60">
                {item.status === 'error' ? <XCircle className="h-4 w-4 shrink-0 text-red-500" /> : <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />}
                <span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold">{item.label}</span><span className="block break-words text-xs text-muted-foreground">{item.detail}</span></span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        </section>
      </div>
      <SummaryCard icon={History} label="Audit integrity" value={data?.chainResult?.valid ? 'Consistent' : 'Needs review'} detail={data?.chainResult?.valid ? ((data?.chain?.length || 0) > 0 && data?.auditSummary?.signatureCoverage < data.chain.length ? `${data.auditSummary.signatureCoverage} entries since the last hardware-signed checkpoint` : 'Hardware signature unavailable') : `${data?.chain?.length || 0} chained entries`} tone={data?.chainResult?.valid ? 'ok' : 'error'} onClick={() => onOpenTab('audit')} />
      <button type="button" onClick={() => setShowThreatModel(true)} className="w-full text-center text-xs text-muted-foreground underline underline-offset-4">
        Local privacy activity and protection checks - not an external security audit.
      </button>
      <Dialog open={showThreatModel} onOpenChange={setShowThreatModel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>What this dashboard does and does not show</DialogTitle>
            <DialogDescription>These checks provide local evidence, not a promise against a fully compromised device or application.</DialogDescription>
          </DialogHeader>
          <ThreatList title="Can help with" items={[
            'Accidental privacy regressions',
            'Awareness of external requests',
            'Visibility into privacy-zone suppression',
            'Detecting simple audit-log corruption',
            'Identifying missing user-side protections',
          ]} />
          <ThreatList title="Does not fully protect against" items={[
            'A compromised app bundle or malicious same-origin JavaScript',
            'A rooted device controlled by an attacker',
            'An attacker who rewrites both the local chain and its local anchor',
            'Network observation by a powerful adversary',
            'A malicious or compromised external data provider',
          ]} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ThreatList({ title, items }) {
  return <section><h3 className="text-sm font-semibold">{title}</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{items.map((item) => <li key={item}>{item}</li>)}</ul></section>;
}

function SummaryCard({ icon: Icon, label, value, detail, tone = 'default', onClick = null }) {
  const Component = onClick ? 'button' : 'div';
  const toneClass = tone === 'error'
    ? statusClass.error
    : tone === 'warn'
      ? statusClass.warn
      : tone === 'ok'
        ? statusClass.ok
        : 'border-border bg-card';
  return (
    <Component type={onClick ? 'button' : undefined} onClick={onClick} className={`min-w-0 rounded-2xl border p-4 text-left shadow-sm ${toneClass} ${onClick ? 'transition-colors hover:bg-secondary/40' : ''}`}>
      <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-muted-foreground"><Icon className="h-4 w-4 shrink-0 text-primary" /><span className="min-w-0 break-words">{label}</span></div>
      <div className="mt-2 break-words font-grotesk text-2xl font-bold">{value}</div>
      <div className="mt-1 break-words text-xs text-muted-foreground">{detail}</div>
    </Component>
  );
}

function MiniMetric({ label, value }) {
  return <div className="min-w-0 rounded-xl bg-secondary/50 p-3"><div className="break-words font-grotesk text-xl font-bold">{value}</div><div className="mt-1 break-words text-[11px] text-muted-foreground">{label}</div></div>;
}

export function TransmissionsTab({ data, onClear }) {
  const entries = data?.transmissions?.entries || [];
  const outboundReadout = data?.transmissions?.outboundReadout || {};
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [service, setService] = useState('all');
  const services = data?.transmissions?.services || [];
  const rawWithoutConsent = data?.transmissions?.rawWithoutConsentCount || 0;
  const rawWithConsent = data?.transmissions?.rawWithConsentCount || 0;
  const unverifiedClaims = data?.transmissions?.claimedButUnverifiedCount || 0;
  const filtered = useMemo(() => entries.filter((entry) => {
    if (status !== 'all' && entry.privacyLevel !== status && entry.status !== status) return false;
    if (service !== 'all' && entry.service !== service) return false;
    if (!query.trim()) return true;
    const haystack = `${entry.type} ${entry.service} ${entry.sentCoords || ''} ${(entry.protections || []).join(' ')} ${entry.tripId || ''}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }), [entries, query, service, status]);

  return (
    <div className="space-y-4">
      <section className={`rounded-2xl border p-4 shadow-sm ${actionToneClass[outboundReadout.tone] || actionToneClass.unknown}`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="text-xs font-bold uppercase tracking-wide opacity-70">Outbound privacy confidence</div>
            <h2 className="mt-1 break-words text-lg font-semibold">{outboundReadout.headline || 'Outbound privacy evidence unavailable'}</h2>
            <p className="mt-1 break-words text-sm opacity-85">This judges retained local records for what left the app. It is stronger than a count, but still depends on app-recorded metadata rather than packet capture.</p>
          </div>
          <div className="shrink-0 rounded-xl bg-background/70 px-4 py-3 text-center shadow-sm">
            <div className="font-grotesk text-3xl font-bold">{outboundReadout.confidence ?? 0}</div>
            <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">confidence</div>
          </div>
        </div>
        {(outboundReadout.findings || []).length > 0 && (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {outboundReadout.findings.map((item) => (
              <div key={item.id} className="rounded-xl border border-current/20 bg-background/55 p-3">
                <div className="text-sm font-semibold">{item.title}</div>
                <div className="mt-1 text-xs opacity-80">{item.detail}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={ShieldCheck} label="Verified transforms" value={data?.transmissions?.protectedTotal || 0} detail={`${data?.transmissions?.claimedButUnverifiedCount || 0} unverified claim${data?.transmissions?.claimedButUnverifiedCount === 1 ? '' : 's'}`} />
        <SummaryCard icon={Ban} label="Blocked requests" value={data?.transmissions?.blockedTotal || 0} detail="Nothing was sent" />
        <SummaryCard icon={AlertTriangle} label="Raw-coordinate sends" value={data?.transmissions?.totalRawCoords || 0} detail={`${rawWithConsent} consented, ${rawWithoutConsent} missing consent evidence`} tone={rawWithoutConsent ? 'error' : data?.transmissions?.totalRawCoords ? 'warn' : 'default'} />
        <SummaryCard icon={Database} label="Outbound metadata" value={formatBytes(data?.transmissions?.totalBytesOut)} detail="Retained locally for 30 days" />
      </div>

      {(outboundReadout.serviceSummaries || []).length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="flex flex-col gap-1">
            <h2 className="font-semibold">What can leave the app</h2>
            <p className="text-xs text-muted-foreground">Service policies are compared with retained transmission records so missing evidence and risky raw sends stand out.</p>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {outboundReadout.serviceSummaries.map((service) => (
              <ServicePrivacyCard key={service.service} service={service} />
            ))}
          </div>
        </section>
      )}

      {(rawWithoutConsent || rawWithConsent || unverifiedClaims) > 0 && (
        <div className={`rounded-2xl border p-4 text-sm shadow-sm ${rawWithoutConsent ? statusClass.error : statusClass.warn}`}>
          <div className="font-semibold">Transmission review needed</div>
          <p className="mt-1 opacity-85">
            {rawWithoutConsent
              ? `${rawWithoutConsent} raw-coordinate send${rawWithoutConsent === 1 ? '' : 's'} lacked explicit-consent evidence.`
              : rawWithConsent
                ? `${rawWithConsent} raw-coordinate send${rawWithConsent === 1 ? '' : 's'} used consent metadata. Confirm the endpoint is still trusted.`
                : `${unverifiedClaims} protected-request claim${unverifiedClaims === 1 ? '' : 's'} need stronger evidence.`}
          </p>
        </div>
      )}

      <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div><h2 className="font-semibold">Outbound data records</h2><p className="mt-1 text-xs text-muted-foreground">This log records what category of location data the app reported sending. It does not store full payloads or responses.</p></div>
          <button type="button" onClick={onClear} disabled={!entries.length} className="rounded-xl border border-border px-3 py-2 text-xs font-semibold text-muted-foreground disabled:opacity-50">Clear retained records</button>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-[1fr_180px_180px]">
          <label className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search service, trip, or protection" className="h-9 w-full rounded-xl border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-1 focus:ring-ring" /></label>
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-9 rounded-xl border border-input bg-background px-3 text-sm"><option value="all">All privacy levels</option><option value="protected">Protected</option><option value="blocked">Blocked</option><option value="raw">Raw coordinates</option><option value="warning">Warnings</option></select>
          <select value={service} onChange={(event) => setService(event.target.value)} className="h-9 rounded-xl border border-input bg-background px-3 text-sm"><option value="all">All services</option>{services.map((item) => <option key={item.service} value={item.service}>{item.service} ({item.count})</option>)}</select>
        </div>
      </section>

      <div className="text-xs text-muted-foreground">Showing {filtered.length} of {entries.length} retained record{entries.length === 1 ? '' : 's'}</div>
      {filtered.length === 0 ? <EmptyState text={entries.length ? 'No transmissions match these filters.' : 'No outbound data records yet.'} /> : filtered.map((entry) => <TransmissionCard key={entry.id} entry={entry} />)}
    </div>
  );
}

function ServicePrivacyCard({ service }) {
  const toneClass = actionToneClass[service.tone] || actionToneClass.unknown;
  const disclosureText = service.worstDisclosure === 'none'
    ? service.expectedDisclosure || 'none'
    : service.worstDisclosure;
  return (
    <article className={`rounded-2xl border p-4 shadow-sm ${toneClass}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="break-words font-semibold">{service.label}</div>
          <div className="mt-1 break-words text-xs opacity-80">{service.usefulFor}</div>
        </div>
        <span className="rounded-full bg-background/70 px-2 py-1 text-[11px] font-bold uppercase tracking-wide">{service.verdict}</span>
      </div>
      <div className="mt-3 rounded-xl bg-background/55 p-3 text-xs">
        <div><span className="font-semibold">Expected safe shape:</span> {service.safeShape}</div>
        <div className="mt-1"><span className="font-semibold">Retained evidence:</span> {service.retainedCount} record{service.retainedCount === 1 ? '' : 's'} · worst shape {disclosureText}</div>
        <div className="mt-1"><span className="font-semibold">Latest:</span> {service.latestAt ? formatTime(service.latestAt) : service.enabled ? 'No retained record yet' : 'Disabled or manual only'}</div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4">
        <ZoneMetric label="Protected" value={service.protectedCount} />
        <ZoneMetric label="Raw" value={service.rawCount} />
        <ZoneMetric label="Blocked" value={service.blockedCount} />
        <ZoneMetric label="Bytes out" value={formatBytes(service.bytesOut)} />
      </div>
    </article>
  );
}

function TransmissionCard({ entry }) {
  const privacyLabel = entry.displayClassification?.label || 'Unverified';
  return (
    <article className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="font-semibold">{entry.type}</div><div className="mt-1 text-xs text-muted-foreground">{entry.service} - {formatTime(entry.timestamp)}</div></div>
        <span className={`rounded-full px-2 py-1 text-xs font-semibold ${privacyLevelClass[entry.privacyLevel] || privacyLevelClass.unverified}`}>{privacyLabel}</span>
      </div>
      <div className="mt-3 grid gap-2 rounded-xl bg-secondary/40 p-3 text-xs sm:grid-cols-3">
        <div><span className="font-semibold">Data shape:</span> {entry.sentCoords || 'Nothing'}</div>
        <div><span className="font-semibold">Request size:</span> {formatBytes(entry.bytesOut)}</div>
        <div><span className="font-semibold">Log status:</span> {STATUS_LABELS[entry.status] || titleCase(entry.status)}</div>
        <div><span className="font-semibold">Trip:</span> {entry.tripId || 'Not linked'}</div>
      </div>
      {(entry.privacyTransformSource || (entry.privacyVerificationEvidence || []).length > 0) && (
        <div className="mt-3 rounded-xl border border-border bg-background/70 p-3 text-xs">
          <div><span className="font-semibold">Verification source:</span> {entry.privacyTransformSource || 'Not recorded'}</div>
          {(entry.privacyVerificationEvidence || []).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {entry.privacyVerificationEvidence.map((item) => <span key={item} className="rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">{item}</span>)}
            </div>
          )}
        </div>
      )}
      {(entry.privacyVerificationWarnings || []).length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="font-semibold">Review warning</div>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {entry.privacyVerificationWarnings.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">{(entry.protections || []).length ? entry.protections.map((item) => <span key={item} className="rounded-full bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary">{item}</span>) : <span className="text-xs text-muted-foreground">No additional protection metadata recorded.</span>}</div>
    </article>
  );
}

export function ProtectionsTab({ data, onOpenSettings }) {
  const protections = data?.protections || [];
  const [filter, setFilter] = useState('all');
  const [expandedControlId, setExpandedControlId] = useState(null);
  const visible = protections.filter((item) => filter === 'all' || item.status === filter || item.category === filter);
  const categories = [...new Set(protections.map((item) => item.category))];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={CheckCircle2} label="Verified" value={data?.protectionSummary?.active || 0} detail={`${data?.protectionSummary?.configured || 0} configured`} />
        <SummaryCard icon={Info} label="Unverified" value={data?.protectionSummary?.unknown || 0} detail={`${data?.protectionSummary?.notApplicable || 0} not applicable`} />
        <SummaryCard icon={AlertTriangle} label="Warnings" value={data?.protectionSummary?.warnings || 0} detail="Degraded checks" />
        <SummaryCard icon={XCircle} label="Failing" value={data?.protectionSummary?.errors || 0} detail="Protections needing attention" tone={data?.protectionSummary?.errors ? 'error' : 'default'} />
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-3 shadow-sm"><Filter className="h-4 w-4 text-muted-foreground" />{['all', 'error', 'warn', 'unknown', 'configured', 'ok', 'not_applicable', ...categories].map((option) => <button key={option} type="button" onClick={() => setFilter(option)} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${filter === option ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>{option === 'all' ? 'All checks' : STATUS_LABELS[option] || titleCase(option)}</button>)}</div>
      <div className="grid gap-3 md:grid-cols-2">
        {visible.map((item) => (
          <article key={item.id} className={`rounded-2xl border p-4 shadow-sm ${statusClass[item.status] || statusClass.warn}`}>
            <div className="flex flex-wrap items-start gap-3">
              {item.id === 'request_obfuscation' ? null : item.status === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : item.status === 'error' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> : item.status === 'unknown' || item.status === 'not_applicable' ? <Info className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
              {item.id === 'request_obfuscation' && (
                <button
                  type="button"
                  aria-label="About Request Timing Obfuscation"
                  title="First-party decoy traffic mode creates additional real Open-Meteo requests, so Transmissions may show more weather requests than trips."
                  className="mt-0.5 shrink-0 rounded-full opacity-70 hover:opacity-100"
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              )}
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{item.label}</span><span className="rounded-full bg-background/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">{item.category}</span><span className="rounded bg-background/60 px-2 py-0.5 text-[10px] font-bold uppercase">{STATUS_LABELS[item.status] || 'Unknown'}</span></div><div className="mt-1 text-xs opacity-90">{item.evidence || item.detail}</div>{item.rotation && <div className="mt-2 text-[11px] opacity-75">Active v{item.rotation.activeKeyVersion} · Oldest {item.rotation.oldestPayloadKeyVersion == null ? 'none' : `v${item.rotation.oldestPayloadKeyVersion}`} · Pending {item.rotation.payloadsPendingRotation || 0}</div>}{item.action && item.status !== 'not_applicable' && <button type="button" onClick={onOpenSettings} className="mt-3 inline-flex items-center gap-1 text-xs font-bold underline underline-offset-2">{item.action}<ChevronRight className="h-3.5 w-3.5" /></button>}</div>
              <ProtectionGuidance
                item={item}
                expanded={expandedControlId === item.id}
                onToggle={() => setExpandedControlId((current) => current === item.id ? null : item.id)}
                onOpenSettings={onOpenSettings}
                showDeveloperActions={SHOW_DEVELOPER_ACTIONS}
              />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

export function ZonesTab({ data, onAcceptSuggestion, onDismissSuggestion }) {
  const zones = data?.zones || [];
  const suggestions = data?.zoneSuggestions || [];
  const summary = data?.zoneSummary || {};
  const drivingReadout = data?.drivingReadout || {};
  if (!zones.length) {
    return (
      <div className="space-y-4">
        <ZoneSuggestionCards
          suggestions={suggestions}
          onAcceptSuggestion={onAcceptSuggestion}
          onDismissSuggestion={onDismissSuggestion}
        />
        <EmptyState text={drivingReadout.tripCount ? `No privacy zones are configured, but ${drivingReadout.tripCount} trip${drivingReadout.tripCount === 1 ? '' : 's'} were found. Add home, work, or sensitive-place zones in Settings so endpoint GPS can be hidden.` : 'No privacy zones are configured. Add one in Settings to hide sensitive route areas.'} />
        <SummaryCard icon={Activity} label="Trips analyzed" value={drivingReadout.tripCount || 0} detail={drivingReadout.latestTripAt ? `Latest trip ${formatRelativeTime(drivingReadout.latestTripAt)}` : 'No completed trips found'} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ZoneSuggestionCards
        suggestions={suggestions}
        onAcceptSuggestion={onAcceptSuggestion}
        onDismissSuggestion={onDismissSuggestion}
      />
      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex items-start gap-3"><Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div><div className="font-semibold">How these counts work</div><p className="mt-1 text-xs text-muted-foreground">Zone counts come from saved trip records, not from refreshing this page. The score input self-test uses a synthetic zone and only checks that the scoring pipeline is masking private inputs; it is not a count of your real drives.</p></div></div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={MapPin} label="Configured zones" value={summary.zoneCount || 0} detail={`${summary.activeZoneCount || 0} have protected trip activity`} />
        <SummaryCard icon={Activity} label="Trips analyzed" value={drivingReadout.tripCount || 0} detail={`${drivingReadout.tripsWithProtectedActivity || 0} with protected activity`} />
        <SummaryCard icon={Lock} label="Private endpoints" value={drivingReadout.privateEndpointTripCount || 0} detail="Trips starting or ending inside a zone" />
        <SummaryCard icon={EyeOff} label="GPS samples today" value={summary.pointsToday || 0} detail={`${summary.pointsWeek || 0} this week`} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={Activity} label="Events today" value={summary.eventsToday || 0} detail={`${summary.eventsWeek || 0} this week`} />
        <SummaryCard icon={Clock3} label="Latest protection" value={summary.latestAt ? formatRelativeTime(summary.latestAt) : 'None'} detail={summary.latestAt ? formatTime(summary.latestAt) : 'No saved trip has crossed a zone'} />
        <SummaryCard icon={AlertTriangle} label="Untouched zones" value={drivingReadout.untouchedZoneCount || 0} detail={`${drivingReadout.staleZoneCount || 0} stale for 90+ days`} tone={drivingReadout.untouchedZoneCount ? 'warn' : 'default'} />
        <SummaryCard icon={XCircle} label="Raw points in zones" value={drivingReadout.rawPointInsideZoneCount || 0} detail="Saved samples that still match zone guards" tone={drivingReadout.rawPointInsideZoneCount ? 'error' : 'default'} />
      </div>
      {(drivingReadout.recommendedChecks || []).length > 0 && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="font-semibold">Zone checks to make this useful</div>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {drivingReadout.recommendedChecks.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {zones.map((zone) => {
          const zoneReadout = (drivingReadout.zoneSummaries || []).find((item) => item.id === zone.id) || {};
          const zoneVerdict = zoneReadout.lastActive
            ? `${zoneReadout.protectedRecords || 0} protected records`
            : drivingReadout.tripCount
              ? 'Configured but not matched'
              : 'Ready for future trips';
          return (
            <article key={zone.id} className={`rounded-2xl border p-4 shadow-sm ${zone.lastActive ? statusClass.ok : 'border-border bg-card'}`}>
              <div className="flex items-start justify-between gap-3"><div><div className="font-semibold">{zone.label}</div><div className="mt-1 text-xs opacity-80">{zone.type === 'corridor' ? 'Route corridor' : 'Circle'} - {Math.round(zone.radius_m)} m {zone.type === 'corridor' ? 'width' : 'mask radius'} - {zoneVerdict}</div>{zone.expiresAt && <div className="mt-1 text-xs font-semibold text-amber-700 dark:text-amber-200">{formatExpiryCountdown(zone.expiresAt)}</div>}</div><span className={`rounded-full px-2 py-1 text-xs font-semibold ${zone.lastActive ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100' : 'bg-secondary text-muted-foreground'}`}>{zone.sensitivity === 'high' ? 'High' : zone.lastActive ? 'Protecting' : 'Ready'}</span></div>
              <div className="mt-3 rounded-xl bg-background/55 p-3 text-xs opacity-85">
                {zone.lastActive
                  ? `Last matched a saved trip ${formatRelativeTime(zone.lastActive)}. Route samples or events were hidden for this zone.`
                  : drivingReadout.tripCount
                    ? 'No saved trip has matched this zone yet. Check the radius or whether this is actually where trips start, end, or pass through.'
                    : 'This zone is configured and will be checked when trips are saved.'}
              </div>
              {(Number(zone?.effectiveness?.nearMissCount) || 0) > 0 && (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                  {zone.effectiveness.nearMissCount} raw point{zone.effectiveness.nearMissCount === 1 ? '' : 's'} were just outside this zone&apos;s boundary - consider widening to {zone.effectiveness.suggestedRadiusM} m.
                </div>
              )}
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <ZoneMetric label="GPS today" value={zone.today.hidden} />
                <ZoneMetric label="Events today" value={zone.today.events} />
                <ZoneMetric label="GPS this week" value={zone.week.hidden} />
                <ZoneMetric label="Events this week" value={zone.week.events} />
                <ZoneMetric label="GPS all time" value={zone.allTime.hidden} />
                <ZoneMetric label="Events all time" value={zone.allTime.events} />
              </div>
              <div className="mt-3 text-xs opacity-80">Last protected record: {zone.lastActive ? formatTime(zone.lastActive) : 'No saved suppression record yet'}</div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ZoneSuggestionCards({
  suggestions = [],
  onAcceptSuggestion,
  onDismissSuggestion,
}) {
  return suggestions.map((suggestion) => (
    <section
      key={`${suggestion.suggestedCenter.lat.toFixed(4)}_${suggestion.suggestedCenter.lng.toFixed(4)}`}
      className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sky-950 shadow-sm dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-100"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="font-semibold">Frequent stop suggestion</div>
          <p className="mt-1 text-xs opacity-85">
            Seen on {suggestion.occurrenceDays} different days. Review the suggested {suggestion.suggestedRadiusM} m circle before saving. Last seen {formatRelativeTime(suggestion.lastSeenAt)}.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => onDismissSuggestion?.(suggestion)}
            className="rounded-lg border border-current/25 px-3 py-2 text-xs font-semibold"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={() => onAcceptSuggestion?.(suggestion)}
            className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
          >
            Review area
          </button>
        </div>
      </div>
    </section>
  ));
}

function ZoneMetric({ label, value }) {
  return <div className="rounded-xl bg-secondary/60 p-3 text-center"><div className="font-grotesk text-xl font-bold">{value || 0}</div><div className="mt-1 text-[11px] text-muted-foreground">{label}</div></div>;
}

export function AuditTab({ data }) {
  const entries = (data?.chain || []).slice().reverse();
  const [query, setQuery] = useState('');
  const [operation, setOperation] = useState('all');
  const [checkpointResult, setCheckpointResult] = useState(null);
  const [lastCheckpointExportedAt, setLastCheckpointExportedAt] = useState(
    data?.auditSummary?.lastCheckpointExportedAt || null
  );
  const fileInputRef = useRef(null);
  const operations = data?.auditSummary?.operations || [];
  const chainValid = data?.chainResult?.valid === true;
  const signatureCoverage = data?.auditSummary?.signatureCoverage || 0;
  const hasHardwareSignedEntry = (data?.chain || []).some((entry) => (
    Boolean(entry?.tipSignature) && Boolean(entry?.signingPublicKey)
  ));
  const checkpointReminderDue = entries.length > 0 && (
    !lastCheckpointExportedAt ||
    Date.now() - lastCheckpointExportedAt > CHECKPOINT_REMINDER_MS
  );
  useEffect(() => {
    setLastCheckpointExportedAt(data?.auditSummary?.lastCheckpointExportedAt || null);
  }, [data?.auditSummary?.lastCheckpointExportedAt]);
  const exportCheckpoint = useCallback(async () => {
    try {
      const checkpoint = await exportAuditCheckpoint();
      const blob = new Blob([JSON.stringify(checkpoint, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `road-sage-audit-checkpoint-${checkpoint.seq}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setLastCheckpointExportedAt(checkpoint.exported_at);
    } catch (checkpointError) {
      logSystemFailure('privacy_audit_checkpoint_export_failed', checkpointError, {});
      setCheckpointResult({
        valid: false,
        signatureStatus: 'invalid',
        reason: checkpointError?.message,
      });
    }
  }, []);
  const filtered = useMemo(() => entries.filter((entry) => {
    if (operation !== 'all' && entry.op !== operation) return false;
    if (!query.trim()) return true;
    const meta = auditMeta(entry);
    return `${entry.op} ${meta.title} ${meta.description} ${entry.zone_label || ''} ${entry.details?.service || ''} ${entry.details?.status || ''}`.toLowerCase().includes(query.trim().toLowerCase());
  }), [entries, operation, query]);
  return (
    <div className="space-y-4">
      <div className={`rounded-2xl border p-4 ${chainValid ? (hasHardwareSignedEntry && signatureCoverage === 0 ? statusClass.ok : statusClass.warn) : statusClass.error}`}>
        <div className="flex items-start gap-3">{chainValid ? <ShieldCheck className="h-5 w-5 shrink-0" /> : <XCircle className="h-5 w-5 shrink-0" />}<div><div className="font-semibold">{chainValid ? (hasHardwareSignedEntry && signatureCoverage === 0 ? 'Hash-chain consistent, hardware-signed tip available' : hasHardwareSignedEntry ? `Hash-chain consistent, ${signatureCoverage} entries since the last hardware-signed checkpoint` : 'Hash-chain consistent, hardware signature unavailable') : 'Audit chain broken'}</div><div className="mt-1 text-xs opacity-80">{chainValid ? `${data.chainResult.length || 0} entries are linked in order. Tip ${shortHash(data.chainResult.tip)}. ${hasHardwareSignedEntry ? 'Keep an exported checkpoint outside the app to compare against later local history.' : 'An unsigned local chain only protects against casual tampering.'}` : `Entry ${(data?.chainResult?.brokenAt ?? 0) + 1}: ${data?.chainResult?.reason || 'Verification failed'}`}</div></div></div>
      </div>
      <div className="rounded-2xl border border-border bg-card p-4 text-sm shadow-sm"><div className="flex items-start gap-3"><Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div><div className="font-semibold">What the audit log can show</div><p className="mt-1 text-xs text-muted-foreground">Each entry includes the previous entry&apos;s hash. A retained signed checkpoint can detect later local history rewrites when compared with the current chain. An unsigned chain only protects against casual tampering because the local chain and anchor can be rewritten together. This is local evidence, not third-party proof.</p></div></div></div>
      {checkpointReminderDue && (
        <div className={`rounded-2xl border p-4 ${statusClass.warn}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">Export a checkpoint so later verification has an outside reference.</div>
              <div className="mt-1 text-xs opacity-80">Keep the exported file outside the app and verify it later against the live chain.</div>
            </div>
            <button type="button" onClick={exportCheckpoint} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground">
              <Download className="h-4 w-4" /> Export checkpoint
            </button>
          </div>
        </div>
      )}
      <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={exportCheckpoint}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
          >
            <Download className="h-4 w-4" /> Export checkpoint
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold">
            <Upload className="h-4 w-4" /> Verify checkpoint
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (event) => {
              try {
                const file = event.target.files?.[0];
                if (!file) return;
                setCheckpointResult(await verifyCheckpoint(JSON.parse(await file.text())));
              } catch (checkpointError) {
                logSystemFailure('privacy_audit_checkpoint_verify_failed', checkpointError, {});
                setCheckpointResult({
                  valid: false,
                  signatureStatus: 'invalid',
                  reason: checkpointError?.message || 'Checkpoint file is invalid',
                });
              } finally {
                event.target.value = '';
              }
            }}
          />
        </div>
        {checkpointResult && (
          <div className={`mt-3 rounded-lg border p-3 text-xs ${checkpointResult.valid ? (checkpointResult.signatureStatus === 'verified' ? statusClass.ok : statusClass.warn) : statusClass.error}`}>
            {checkpointResult.valid
              ? checkpointResult.signatureStatus === 'verified'
                ? 'Chain history matches the saved checkpoint and its hardware-backed signature is valid local evidence.'
                : 'Hash-chain consistent, hardware signature unavailable.'
              : checkpointResult.reason}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">A retained, verified signed checkpoint can detect later local history rewrites when compared with the current chain. An unsigned checkpoint can still detect ordinary edits while the local anchor remains trustworthy.</p>
      </section>
      <div className="grid gap-3 sm:grid-cols-3"><SummaryCard icon={History} label="Entries today" value={data?.auditSummary?.todayTotal || 0} detail={`${data?.auditSummary?.weekTotal || 0} this week`} /><SummaryCard icon={Activity} label="Operation types" value={operations.length} detail="Distinct privacy actions" /><SummaryCard icon={Clock3} label="Latest entry" value={data?.auditSummary?.latestAt ? formatRelativeTime(data.auditSummary.latestAt) : 'None'} detail={data?.auditSummary?.latestAt ? formatTime(data.auditSummary.latestAt) : 'No audit activity yet'} /></div>
      <div className="grid gap-2 rounded-2xl border border-border bg-card p-4 shadow-sm md:grid-cols-[1fr_220px]"><label className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search audit activity" className="h-9 w-full rounded-xl border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-1 focus:ring-ring" /></label><select value={operation} onChange={(event) => setOperation(event.target.value)} className="h-9 rounded-xl border border-input bg-background px-3 text-sm"><option value="all">All operations</option>{operations.map((item) => <option key={item.operation} value={item.operation}>{titleCase(item.operation)} ({item.count})</option>)}</select></div>
      <div className="text-xs text-muted-foreground">Showing {filtered.length} of {entries.length} audit entr{entries.length === 1 ? 'y' : 'ies'}</div>
      {filtered.length === 0 ? <EmptyState text={entries.length ? 'No audit entries match these filters.' : 'No audit events yet.'} /> : filtered.map((entry) => <AuditCard key={entry.hash || entry.seq} entry={entry} />)}
    </div>
  );
}

function AuditCard({ entry }) {
  const meta = auditMeta(entry);
  return (
    <article className="rounded-2xl border border-border bg-card p-4 text-sm shadow-sm">
      <div className="flex items-start justify-between gap-3"><div><div className="font-semibold">{meta.title}</div><div className="mt-1 text-xs text-muted-foreground">{meta.description}</div></div><span className="rounded-full bg-secondary px-2 py-1 text-[11px] font-semibold text-muted-foreground">Seq {entry.seq}</span></div>
      <div className="mt-3 grid gap-2 rounded-xl bg-secondary/40 p-3 text-xs sm:grid-cols-2"><div><span className="font-semibold">Time:</span> {formatTime(entry.timestamp)}</div><div><span className="font-semibold">Hash:</span> {shortHash(entry.hash)}</div>{entry.zone_label && <div><span className="font-semibold">Zone:</span> {entry.zone_label}</div>}{entry.hidden_count > 0 && <div><span className="font-semibold">Protected records:</span> {entry.hidden_count}</div>}{entry.details?.service && <div><span className="font-semibold">Service:</span> {entry.details.service}</div>}{entry.details?.status && <div><span className="font-semibold">Status:</span> {entry.details.status}</div>}</div>
    </article>
  );
}

function EmptyState({ text }) {
  return <div className="rounded-2xl border border-dashed border-border bg-secondary/30 p-8 text-center text-sm text-muted-foreground">{text}</div>;
}
