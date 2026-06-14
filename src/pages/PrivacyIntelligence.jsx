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

const statusClass = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100',
  configured: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-100',
  warn: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100',
  unknown: 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-200',
  error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100',
  not_applicable: 'border-border bg-secondary/40 text-muted-foreground',
};

const privacyLevelClass = {
  blocked: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-200',
  raw: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-100',
  protected: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100',
  unverified: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  none: 'bg-secondary text-muted-foreground',
};

const STATUS_LABELS = {
  ok: 'Verified',
  configured: 'Configured',
  warn: 'Needs attention',
  unknown: 'Unverified',
  error: 'Failing',
  not_applicable: 'N/A',
};

const V2_BANNER_KEY = 'privacy_intel_v2_banner_dismissed';

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

const auditMeta = (entry = {}) => {
  const [title, description] = auditLabels[entry.op] || [titleCase(entry.op), 'A privacy-related operation was recorded.'];
  return { title, description };
};

export default function PrivacyIntelligence() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [authed, setAuthed] = useState(false);

  const authenticate = useCallback(async () => {
    try {
      const result = await authenticateDevice('Access Privacy Intelligence');
      if (result.verified) {
        setAuthed(true);
        setError('');
        return true;
      }
      window.history.back();
    } catch (authError) {
      setError(authError?.message || 'Device authentication is unavailable.');
    }
    return false;
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
    let backgroundedAt = 0;
    CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        backgroundedAt = Date.now();
        return;
      }
      if (backgroundedAt && Date.now() - backgroundedAt >= 5 * 60 * 1000) {
        setAuthed(false);
        void authenticate();
      }
      backgroundedAt = 0;
    }).then((handle) => { listener = handle; }).catch(() => {});
    return () => listener?.remove?.();
  }, [authenticate]);

  const loadData = useCallback(async ({ quiet = false } = {}) => {
    if (!authed) return;
    if (!quiet) setRefreshing(true);
    try {
      setData(await loadPrivacyIntelligence());
      setError('');
    } catch (loadError) {
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

  if (error && !data) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <div className="text-sm font-medium text-red-600 dark:text-red-300">{error}</div>
        <button type="button" onClick={() => (authed ? loadData() : authenticate())} className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Retry</button>
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
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">See what was protected, what left the device, and whether the privacy record can be trusted.</p>
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
      {tab === 'zones' && <ZonesTab data={data} />}
      {tab === 'audit' && <AuditTab data={data} />}
    </div>
  );
}

function OverviewTab({ data, onOpenTab, onOpenSettings }) {
  const score = data?.score || {};
  const zoneSummary = data?.zoneSummary || {};
  const transmissions = data?.transmissions || {};
  const recommendations = data?.recommendations || [];
  const [showThreatModel, setShowThreatModel] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(() => (
    globalThis.localStorage?.getItem(V2_BANNER_KEY) === 'true'
  ));
  return (
    <div className="min-w-0 space-y-4 overflow-hidden">
      {!bannerDismissed && (
        <section className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sky-950 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-100">
          <div className="font-semibold">Privacy Intelligence now verifies protections in real time</div>
          <p className="mt-1 text-sm opacity-90">Your score may look different because unverified checks no longer receive full credit.</p>
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
      <div className="grid min-w-0 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section className={`min-w-0 rounded-3xl border p-5 shadow-sm ${statusClass[score.tone] || statusClass.warn}`}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-bold uppercase tracking-wide opacity-80">Privacy posture</span>
            <span className="rounded-full bg-background/60 px-2 py-1 text-xs font-bold">{score.label || 'Checking'}</span>
          </div>
          <div className="mt-5 flex items-end gap-2"><span className="font-grotesk text-6xl font-bold leading-none">{score.overall ?? 0}</span><span className="pb-1 text-sm font-semibold opacity-70">/ 100</span></div>
          <p className="mt-3 break-words text-sm opacity-90">{score.detail}</p>
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
        <SummaryCard icon={Radio} label="Requests this week" value={transmissions.weekTotal || 0} detail={`${transmissions.protectedTotal || 0} protected, ${transmissions.blockedTotal || 0} blocked`} onClick={() => onOpenTab('transmissions')} />
        <SummaryCard icon={ShieldCheck} label="Protections active" value={data?.protectionSummary?.active || 0} detail={`${data?.protectionSummary?.warnings || 0} warnings, ${data?.protectionSummary?.errors || 0} errors`} onClick={() => onOpenTab('protections')} />
        <SummaryCard icon={History} label="Audit integrity" value={data?.chainResult?.valid ? 'Verified' : 'Needs review'} detail={`${data?.chain?.length || 0} chained entries`} tone={data?.chainResult?.valid ? 'ok' : 'error'} onClick={() => onOpenTab('audit')} />
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <section className="min-w-0 rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><h2 className="font-semibold">Protected activity</h2><p className="mt-1 break-words text-xs text-muted-foreground">Derived from saved redacted trip records, not screen views.</p></div><button type="button" onClick={() => onOpenTab('zones')} className="shrink-0 text-xs font-semibold text-primary">View zones</button></div>
          <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
            <MiniMetric label="GPS samples this week" value={zoneSummary.pointsWeek || 0} />
            <MiniMetric label="Events this week" value={zoneSummary.eventsWeek || 0} />
            <MiniMetric label="Active zones" value={`${zoneSummary.activeZoneCount || 0}/${zoneSummary.zoneCount || 0}`} />
            <MiniMetric label="Latest protection" value={zoneSummary.latestAt ? formatRelativeTime(zoneSummary.latestAt) : 'None yet'} />
          </div>
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
      <button type="button" onClick={() => setShowThreatModel(true)} className="w-full text-center text-xs text-muted-foreground underline underline-offset-4">
        Local privacy activity and protection checks - not an external security audit.
      </button>
      <Dialog open={showThreatModel} onOpenChange={setShowThreatModel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>What this dashboard does and does not show</DialogTitle>
            <DialogDescription>These checks provide local evidence, not a guarantee against a fully compromised device or application.</DialogDescription>
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
  return (
    <Component type={onClick ? 'button' : undefined} onClick={onClick} className={`min-w-0 rounded-2xl border p-4 text-left shadow-sm ${tone === 'error' ? statusClass.error : 'border-border bg-card'} ${onClick ? 'transition-colors hover:bg-secondary/40' : ''}`}>
      <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-muted-foreground"><Icon className="h-4 w-4 shrink-0 text-primary" /><span className="min-w-0 break-words">{label}</span></div>
      <div className="mt-2 break-words font-grotesk text-2xl font-bold">{value}</div>
      <div className="mt-1 break-words text-xs text-muted-foreground">{detail}</div>
    </Component>
  );
}

function MiniMetric({ label, value }) {
  return <div className="min-w-0 rounded-xl bg-secondary/50 p-3"><div className="break-words font-grotesk text-xl font-bold">{value}</div><div className="mt-1 break-words text-[11px] text-muted-foreground">{label}</div></div>;
}

function TransmissionsTab({ data, onClear }) {
  const entries = data?.transmissions?.entries || [];
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [service, setService] = useState('all');
  const services = data?.transmissions?.services || [];
  const filtered = useMemo(() => entries.filter((entry) => {
    if (status !== 'all' && entry.privacyLevel !== status && entry.status !== status) return false;
    if (service !== 'all' && entry.service !== service) return false;
    if (!query.trim()) return true;
    const haystack = `${entry.type} ${entry.service} ${entry.sentCoords || ''} ${(entry.protections || []).join(' ')} ${entry.tripId || ''}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }), [entries, query, service, status]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={ShieldCheck} label="Verified protections" value={data?.transmissions?.protectedTotal || 0} detail={`${data?.transmissions?.claimedButUnverifiedCount || 0} claimed but unverified`} />
        <SummaryCard icon={Ban} label="Blocked requests" value={data?.transmissions?.blockedTotal || 0} detail="Nothing was sent" />
        <SummaryCard icon={AlertTriangle} label="Raw-coordinate sends" value={data?.transmissions?.totalRawCoords || 0} detail="Review any non-zero count" tone={data?.transmissions?.totalRawCoords ? 'error' : 'default'} />
        <SummaryCard icon={Database} label="Outbound metadata" value={formatBytes(data?.transmissions?.totalBytesOut)} detail="Retained locally for 30 days" />
      </div>

      <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div><h2 className="font-semibold">Outbound data records</h2><p className="mt-1 text-xs text-muted-foreground">This log records what category of location data left the device. It does not store full request responses.</p></div>
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
        <div><span className="font-semibold">Trip:</span> {entry.tripId || 'Not linked'}</div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">{(entry.protections || []).length ? entry.protections.map((item) => <span key={item} className="rounded-full bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary">{item}</span>) : <span className="text-xs text-muted-foreground">No additional protection metadata recorded.</span>}</div>
    </article>
  );
}

function ProtectionsTab({ data, onOpenSettings }) {
  const protections = data?.protections || [];
  const [filter, setFilter] = useState('all');
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
            <div className="flex items-start gap-3">
              {item.status === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : item.status === 'error' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> : item.status === 'unknown' || item.status === 'not_applicable' ? <Info className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{item.label}</span><span className="rounded-full bg-background/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">{item.category}</span><span className="rounded bg-background/60 px-2 py-0.5 text-[10px] font-bold uppercase">{STATUS_LABELS[item.status] || 'Unknown'}</span></div><div className="mt-1 text-xs opacity-90">{item.evidence || item.detail}</div>{item.rotation && <div className="mt-2 text-[11px] opacity-75">Active v{item.rotation.activeKeyVersion} · Oldest {item.rotation.oldestPayloadKeyVersion == null ? 'none' : `v${item.rotation.oldestPayloadKeyVersion}`} · Pending {item.rotation.payloadsPendingRotation || 0}</div>}{item.action && item.status !== 'not_applicable' && <button type="button" onClick={onOpenSettings} className="mt-3 inline-flex items-center gap-1 text-xs font-bold underline underline-offset-2">{item.action}<ChevronRight className="h-3.5 w-3.5" /></button>}</div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function ZonesTab({ data }) {
  const zones = data?.zones || [];
  const summary = data?.zoneSummary || {};
  if (!zones.length) return <EmptyState text="No privacy zones are configured. Add one in Settings to hide sensitive route areas." />;
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex items-start gap-3"><Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div><div className="font-semibold">How these counts work</div><p className="mt-1 text-xs text-muted-foreground">GPS samples and driving events are counted from redacted records saved with each trip. Reopening maps or refreshing this page does not increase them.</p></div></div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={MapPin} label="Configured zones" value={summary.zoneCount || 0} detail={`${summary.activeZoneCount || 0} have protected trip activity`} />
        <SummaryCard icon={EyeOff} label="GPS samples today" value={summary.pointsToday || 0} detail={`${summary.pointsWeek || 0} this week`} />
        <SummaryCard icon={Activity} label="Events today" value={summary.eventsToday || 0} detail={`${summary.eventsWeek || 0} this week`} />
        <SummaryCard icon={Clock3} label="Latest protection" value={summary.latestAt ? formatRelativeTime(summary.latestAt) : 'None'} detail={summary.latestAt ? formatTime(summary.latestAt) : 'No saved trip has crossed a zone'} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {zones.map((zone) => (
          <article key={zone.id} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3"><div><div className="font-semibold">{zone.label}</div><div className="mt-1 text-xs text-muted-foreground">{Math.round(zone.radius_m)} m mask radius</div></div><span className={`rounded-full px-2 py-1 text-xs font-semibold ${zone.lastActive ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100' : 'bg-secondary text-muted-foreground'}`}>{zone.lastActive ? 'Protected activity' : 'Ready'}</span></div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <ZoneMetric label="GPS today" value={zone.today.hidden} />
              <ZoneMetric label="Events today" value={zone.today.events} />
              <ZoneMetric label="GPS this week" value={zone.week.hidden} />
              <ZoneMetric label="Events this week" value={zone.week.events} />
              <ZoneMetric label="GPS all time" value={zone.allTime.hidden} />
              <ZoneMetric label="Events all time" value={zone.allTime.events} />
            </div>
            <div className="mt-3 text-xs text-muted-foreground">Last protected record: {zone.lastActive ? formatTime(zone.lastActive) : 'No saved suppression record yet'}</div>
          </article>
        ))}
      </div>
    </div>
  );
}

function ZoneMetric({ label, value }) {
  return <div className="rounded-xl bg-secondary/60 p-3 text-center"><div className="font-grotesk text-xl font-bold">{value || 0}</div><div className="mt-1 text-[11px] text-muted-foreground">{label}</div></div>;
}

function AuditTab({ data }) {
  const entries = (data?.chain || []).slice().reverse();
  const [query, setQuery] = useState('');
  const [operation, setOperation] = useState('all');
  const [checkpointResult, setCheckpointResult] = useState(null);
  const fileInputRef = useRef(null);
  const operations = data?.auditSummary?.operations || [];
  const filtered = useMemo(() => entries.filter((entry) => {
    if (operation !== 'all' && entry.op !== operation) return false;
    if (!query.trim()) return true;
    const meta = auditMeta(entry);
    return `${entry.op} ${meta.title} ${meta.description} ${entry.zone_label || ''} ${entry.details?.service || ''} ${entry.details?.status || ''}`.toLowerCase().includes(query.trim().toLowerCase());
  }), [entries, operation, query]);
  return (
    <div className="space-y-4">
      <div className={`rounded-2xl border p-4 ${data?.chainResult?.valid ? statusClass.ok : statusClass.error}`}>
        <div className="flex items-start gap-3">{data?.chainResult?.valid ? <ShieldCheck className="h-5 w-5 shrink-0" /> : <XCircle className="h-5 w-5 shrink-0" />}<div><div className="font-semibold">{data?.chainResult?.valid ? 'Audit chain verified' : 'Audit chain broken'}</div><div className="mt-1 text-xs opacity-80">{data?.chainResult?.valid ? `${data.chainResult.length || 0} entries are linked in order. Tip ${shortHash(data.chainResult.tip)}.` : `Entry ${(data?.chainResult?.brokenAt ?? 0) + 1}: ${data?.chainResult?.reason || 'Verification failed'}`}</div></div></div>
      </div>
      <div className="rounded-2xl border border-border bg-card p-4 text-sm shadow-sm"><div className="flex items-start gap-3"><Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div><div className="font-semibold">What the audit log proves</div><p className="mt-1 text-xs text-muted-foreground">Each entry includes the previous entry's hash. Editing, reordering, or deleting an entry breaks verification. The log records privacy operations and intentionally excludes coordinates, addresses, tokens, and zone radius details.</p></div></div></div>
      <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={async () => {
              try {
                const checkpoint = await exportAuditCheckpoint();
                const blob = new Blob([JSON.stringify(checkpoint, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `road-sage-audit-checkpoint-${checkpoint.seq}.json`;
                link.click();
                URL.revokeObjectURL(url);
              } catch (checkpointError) {
                setCheckpointResult({ valid: false, reason: checkpointError?.message });
              }
            }}
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
                setCheckpointResult({ valid: false, reason: checkpointError?.message || 'Checkpoint file is invalid' });
              } finally {
                event.target.value = '';
              }
            }}
          />
        </div>
        {checkpointResult && (
          <div className={`mt-3 rounded-lg border p-3 text-xs ${checkpointResult.valid ? statusClass.ok : statusClass.error}`}>
            {checkpointResult.valid ? 'Chain history matches the saved checkpoint.' : checkpointResult.reason}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">A saved checkpoint makes later history changes detectable across time. It is tamper-evident, not tamper-proof.</p>
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
