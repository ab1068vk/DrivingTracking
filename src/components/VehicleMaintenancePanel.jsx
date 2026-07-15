// @ts-check
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  ExternalLink,
  Gauge,
  Plus,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  buildDrivingLoadAdvisory,
  buildVehicleMaintenancePlan,
  normalizeMaintenanceItems,
  recordVehicleService,
} from '@/lib/vehicleMaintenance';
import {
  getVehicleReferenceSources,
  VEHICLE_MAINTENANCE_DISCLAIMER,
  VEHICLE_REFERENCE_CATALOG_VERSION,
} from '@/lib/vehicleReferenceCatalog';

const statusTone = {
  due: 'border-red-300 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200',
  soon: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200',
  ok: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200',
  needs_source: 'border-border bg-secondary/50 text-muted-foreground',
  needs_baseline: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200',
  needs_confirmation: 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200',
};

const humanize = (value) => String(value || '').replace(/_/g, ' ');

function dueText(item) {
  if (item.status === 'needs_confirmation') return 'Confirm exact model-year applicability before enabling';
  if (item.status === 'needs_source') return 'Not scheduled - add the exact manufacturer source';
  if (item.status === 'needs_baseline') return 'Add the last service date or vehicle in-service date before calendar tracking';
  const parts = [];
  if (item.remaining_km != null) {
    parts.push(item.remaining_km <= 0
      ? `${Math.abs(item.remaining_km).toLocaleString()} km overdue`
      : `${item.remaining_km.toLocaleString()} km remaining`);
  }
  if (item.remaining_days != null) {
    parts.push(item.remaining_days <= 0
      ? `${Math.abs(item.remaining_days)} days overdue`
      : `${item.remaining_days} days remaining`);
  }
  return parts.join(' / ') || 'Monitor the manufacturer schedule or dashboard';
}

function sourceLabel(item) {
  if (item.source_type === 'manufacturer_reference') return 'Manufacturer reference - owner confirmation required';
  if (item.source_type === 'owner_entered_manufacturer') return 'Owner-entered manufacturer schedule';
  if (item.source_type === 'manufacturer_monitor') return 'Vehicle dashboard monitor';
  if (item.source_type === 'legacy_unverified') return 'Retired generic Road Sage value';
  return humanize(item.source_type || 'source needed');
}

const freshItemDraft = (odometerKm) => ({
  label: '',
  interval_km: '',
  interval_months: '',
  last_service_km: String(Math.max(0, Math.round(odometerKm))),
  last_service_date: new Date().toISOString().slice(0, 10),
  source_title: '',
  source_url: '',
  source_page: '',
  condition_note: '',
});

export default function VehicleMaintenancePanel({ vehicle, trips, odometerKm, onUpdate }) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(() => freshItemDraft(odometerKm));
  const plan = useMemo(
    () => buildVehicleMaintenancePlan(vehicle, { odometerKm }),
    [vehicle, odometerKm]
  );
  const advisory = useMemo(() => buildDrivingLoadAdvisory(trips), [trips]);
  const references = useMemo(() => getVehicleReferenceSources(vehicle), [vehicle]);
  const history = Array.isArray(vehicle.service_history) ? vehicle.service_history : [];

  const update = async (patch) => {
    setSaving(true);
    try {
      await onUpdate(patch);
    } finally {
      setSaving(false);
    }
  };

  const confirmReference = async (itemId) => {
    const items = normalizeMaintenanceItems(vehicle).map((item) => (
      String(item.id) === String(itemId)
        ? { ...item, enabled: true, confirmed_by_user: true }
        : item
    ));
    await update({ maintenance_items: items });
  };

  const removeItem = async (itemId) => {
    await update({
      maintenance_items: normalizeMaintenanceItems(vehicle)
        .filter((item) => String(item.id) !== String(itemId)),
    });
  };

  const addScheduleItem = async () => {
    const intervalKm = Math.max(0, Number(draft.interval_km) || 0);
    const intervalMonths = Math.max(0, Number(draft.interval_months) || 0);
    if (!draft.label.trim() || (!intervalKm && !intervalMonths) || !draft.source_title.trim()) return;
    const item = {
      id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      label: draft.label.trim(),
      interval_km: intervalKm,
      interval_months: intervalMonths,
      last_service_km: Math.max(0, Number(draft.last_service_km) || 0),
      last_service_date: draft.last_service_date,
      source_type: 'owner_entered_manufacturer',
      source_title: draft.source_title.trim(),
      source_url: draft.source_url.trim(),
      source_page: draft.source_page.trim(),
      source_reviewed_at: new Date().toISOString().slice(0, 10),
      condition_note: draft.condition_note.trim(),
      confirmed_by_user: true,
      enabled: true,
      created_from_catalog_version: VEHICLE_REFERENCE_CATALOG_VERSION,
    };
    await update({
      maintenance_items: [
        ...normalizeMaintenanceItems(vehicle).filter((entry) => entry.source_type !== 'legacy_unverified'),
        item,
      ],
      schedule_source: {
        title: item.source_title,
        url: item.source_url,
        page: item.source_page,
        reviewed_at: item.source_reviewed_at,
      },
    });
    setDraft(freshItemDraft(odometerKm));
  };

  const recordDone = async (itemId) => {
    await update(recordVehicleService(vehicle, itemId, { odometerKm }));
  };

  return (
    <div className="mt-3 space-y-3">
      <section className="rounded-2xl border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-100">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <div className="font-semibold">Manufacturer information wins</div>
            <div className="mt-1">{VEHICLE_MAINTENANCE_DISCLAIMER}</div>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Vehicle match
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {plan.confidence.score}% profile completeness / {humanize(plan.confidence.level)}
            </div>
          </div>
          <span className="rounded-full bg-secondary px-2 py-1 text-[11px] font-semibold text-muted-foreground">
            Offline catalog {plan.catalog_version}
          </span>
        </div>
        {plan.confidence.missing.length > 0 && (
          <div className="mt-2 text-xs text-muted-foreground">
            Add {plan.confidence.missing.join(', ')} to reduce model/trim ambiguity.
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <CalendarClock className="h-4 w-4 text-primary" />
              Source-backed maintenance
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {plan.configured
                ? `${plan.due_items.length} due / ${plan.soon_items.length} due soon`
                : 'No verified schedule is enabled. Road Sage will not claim "all good".'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEditorOpen((open) => !open)}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-semibold"
          >
            {editorOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            Configure
          </button>
        </div>

        <div className="mt-3 space-y-2">
          {plan.items.length === 0 && (
            <div className="rounded-xl bg-secondary/50 p-3 text-xs text-muted-foreground">
              Open the exact owner/warranty manual below, then add each distance, time, or dashboard-monitor requirement. Generic oil, brake, inspection, and tire intervals are intentionally not invented.
            </div>
          )}
          {plan.items.map((item) => (
            <div key={item.id} className={`rounded-xl border p-3 text-xs ${statusTone[item.status] || statusTone.needs_source}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold">{item.label}</div>
                  <div className="mt-1">{dueText(item)}</div>
                  <div className="mt-1 opacity-80">{sourceLabel(item)}</div>
                  {(item.source_title || item.source_page) && (
                    <div className="mt-1 opacity-80">
                      {item.source_title || 'Source'}{item.source_page ? ` - page/section ${item.source_page}` : ''}
                    </div>
                  )}
                  {item.condition_note && <div className="mt-1 leading-relaxed opacity-80">{item.condition_note}</div>}
                </div>
                <div className="flex flex-wrap gap-1">
                  {item.status === 'needs_confirmation' && (
                    <button type="button" disabled={saving} onClick={() => confirmReference(item.id)}
                      className="rounded-lg bg-blue-600 px-2 py-1 font-semibold text-white disabled:opacity-50">
                      I confirmed this
                    </button>
                  )}
                  {item.usable && (
                    <button type="button" disabled={saving} onClick={() => recordDone(item.id)}
                      className="inline-flex items-center gap-1 rounded-lg bg-card px-2 py-1 font-semibold text-foreground disabled:opacity-50">
                      <Check className="h-3 w-3" /> Record done
                    </button>
                  )}
                  <button type="button" disabled={saving} onClick={() => removeItem(item.id)}
                    aria-label={`Remove ${item.label}`}
                    className="rounded-lg bg-card/70 p-1 text-muted-foreground disabled:opacity-50">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {editorOpen && (
          <div className="mt-3 rounded-xl border border-border bg-secondary/30 p-3">
            <div className="text-xs font-semibold">Add an item from the exact manufacturer schedule</div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              Enter what the current manual, warranty supplement, or dashboard monitor says. Distance and time are evaluated together; whichever becomes due first wins.
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                placeholder="Item, e.g. engine oil and filter" className="rounded-lg border border-border bg-card px-2 py-2 text-xs" />
              <input value={draft.source_title} onChange={(event) => setDraft({ ...draft, source_title: event.target.value })}
                placeholder="Source title *" className="rounded-lg border border-border bg-card px-2 py-2 text-xs" />
              <input type="number" min="0" value={draft.interval_km} onChange={(event) => setDraft({ ...draft, interval_km: event.target.value })}
                placeholder="Interval km" className="rounded-lg border border-border bg-card px-2 py-2 text-xs" />
              <input type="number" min="0" value={draft.interval_months} onChange={(event) => setDraft({ ...draft, interval_months: event.target.value })}
                placeholder="Interval months" className="rounded-lg border border-border bg-card px-2 py-2 text-xs" />
              <input type="number" min="0" value={draft.last_service_km} onChange={(event) => setDraft({ ...draft, last_service_km: event.target.value })}
                placeholder="Last service odometer" className="rounded-lg border border-border bg-card px-2 py-2 text-xs" />
              <input type="date" value={draft.last_service_date} onChange={(event) => setDraft({ ...draft, last_service_date: event.target.value })}
                className="rounded-lg border border-border bg-card px-2 py-2 text-xs" />
              <input value={draft.source_url} onChange={(event) => setDraft({ ...draft, source_url: event.target.value })}
                placeholder="Official source URL" className="rounded-lg border border-border bg-card px-2 py-2 text-xs" />
              <input value={draft.source_page} onChange={(event) => setDraft({ ...draft, source_page: event.target.value })}
                placeholder="Page or section" className="rounded-lg border border-border bg-card px-2 py-2 text-xs" />
              <textarea value={draft.condition_note} onChange={(event) => setDraft({ ...draft, condition_note: event.target.value })}
                placeholder="Severe-use, dashboard-code, or whichever-comes-first note"
                className="min-h-16 rounded-lg border border-border bg-card px-2 py-2 text-xs sm:col-span-2" />
            </div>
            <button type="button" disabled={saving || !draft.label.trim() || !draft.source_title.trim() || (!Number(draft.interval_km) && !Number(draft.interval_months))}
              onClick={addScheduleItem}
              className="mt-2 inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40">
              <Plus className="h-3.5 w-3.5" /> Add verified reminder
            </button>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-card p-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Gauge className="h-4 w-4 text-primary" />
          Driving-load advisory
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-lg bg-secondary/50 p-2"><div className="font-semibold capitalize">{advisory.level}</div><div className="text-muted-foreground">pattern</div></div>
          <div className="rounded-lg bg-secondary/50 p-2"><div className="font-semibold">{advisory.events_per_100km ?? 'N/A'}</div><div className="text-muted-foreground">events/100 km</div></div>
          <div className="rounded-lg bg-secondary/50 p-2"><div className="font-semibold capitalize">{advisory.evidence_level}</div><div className="text-muted-foreground">evidence</div></div>
        </div>
        <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {advisory.source_label}. {advisory.disclaimer}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardCheck className="h-4 w-4 text-primary" />
          Safety checks and service history
        </div>
        <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
          <div className="rounded-lg bg-secondary/50 p-2">Check cold tire pressure and visible condition monthly using the door-jamb placard/manual.</div>
          <div className="rounded-lg bg-secondary/50 p-2">Treat every dashboard warning or maintenance code as higher priority than Road Sage.</div>
          <div className="rounded-lg bg-secondary/50 p-2">Check current recalls with the manufacturer using the VIN; offline year/model matches are not enough.</div>
        </div>
        <div className="mt-3 space-y-1">
          {history.length === 0 ? (
            <div className="text-xs text-muted-foreground">No service events recorded yet.</div>
          ) : history.slice(0, 5).map((event) => (
            <div key={event.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-2 py-1.5 text-xs">
              <span className="font-medium">{event.label}</span>
              <span className="text-muted-foreground">{event.serviced_at} / {Number(event.odometer_km).toLocaleString()} km</span>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <BookOpen className="h-4 w-4 text-primary" />
          Primary references
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          Reviewed 2026-07-14. Open the current source before relying on it; manufacturer and government pages can change after an app release.
        </div>
        <div className="mt-2 space-y-2">
          {references.map((source) => (
            <a key={source.id} href={source.url} target="_blank" rel="noreferrer"
              className="block rounded-xl border border-border p-2 text-xs hover:bg-secondary/40">
              <div className="flex items-center justify-between gap-2 font-semibold">
                <span>{source.publisher} - {source.title}</span>
                <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
              </div>
              <div className="mt-1 leading-relaxed text-muted-foreground">{source.note}</div>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
