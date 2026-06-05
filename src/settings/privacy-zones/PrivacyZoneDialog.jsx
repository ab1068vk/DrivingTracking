import { useEffect, useMemo, useState } from 'react';
import { LocateFixed } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import { createZoneDraft, zoneFromDraft, ZONE_RADIUS_MAX_M, ZONE_RADIUS_MIN_M } from './privacyZoneConstants';
import { formatCoordinateLabel } from './privacyZoneFormatting';

function canSaveZone(draft) {
  return String(draft.name || '').trim() &&
    Number.isFinite(Number(draft.lat)) &&
    Number.isFinite(Number(draft.lng));
}

function useZoneDraft(open, zone) {
  const [draft, setDraft] = useState(() => createZoneDraft(zone));

  useEffect(() => {
    if (open) setDraft(createZoneDraft(zone));
  }, [open, zone]);

  return [draft, setDraft];
}

function LocationCapture({ draft, setDraft }) {
  const coordinateLabel = useMemo(
    () => formatCoordinateLabel(draft.lat, draft.lng),
    [draft.lat, draft.lng]
  );

  const captureLocation = () => {
    if (!navigator.geolocation) {
      alert('Location unavailable');
      return;
    }

    setDraft((current) => ({ ...current, locating: true }));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setDraft((current) => ({
          ...current,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          locating: false,
        }));
      },
      () => {
        setDraft((current) => ({ ...current, locating: false }));
        alert('Location unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 }
    );
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={captureLocation}
        disabled={draft.locating}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
      >
        <LocateFixed className="h-4 w-4" />
        {draft.locating ? 'Finding location...' : 'Use current location'}
      </button>
      {coordinateLabel && (
        <div className="rounded-xl bg-secondary/70 px-3 py-2 text-xs font-medium text-muted-foreground">
          {coordinateLabel}
        </div>
      )}
    </div>
  );
}

function RadiusControl({ radius, onChange }) {
  return (
    <div className="space-y-3">
      <Slider
        min={ZONE_RADIUS_MIN_M}
        max={ZONE_RADIUS_MAX_M}
        step={10}
        value={[radius]}
        onValueChange={(value) => onChange(value[0])}
        aria-label="Privacy zone radius"
      />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{ZONE_RADIUS_MIN_M}m</span>
        <span className="font-semibold text-foreground">{radius}m radius</span>
        <span>{ZONE_RADIUS_MAX_M}m</span>
      </div>
    </div>
  );
}

export function PrivacyZoneDialog({ mode, open, zone, onOpenChange, onSave }) {
  const [draft, setDraft] = useZoneDraft(open, zone);
  const saveDisabled = !canSaveZone(draft);
  const title = mode === 'edit' ? 'Edit privacy zone' : 'Add privacy zone';

  const saveZone = async () => {
    if (saveDisabled) return;
    await onSave(zoneFromDraft(draft));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Save private places where parked GPS coordinates should be hidden from external map services.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="block space-y-2">
            <span className="text-sm font-medium">Name</span>
            <input
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary"
              placeholder="e.g. Home, Work, Gym"
            />
          </label>

          <RadiusControl
            radius={draft.radius}
            onChange={(radius) => setDraft((current) => ({ ...current, radius }))}
          />

          <LocationCapture draft={draft} setDraft={setDraft} />
        </div>

        <DialogFooter className="gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-xl border border-border px-3 py-2 text-sm font-semibold hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={saveZone}
            disabled={saveDisabled}
            className="rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            Save zone
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
