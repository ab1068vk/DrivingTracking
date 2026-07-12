import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  CheckCircle2,
  Mic,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  Volume2,
} from 'lucide-react';
import useLocalSettings from '@/hooks/useLocalSettings';
import { activeTripStore, localSettings, VOICE_ALERT_STYLE_VALUES } from '@/lib/trackingStore';
import { getNativeAutoTrackingStatus, getNativeDiagnostics } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import { getSystemLogs } from '@/lib/systemLog';
import {
  getVoiceAlertDeliveryStatus,
  testVoiceAlert,
} from '@/lib/voiceAlerts';
import {
  buildVoiceAlertMessage,
  resolveVoiceAlertMessageStyle,
  VOICE_COOLDOWNS_BY_TIER,
} from '@/lib/voiceAlertMessages';

const STYLE_LABELS = {
  mode_default: 'Mode default',
  coaching: 'Coaching',
  technical: 'Technical',
};

const formatCooldown = (value) => {
  if (value === Infinity) return 'disabled';
  const seconds = Math.round((Number(value) || 0) / 1000);
  return seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} sec`;
};

const formatTime = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'source unavailable';
};

const normalizeNativeDiagnostics = (value) => ({
  enabled: value?.enabled === true,
  events: Array.isArray(value?.events) ? value.events : [],
});

const yieldToPaint = () => new Promise((resolve) => {
  if (typeof window === 'undefined') {
    resolve();
    return;
  }
  window.setTimeout(resolve, 0);
});

const alertLogRows = (systemLogs = [], nativeDiagnostics = {}) => {
  const webRows = (Array.isArray(systemLogs) ? systemLogs : [])
    .filter((event) => /voice_alert|voice_speed_marker/i.test(`${event.operation || ''} ${event.title || ''}`))
    .slice(0, 8)
    .map((event) => ({
      id: event.id,
      source: event.source || 'web',
      type: event.operation || 'voice_alert',
      title: event.title || event.operation || 'Voice alert',
      detail: event.message || event.details?.reason || event.details?.channel || 'recorded',
      timestamp: event.timestamp,
    }));
  const nativeRows = (nativeDiagnostics.events || [])
    .filter((event) => /voice_alert|voice_speed_marker|phone_use|speed/i.test(`${event.type || ''} ${event.title || ''}`))
    .slice(0, 8)
    .map((event, index) => ({
      id: `native-${index}-${event.timestamp || event.type || 'event'}`,
      source: 'android',
      type: event.type || 'native_diagnostic',
      title: event.title || event.type || 'Native diagnostic',
      detail: event.reason || event.detail || event.source || 'recorded',
      timestamp: event.timestamp || event.timestamp_ms || event.time,
    }));
  return [...webRows, ...nativeRows].slice(0, 10);
};

export default function TrackingAlertsLab() {
  const settings = useLocalSettings();
  const [testStatus, setTestStatus] = useState('');
  const [testing, setTesting] = useState(false);
  const activeTrip = activeTripStore.get();
  const style = resolveVoiceAlertMessageStyle(settings);

  const { data: nativeStatus = { enabled: false } } = useQuery({
    queryKey: ['tracking-alerts-native-status'],
    queryFn: () => getNativeAutoTrackingStatus(),
    staleTime: 30 * 1000,
  });
  const { data: nativeDiagnosticsRaw = { enabled: false, events: [] } } = useQuery({
    queryKey: ['tracking-alerts-native-diagnostics'],
    queryFn: () => getNativeDiagnostics(),
    staleTime: 15 * 1000,
  });
  const { data: systemLogs = [] } = useQuery({
    queryKey: ['tracking-alerts-system-logs'],
    queryFn: () => getSystemLogs(),
    staleTime: 10 * 1000,
  });

  const nativeDiagnostics = normalizeNativeDiagnostics(nativeDiagnosticsRaw);
  const delivery = getVoiceAlertDeliveryStatus({
    settings,
    trip: activeTrip,
    isAndroidPlatform: isAndroid(),
    nativeStatus,
    tracking: Boolean(activeTrip),
  });
  const rows = useMemo(
    () => alertLogRows(systemLogs, nativeDiagnostics),
    [nativeDiagnostics, systemLogs]
  );
  const markerStatus = settings.voice_speed_markers_enabled === true
    ? nativeDiagnostics.events.some((event) => /voice_speed_marker/i.test(`${event.type || ''}`))
      ? 'listener evidence recorded'
      : 'enabled; no recent listener evidence'
    : 'disabled';

  const runTestAlert = async () => {
    setTesting(true);
    setTestStatus('test alert queued');
    try {
      await yieldToPaint();
      const spoken = await testVoiceAlert(localSettings.get());
      setTestStatus(spoken ? 'test alert accepted' : 'test alert unavailable');
    } catch (error) {
      setTestStatus(error?.message || 'test alert unavailable');
    } finally {
      setTesting(false);
    }
  };

  const updateStyle = (event) => {
    localSettings.update({ voice_alert_style: event.target.value });
  };

  return (
    <div className="flex min-h-[calc(100dvh-8.5rem)] min-w-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-background/80 px-3 py-2">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-normal text-muted-foreground">Advanced Tracking Mode</div>
            <h1 className="font-grotesk text-xl font-bold tracking-normal">Voice Alert Lab</h1>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Shared voice alert delivery, wording style, cooldowns, native ownership, and recent alert evidence.
            </p>
          </div>
          <button
            type="button"
            onClick={runTestAlert}
            disabled={testing}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
          >
            <Volume2 className="h-4 w-4" />
            Test alert
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <section className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label="Delivery status" value={delivery.label} detail={delivery.detail} icon={Volume2} />
          <Metric label="Delivery owner" value={delivery.status === 'native' ? 'native' : 'webview'} detail={delivery.status} icon={Radio} />
          <Metric label="Wording style" value={style} detail={`setting: ${settings.voice_alert_style || 'mode_default'}`} icon={SlidersHorizontal} />
          <Metric label="Speed marker listener" value={markerStatus} detail={isAndroid() ? 'Android diagnostics' : 'Android only'} icon={Mic} />
          <Metric label="Test status" value={testStatus || 'source unavailable'} detail="Existing speech path" icon={Bell} />
        </section>

        <section className="grid min-w-0 gap-3 px-3 pb-3 xl:grid-cols-[20rem_minmax(0,1fr)]">
          <Panel title="Style Control" detail="Shared setting">
            <label className="block text-xs font-semibold uppercase tracking-normal text-muted-foreground" htmlFor="voice-alert-style">
              Voice alert style
            </label>
            <select
              id="voice-alert-style"
              value={settings.voice_alert_style || 'mode_default'}
              onChange={updateStyle}
              className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              {VOICE_ALERT_STYLE_VALUES.map((value) => (
                <option key={value} value={value}>{STYLE_LABELS[value] || value}</option>
              ))}
            </select>
            <div className="mt-4 rounded-md border border-border bg-background/70 p-3 text-xs leading-relaxed text-muted-foreground">
              <div className="font-semibold text-foreground">Current preview</div>
              <p className="mt-2">{buildVoiceAlertMessage('harsh_brake', {}, { settings })}</p>
              <p className="mt-2">{buildVoiceAlertMessage('speeding', { speedKmh: 74, speedLimitKmh: 60, speedLimitSource: 'openstreetmap' }, { settings })}</p>
            </div>
          </Panel>

          <Panel title="Speed Tier Cooldowns" detail="Shared engine cooldown keys">
            <div className="overflow-x-auto">
              <table className="min-w-[42rem] w-full text-left text-xs">
                <thead className="border-b border-border text-[11px] uppercase tracking-normal text-muted-foreground">
                  <tr>
                    <Th>Tier</Th>
                    <Th>Cooldown</Th>
                    <Th>Voice key</Th>
                    <Th>Technical sample</Th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(VOICE_COOLDOWNS_BY_TIER).map(([tier, cooldown]) => (
                    <tr key={tier} className="border-b border-border/70">
                      <Td><span className="font-semibold text-foreground">{tier}</span></Td>
                      <Td>{formatCooldown(cooldown)}</Td>
                      <Td>{`speeding_${tier}`}</Td>
                      <Td>{buildVoiceAlertMessage('speeding', { speedKmh: 74, speedLimitKmh: 60, tier }, { style: 'technical' }) || 'source unavailable'}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </section>

        <section className="grid min-w-0 gap-3 px-3 pb-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Panel title="Recent Alert Evidence" detail={`${rows.length} retained rows`}>
            <div className="overflow-x-auto">
              <table className="min-w-[48rem] w-full text-left text-xs">
                <thead className="border-b border-border text-[11px] uppercase tracking-normal text-muted-foreground">
                  <tr>
                    <Th>Time</Th>
                    <Th>Source</Th>
                    <Th>Type</Th>
                    <Th>Detail</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-border/70">
                      <Td>{formatTime(row.timestamp)}</Td>
                      <Td>{row.source}</Td>
                      <Td><span className="font-semibold text-foreground">{row.type}</span></Td>
                      <Td>{row.detail}</Td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-sm text-muted-foreground">
                        No recent voice alert diagnostics retained.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Ownership Rules" detail="Unchanged">
            <div className="space-y-3 text-sm">
              <Note icon={ShieldCheck} title="Native owner preserved" text="Android native trips mute WebView speech and keep background speech in the native service." />
              <Note icon={CheckCircle2} title="Cooldowns preserved" text="The lab reads existing speed-tier cooldowns; it does not reset or replace shared cooldown tracking." />
              <Note icon={Mic} title="Marker listener" text="Voice speed marker testing still uses the existing Android speech-recognition entry point." />
            </div>
          </Panel>
        </section>
      </main>
    </div>
  );
}

function Metric({ label, value, detail, icon: Icon }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 line-clamp-2 text-base font-bold leading-tight">{value}</div>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{detail}</p>
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
  return <td className="align-top px-3 py-3">{children}</td>;
}
