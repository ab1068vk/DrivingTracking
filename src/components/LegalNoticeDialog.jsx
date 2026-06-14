import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { AlertTriangle, Database, FileWarning, ShieldCheck, Wifi } from 'lucide-react';
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

const NOTICE_HIGHLIGHTS = [
  {
    title: 'Use safely',
    body: 'Never interact with Road Sage while driving. Posted signs, laws, and road conditions come first.',
    icon: AlertTriangle,
  },
  {
    title: 'Local first',
    body: 'Trip history, surveys, logs, vehicles, and settings stay on this device unless you export, back up, import, or enable external context.',
    icon: Database,
  },
  {
    title: 'Optional sharing',
    body: 'OpenStreetMap, Open-Meteo, and trusted OSRM requests run only through enabled road-data features.',
    icon: Wifi,
  },
];

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
      <AlertDialogContent className="max-h-[90vh] max-w-3xl overflow-hidden rounded-2xl p-0">
        <div className="max-h-[90vh] overflow-y-auto">
          <div className="space-y-4 border-b border-border bg-card px-5 py-5 sm:px-6">
            <AlertDialogHeader className="space-y-3 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <ShieldCheck className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <AlertDialogTitle className="text-xl">Legal, Safety, Data & Privacy Notice</AlertDialogTitle>
                  <div className="mt-1 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                    Notice version {LEGAL_NOTICE_ACK_VERSION}
                  </div>
                </div>
              </div>
              <AlertDialogDescription className="text-sm leading-relaxed">
                {LEGAL_NOTICE_INTRO}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
              <div className="flex items-start gap-3">
                <FileWarning className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <div>
                  <div className="font-semibold">Important Safety & Privacy Disclaimer</div>
                  <div className="mt-1 text-sm leading-relaxed">{LEGAL_DISCLAIMER_SHORT}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-5 px-5 py-5 text-sm sm:px-6">
            {reviewMode && (
              <div className="rounded-xl border border-border bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground">
                This is the same first-launch notice. It is available here for review after setup.
              </div>
            )}

            <section className="grid gap-3 sm:grid-cols-3">
              {NOTICE_HIGHLIGHTS.map((item) => {
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
            </section>

            <section className="rounded-xl border border-border bg-card p-4">
              <div className="font-semibold text-foreground">Most important points</div>
              <ul className="mt-3 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
                {LEGAL_NOTICE_KEY_POINTS.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </section>

            <section className="rounded-xl border border-border bg-card">
              <div className="border-b border-border px-4 py-3">
                <div className="font-semibold text-foreground">Data and permission summary</div>
                <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  This privacy notice summary explains what sensitive data may be accessed, why it is used, and when it can leave the device.
                </div>
              </div>
              <div className="divide-y divide-border">
                {LEGAL_DATA_PRACTICES.map((item) => (
                  <div key={item.title} className="grid gap-3 px-4 py-3 text-xs leading-relaxed md:grid-cols-[0.8fr_1fr_1fr_1fr]">
                    <div className="font-semibold text-foreground">{item.title}</div>
                    <div>
                      <div className="font-semibold text-muted-foreground">Access</div>
                      <div className="mt-1 text-muted-foreground">{item.access}</div>
                    </div>
                    <div>
                      <div className="font-semibold text-muted-foreground">Use</div>
                      <div className="mt-1 text-muted-foreground">{item.use}</div>
                    </div>
                    <div>
                      <div className="font-semibold text-muted-foreground">Sharing</div>
                      <div className="mt-1 text-muted-foreground">{item.sharing}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <div className="space-y-4">
              {LEGAL_DISCLAIMER_GROUPS.map((group) => (
                <section key={group.title} className="space-y-2">
                  <div className="px-1 text-xs font-bold uppercase tracking-normal text-muted-foreground">
                    {group.title}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {group.items.map((item) => (
                      <section key={item.title} className="rounded-xl border border-border bg-secondary/25 p-3">
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
                  By continuing, you confirm that you have read and understand this notice. You can reread it later in Settings under Privacy & Data.
                </div>
              </section>
            )}
          </div>

          <AlertDialogFooter className="sticky bottom-0 border-t border-border bg-background/95 px-5 py-4 backdrop-blur sm:px-6">
            <AlertDialogAction onClick={handleAction} className="w-full sm:w-auto">
              {actionLabel || (reviewMode ? 'Close' : 'I have read and understand')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
