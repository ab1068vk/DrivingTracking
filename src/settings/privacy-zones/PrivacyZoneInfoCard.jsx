import { Lock } from 'lucide-react';

export function PrivacyZoneInfoCard() {
  return (
    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
      <div className="flex gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Lock className="h-4 w-4 text-primary" />
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Parked locations inside a privacy zone will not send your GPS coordinates to external map services. The widget shows 'Parked near [zone name]' instead.
        </p>
      </div>
    </div>
  );
}
