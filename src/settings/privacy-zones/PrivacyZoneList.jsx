import { Edit3, Trash2 } from 'lucide-react';
import { zoneKey } from './privacyZoneFormatting';

function PrivacyZoneRow({ index, zone, onDelete, onEdit }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{zone.name}</div>
        <span className="mt-1 inline-flex rounded-full bg-secondary px-2 py-1 text-xs font-semibold text-muted-foreground">
          {Math.round(zone.radius)}m radius
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => onEdit(index)}
          className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label={`Edit ${zone.name} privacy zone`}
        >
          <Edit3 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(index)}
          className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-red-500"
          aria-label={`Delete ${zone.name} privacy zone`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function PrivacyZoneList({ loading, zones, onDelete, onEdit }) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card px-3 py-4 text-sm text-muted-foreground">
        Loading privacy zones...
      </div>
    );
  }

  if (!zones.length) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-secondary/30 px-3 py-4 text-sm text-muted-foreground">
        No privacy zones configured. Add your home and work to keep them private.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {zones.map((zone, index) => (
        <PrivacyZoneRow
          key={zoneKey(zone, index)}
          index={index}
          zone={zone}
          onDelete={onDelete}
          onEdit={onEdit}
        />
      ))}
    </div>
  );
}
