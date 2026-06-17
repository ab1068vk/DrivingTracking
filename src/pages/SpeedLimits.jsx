import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Gauge, MapPin, Pencil, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';
import { refreshTripsCrossingLocalSpeedCell } from '@/lib/localSpeedScoreRefresh';
import { getJson, setJson } from '@/lib/mobileStorage';

const knowledgeStore = {
  get: (key) => getJson(key, null),
  set: (key, value) => setJson(key, value),
};

const sourceLabel = (source) => {
  switch (source) {
    case 'user_confirmed_posted_sign':
      return 'Posted sign';
    case 'user_entered_estimate':
      return 'Estimate';
    default:
      return source ? String(source).replace(/_/g, ' ') : 'Saved speed';
  }
};

const formatDate = (value) => {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown time';
};

const formatCoordinate = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(5) : '0.00000';
};

const coordinateLabel = (source) => (
  source === 'geohash_cell_center_legacy'
    ? 'Approx cell center'
    : 'Driven route point'
);

export default function SpeedLimits() {
  const [searchParams] = useSearchParams();
  const tripId = searchParams.get('tripId');
  const knowledge = useMemo(() => new LocalSpeedKnowledge(knowledgeStore), []);
  const [rows, setRows] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyGeohash, setBusyGeohash] = useState(null);
  const [status, setStatus] = useState('');

  const loadRows = useCallback(async () => {
    setLoading(true);
    const nextRows = await knowledge.listUserCorrections().catch(() => []);
    setRows(nextRows);
    setDrafts((current) => {
      const next = { ...current };
      for (const row of nextRows) {
        if (!next[row.geohash]) {
          next[row.geohash] = {
            limitKmh: String(row.limitKmh || ''),
            source: row.source || 'user_entered_estimate',
            note: row.note || '',
          };
        }
      }
      return next;
    });
    setLoading(false);
  }, [knowledge]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  useEffect(() => {
    const onKnowledgeChanged = () => loadRows();
    window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onKnowledgeChanged);
    return () => window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onKnowledgeChanged);
  }, [loadRows]);

  const updateDraft = (geohash, patch) => {
    setDrafts((current) => ({
      ...current,
      [geohash]: {
        limitKmh: '',
        source: 'user_entered_estimate',
        note: '',
        ...(current[geohash] || {}),
        ...patch,
      },
    }));
  };

  const saveRow = async (row) => {
    const draft = drafts[row.geohash] || {};
    const limitKmh = Number(draft.limitKmh);
    if (!Number.isFinite(limitKmh) || limitKmh <= 0) {
      setStatus('Enter a valid speed limit before saving.');
      return;
    }
    setBusyGeohash(row.geohash);
    const saved = await knowledge.updateUserCorrection(
      row.geohash,
      Math.round(limitKmh),
      draft.source,
      draft.note
    ).catch(() => false);
    if (saved) {
      const updatedTrips = await refreshTripsCrossingLocalSpeedCell(row.geohash).catch(() => null);
      setStatus(updatedTrips
        ? `Saved road speed updated. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
        : 'Saved road speed updated, but matching trips could not be recalculated right now.');
      await loadRows();
    } else {
      setStatus('Could not update that saved speed.');
    }
    setBusyGeohash(null);
  };

  const removeRow = async (row) => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this saved road speed?')) return;
    setBusyGeohash(row.geohash);
    const removed = await knowledge.removeUserCorrection(row.geohash).catch(() => false);
    if (removed) {
      const updatedTrips = await refreshTripsCrossingLocalSpeedCell(row.geohash).catch(() => null);
      setStatus(updatedTrips
        ? `Saved road speed removed. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} using remaining speed data and fallbacks.`
        : 'Saved road speed removed, but matching trips could not be recalculated right now.');
      await loadRows();
    } else {
      setStatus('Could not remove that saved speed.');
    }
    setBusyGeohash(null);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-grotesk text-2xl font-bold tracking-tight">Saved road speeds</h1>
            <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground">
              {rows.length} saved
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            User-set road speeds used by trip review, map speed colors, speed zones, and scoring.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tripId && (
            <Link
              to={`/trips/${tripId}?review=speed-limit-conflicts`}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Trip review
            </Link>
          )}
          <button
            type="button"
            onClick={loadRows}
            disabled={loading}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {status && (
        <div className="rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium">
          {status}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          Loading saved speeds...
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
              <Gauge className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">No saved road speeds</h2>
              <p className="mt-1 text-sm text-muted-foreground">Use a trip speed review to save a posted sign or local estimate.</p>
            </div>
          </div>
          <Link
            to="/trips"
            className="mt-4 inline-flex items-center justify-center rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
          >
            Open trips
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const draft = drafts[row.geohash] || {};
            const disabled = busyGeohash === row.geohash;
            return (
              <article key={row.geohash} className="rounded-xl border border-border bg-card p-3 shadow-sm">
                <div className="grid gap-3 lg:grid-cols-[1fr_16rem_13rem] lg:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-foreground">
                        <MapPin className="h-3.5 w-3.5" />
                        {row.geohash}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {coordinateLabel(row.coordinateSource)}: {formatCoordinate(row.lat)}, {formatCoordinate(row.lng)}
                      </span>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <div className="rounded-lg bg-secondary/60 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">Current value</div>
                        <div className="font-semibold">{Math.round(Number(row.limitKmh) || 0)} km/h</div>
                      </div>
                      <div className="rounded-lg bg-secondary/60 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">Type</div>
                        <div className="font-semibold">{sourceLabel(row.source)}</div>
                      </div>
                      <div className="rounded-lg bg-secondary/60 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">Updated</div>
                        <div className="truncate font-semibold">{formatDate(row.appliedAt)}</div>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <label className="flex items-center gap-2 text-xs font-semibold text-foreground">
                      <Gauge className="h-4 w-4 text-muted-foreground" />
                      <input
                        type="number"
                        min="5"
                        step="5"
                        value={draft.limitKmh ?? ''}
                        onChange={(event) => updateDraft(row.geohash, { limitKmh: event.target.value })}
                        className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                      <span className="text-xs text-muted-foreground">km/h</span>
                    </label>
                    <select
                      value={draft.source || 'user_entered_estimate'}
                      onChange={(event) => updateDraft(row.geohash, { source: event.target.value })}
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    >
                      <option value="user_confirmed_posted_sign">Posted sign</option>
                      <option value="user_entered_estimate">Estimate</option>
                    </select>
                    <input
                      type="text"
                      value={draft.note ?? ''}
                      onChange={(event) => updateDraft(row.geohash, { note: event.target.value })}
                      placeholder="Note"
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
                    <button
                      type="button"
                      onClick={() => saveRow(row)}
                      disabled={disabled}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                    >
                      {draft.source === 'user_confirmed_posted_sign' ? <ShieldCheck className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                      Update
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRow(row)}
                      disabled={disabled}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
