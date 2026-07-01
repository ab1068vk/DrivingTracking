// @ts-check
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  AlertTriangle,
  BellOff,
  Car,
  ClipboardCheck,
  Database,
  FileText,
  FileWarning,
  Lock,
  Map,
  Scale,
  ShieldCheck,
  Wifi,
} from 'lucide-react';
import {
  LEGAL_DATA_PRACTICES,
  LEGAL_DISCLAIMER_ITEMS,
  LEGAL_DISCLAIMER_SHORT,
  LEGAL_NOTICE_ACK_VERSION,
  LEGAL_NOTICE_INTRO,
  LEGAL_NOTICE_KEY_POINTS,
} from '@/lib/legalDisclaimers';

const LEGAL_DISCLAIMER_GROUPS = LEGAL_DISCLAIMER_ITEMS.reduce((groups, item) => {
  const group = item.group || 'Notice';
  if (!groups.some((entry) => entry.title === group)) {
    groups.push({ title: group, items: [] });
  }
  groups.find((entry) => entry.title === group).items.push(item);
  return groups;
}, []);

const CRITICAL_BOUNDARIES = [
  {
    title: 'Drive first',
    body: 'Do not interact with Road Sage while driving. Posted signs, police direction, traffic laws, and road conditions always override the app.',
    icon: AlertTriangle,
    tone: 'text-red-600 dark:text-red-300',
    surface: 'border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/25',
  },
  {
    title: 'Estimates only',
    body: 'Scores, alerts, limits, costs, fatigue, phone-use, incident, and vehicle signals can be wrong, delayed, or unavailable.',
    icon: ClipboardCheck,
    tone: 'text-amber-700 dark:text-amber-200',
    surface: 'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/25',
  },
  {
    title: 'Not official advice',
    body: 'Not legal, insurance, emergency, navigation, tax, employment, fleet, compliance, medical, repair, or safety-critical advice.',
    icon: Scale,
    tone: 'text-blue-700 dark:text-blue-200',
    surface: 'border-blue-200 bg-blue-50 dark:border-blue-900/60 dark:bg-blue-950/25',
  },
  {
    title: 'Local by default',
    body: 'Sensitive trip data stays on this device unless you export, back up, import, share files, or enable optional outside road-data features.',
    icon: Lock,
    tone: 'text-emerald-700 dark:text-emerald-200',
    surface: 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/25',
  },
];

const RELEASE_RISK_POINTS = [
  {
    title: 'Consent and lawful use',
    body: 'You must have required consent and permission before tracking, scoring, exporting, or reviewing data about another person, vehicle, worker, family member, minor, or shared device.',
    icon: ShieldCheck,
  },
  {
    title: 'No adverse decisions from app-only data',
    body: 'Do not use Road Sage outputs by themselves for insurance, employment, legal, tax, medical, fleet, eligibility, pricing, safety, or disciplinary decisions.',
    icon: FileWarning,
  },
  {
    title: 'Verify important facts elsewhere',
    body: 'If something matters legally, financially, medically, commercially, or for safety, verify with primary records, current road signs, qualified professionals, or official sources.',
    icon: FileText,
  },
];

const PRACTICAL_RULES = [
  {
    title: 'Tracking reliability',
    body: 'Foreground manual trips need Road Sage open onscreen. Background GPS can record while minimized when Android allows the service. Fully closing or force-stopping the app can still stop tracking.',
    icon: Car,
  },
  {
    title: 'Speed limits and alerts',
    body: 'Posted signs and user-confirmed signs are highest priority. Map, regional, learned, road-type, and GPS-inferred speed limits are estimates and can be wrong.',
    icon: AlertTriangle,
  },
  {
    title: 'Maps and route records',
    body: 'Maps are trip logs, not navigation. Sparse GPS may save lower-confidence trips with markers, gaps, or imperfect route lines.',
    icon: Map,
  },
  {
    title: 'Notifications and voice alerts',
    body: 'Alerts can be late, muted, blocked, missed, unavailable, or wrong. Do not depend on them to prevent harm.',
    icon: BellOff,
  },
  {
    title: 'Privacy zones and exports',
    body: 'Privacy zones reduce sensitive location detail for enabled features, but they are not absolute protection against exports, screenshots, backups, notifications, modified builds, network metadata, external endpoints, or device compromise.',
    icon: Lock,
  },
  {
    title: 'Outside services',
    body: 'Saved road-speed reviews can reduce repeated OpenStreetMap lookups. OpenStreetMap, Open-Meteo, and OSRM requests run only through enabled features, and those services have their own availability, privacy, and logging practices.',
    icon: Wifi,
  },
];

function NoticeBadge({ children, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-normal ${className}`}>
      {children}
    </span>
  );
}

function SectionHeading({ eyebrow, title, children }) {
  return (
    <div className="px-1">
      <div className="text-[11px] font-bold uppercase tracking-normal text-muted-foreground">{eyebrow}</div>
      <div className="mt-1 text-base font-semibold text-foreground">{title}</div>
      {children && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{children}</div>}
    </div>
  );
}

export default function LegalNoticeDialog({
  open,
  onOpenChange,
  onAcknowledge,
  reviewMode = false,
  actionLabel = '',
}) {
  const handleAction = () => {
    onAcknowledge?.();
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-4xl overflow-y-auto rounded-2xl p-0 sm:max-h-[92dvh] sm:w-full">
        <div className="px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 sm:pb-6">
          <AlertDialogHeader className="space-y-4 text-left">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <span className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <ShieldCheck className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <NoticeBadge className={reviewMode ? 'bg-secondary text-muted-foreground' : 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-200'}>
                      {reviewMode ? 'Settings copy' : 'Required review'}
                    </NoticeBadge>
                    <NoticeBadge className="bg-primary/10 text-primary">Version {LEGAL_NOTICE_ACK_VERSION}</NoticeBadge>
                  </div>
                  <AlertDialogTitle className="text-xl leading-tight sm:text-2xl">
                    Road Sage Safety, Legal, Tracking & Privacy Notice
                  </AlertDialogTitle>
                  <AlertDialogDescription className="mt-2 text-sm leading-relaxed">
                    {LEGAL_NOTICE_INTRO}
                  </AlertDialogDescription>
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
              <div className="flex items-start gap-3">
                <FileWarning className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <div>
                  <div className="font-semibold">Read this before relying on Road Sage</div>
                  <div className="mt-1 text-sm leading-relaxed">{LEGAL_DISCLAIMER_SHORT}</div>
                </div>
              </div>
            </div>
          </AlertDialogHeader>

          <div className="mt-5 space-y-6 text-sm">

            <section className="grid gap-3 lg:grid-cols-4">
              {CRITICAL_BOUNDARIES.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className={`rounded-xl border p-3 ${item.surface}`}>
                    <div className={`flex items-center gap-2 font-semibold ${item.tone}`}>
                      <Icon className="h-4 w-4" />
                      {item.title}
                    </div>
                    <div className="mt-2 text-xs leading-relaxed text-foreground/80 dark:text-muted-foreground">{item.body}</div>
                  </div>
                );
              })}
            </section>

            <section className="rounded-xl border border-border bg-card p-4">
              <SectionHeading eyebrow="Required understanding" title="Most important points">
                These are the conditions for using Road Sage safely and responsibly.
              </SectionHeading>
              <ul className="mt-3 grid gap-2 text-xs leading-relaxed text-muted-foreground sm:grid-cols-2">
                {LEGAL_NOTICE_KEY_POINTS.map((point) => (
                  <li key={point} className="flex gap-2 rounded-lg border border-border bg-background/70 p-2.5">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-300" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-3">
              <SectionHeading eyebrow="Public-use safeguards" title="Legal and safety boundaries">
                Road Sage can help organize your own driving information, but it must not replace current law, professional review, or official records.
              </SectionHeading>
              <div className="grid gap-3 md:grid-cols-3">
                {RELEASE_RISK_POINTS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.title} className="rounded-xl border border-border bg-card p-3">
                      <div className="flex items-center gap-2 font-semibold text-foreground">
                        <Icon className="h-4 w-4 text-primary" />
                        {item.title}
                      </div>
                      <div className="mt-2 text-xs leading-relaxed text-muted-foreground">{item.body}</div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="space-y-3">
              <SectionHeading eyebrow="Practical limits" title="What this means while using the app">
                These limits apply to everyday tracking, maps, alerts, privacy controls, and third-party road-data features.
              </SectionHeading>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {PRACTICAL_RULES.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.title} className="rounded-xl border border-border bg-secondary/25 p-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <Icon className="h-4 w-4 text-primary" />
                        {item.title}
                      </div>
                      <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{item.body}</div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card">
              <div className="border-b border-border px-4 py-3">
                <SectionHeading eyebrow="Privacy summary" title="Data and permission summary">
                  Sensitive data may be accessed only when the relevant feature, permission, import, export, backup, or outside-service option is used.
                </SectionHeading>
              </div>
              <div className="divide-y divide-border">
                {LEGAL_DATA_PRACTICES.map((item) => (
                  <div key={item.title} className="grid gap-3 px-4 py-3 text-xs leading-relaxed md:grid-cols-[0.8fr_1fr_1fr_1fr]">
                    <div className="flex items-center gap-2 font-semibold text-foreground">
                      <Database className="h-4 w-4 text-primary" />
                      {item.title}
                    </div>
                    <div>
                      <div className="font-semibold text-foreground">Access</div>
                      <div className="mt-1 text-muted-foreground">{item.access}</div>
                    </div>
                    <div>
                      <div className="font-semibold text-foreground">Use</div>
                      <div className="mt-1 text-muted-foreground">{item.use}</div>
                    </div>
                    <div>
                      <div className="font-semibold text-foreground">Sharing</div>
                      <div className="mt-1 text-muted-foreground">{item.sharing}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <div className="space-y-4">
              <SectionHeading eyebrow="Detailed notice" title="Full safety, legal, data, and reliability terms">
                These details explain the specific limits behind the summary above.
              </SectionHeading>
              {LEGAL_DISCLAIMER_GROUPS.map((group) => (
                <section key={group.title} className="space-y-2">
                  <div className="px-1 text-xs font-bold uppercase tracking-normal text-muted-foreground">
                    {group.title}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {group.items.map((item) => (
                      <section key={item.title} className="rounded-xl border border-border bg-background p-3">
                        <div className="font-semibold text-foreground">{item.title}</div>
                        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.body}</div>
                      </section>
                    ))}
                  </div>
                </section>
              ))}
            </div>

            {!reviewMode && (
              <section className="rounded-xl border border-border bg-card p-4 text-xs leading-relaxed text-muted-foreground">
                <div className="font-semibold text-foreground">Acknowledgement</div>
                <div className="mt-1">
                  By continuing, you confirm that you have read and understand this notice. This is not a hidden one-time warning: the same current notice remains available in Settings under Privacy & Data, and updated versions may require review again.
                </div>
              </section>
            )}

            {reviewMode && (
              <section className="rounded-xl border border-border bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground">
                This is the same notice shown during first-launch setup and whenever the required notice version changes. Settings keeps the current version here so you can review it anytime.
              </section>
            )}
          </div>

          <AlertDialogFooter className="mt-6 border-t border-border pt-4">
            <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs leading-relaxed text-muted-foreground">
                Version {LEGAL_NOTICE_ACK_VERSION}. Review again from Settings anytime.
              </div>
              <AlertDialogAction onClick={handleAction} className="w-full sm:w-auto">
                {actionLabel || (reviewMode ? 'Close' : 'I have read and understand')}
              </AlertDialogAction>
            </div>
          </AlertDialogFooter>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
