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

export default function LegalNoticeDialog({
  open,
  onOpenChange,
  onAcknowledge,
  reviewMode = false,
}) {
  const handleAction = () => {
    onAcknowledge?.();
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto rounded-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Legal, Safety, Data & Privacy Notice</AlertDialogTitle>
          <AlertDialogDescription>
            {LEGAL_NOTICE_INTRO}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 font-medium text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
            {LEGAL_DISCLAIMER_SHORT}
          </div>

          {reviewMode && (
            <div className="rounded-xl border border-border bg-card p-3 text-xs leading-relaxed text-muted-foreground">
              This is the same notice shown when a new notice version requires acknowledgment.
            </div>
          )}

          <section className="rounded-xl border border-border bg-card p-3">
            <div className="font-semibold text-foreground">Most important points</div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
              {LEGAL_NOTICE_KEY_POINTS.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </section>

          <div className="space-y-3">
            {LEGAL_DISCLAIMER_GROUPS.map((group) => (
              <section key={group.title} className="space-y-2">
                <div className="px-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  {group.title}
                </div>
                <div className="grid gap-2">
                  {group.items.map((item) => (
                    <section key={item.title} className="rounded-xl border border-border bg-secondary/30 p-3">
                      <div className="font-semibold text-foreground">{item.title}</div>
                      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.body}</div>
                    </section>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {!reviewMode && (
            <div className="rounded-xl border border-border bg-card p-3 text-xs leading-relaxed text-muted-foreground">
              By continuing, you confirm that you have read and understand this notice. You can reread it later in Settings under Privacy & Data.
            </div>
          )}

          <div className="text-[11px] text-muted-foreground">
            Notice version {LEGAL_NOTICE_ACK_VERSION}
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogAction onClick={handleAction}>
            {reviewMode ? 'Close' : 'I have read and understand'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
