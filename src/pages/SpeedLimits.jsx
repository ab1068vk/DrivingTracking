import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Gauge, Info, Map as MapIcon, MapPin, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Undo2, X } from 'lucide-react';
import { geohashEncode, LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';
import { refreshTripsCrossingLocalSpeedCorrection, tripCrossesCorrection } from '@/lib/localSpeedScoreRefresh';
import { correctionSectionIdentity } from '@/lib/roadSectionIdentity';
import RoadSectionPreview from '@/components/RoadSectionPreview';
import SpeedLimitEditorMap from '@/components/SpeedLimitEditorMap';
import { buildSpeedMapSections, buildSplitCorrections, speedLimitColor } from '@/lib/speedLimitMapSections';
import {
  speedLimitScorePreview,
  speedLimitSourceBadgeClass,
  speedLimitSourceLabel,
  summarizeTripScoreDeltas,
} from '@/lib/speedLimitDisplay';
import { tripService } from '@/api/trips';
import { getJson, setJson } from '@/lib/mobileStorage';
import { getPrivacyZones } from '@/lib/privacyZones';
import useLocalSettings from '@/hooks/useLocalSettings';

const knowledgeStore = {
  get: (key) => getJson(key, null),
  set: (key, value) => setJson(key, value),
};

const sourceLabel = (source) => speedLimitSourceLabel(source, { short: true });

const formatDate = (value) => {
  if (value == null || value === '') return 'Unknown time';
  const date = new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) && time > 0 ? date.toLocaleString() : 'Unknown time';
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

const directionLabel = (mode) => ({
  forward: 'Drawn direction only',
  reverse: 'Opposite direction only',
  both: 'Both directions',
}[mode] || 'Both directions');

const timeRuleModeForRow = (row = {}) => {
  const rule = row.timeRule;
  if (rule?.enabled !== true) return 'always';
  const days = [...(rule.days || [])].sort((a, b) => a - b).join(',');
  if (days === '1,2,3,4,5') return 'weekdays';
  if (days === '0,6') return 'weekends';
  return 'daily';
};

const timeString = (minutes, fallback = '07:00') => {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return fallback;
  const clamped = Math.max(0, Math.min(1439, Math.round(value)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
};

const timeRuleLabel = (rule = null) => {
  if (rule?.enabled !== true) return 'Always active';
  const mode = timeRuleModeForRow({ timeRule: rule });
  const dayLabel = mode === 'weekdays' ? 'Weekdays' : mode === 'weekends' ? 'Weekends' : 'Every day';
  return `${dayLabel} ${timeString(rule.startMinutes)}-${timeString(rule.endMinutes)}`;
};

const dateInputValue = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
};

const expiresAtFromDate = (value) => (
  value ? new Date(`${value}T23:59:59`).toISOString() : null
);

const expiryLabel = (value) => (
  value ? `Expires ${new Date(value).toLocaleDateString()}` : 'No expiry'
);

const timeRuleFromDraft = (draft = {}) => {
  const mode = draft.timeRuleMode || 'always';
  if (mode === 'always') return { enabled: false };
  const days = mode === 'weekdays'
    ? [1, 2, 3, 4, 5]
    : mode === 'weekends'
      ? [0, 6]
      : [0, 1, 2, 3, 4, 5, 6];
  return {
    enabled: true,
    days,
    startTime: draft.startTime || '07:00',
    endTime: draft.endTime || '17:00',
  };
};

const SPEEDS_PER_PAGE = 10;

const tripLabel = (trip = {}) => {
  const title = trip.name || trip.title || trip.label;
  if (title) return title;
  const started = new Date(trip.start_time || trip.started_at || trip.created_at || 0);
  return Number.isFinite(started.getTime())
    ? started.toLocaleDateString()
    : `Trip ${String(trip.id || '').slice(0, 8)}`;
};

export default function SpeedLimits() {
  const [searchParams] = useSearchParams();
  const tripId = searchParams.get('tripId');
  const knowledge = useMemo(() => new LocalSpeedKnowledge(knowledgeStore), []);
  const [rows, setRows] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyGeohash, setBusyGeohash] = useState(null);
  const [status, setStatus] = useState('');
  const [linkedTrip, setLinkedTrip] = useState(null);
  const [mapTrips, setMapTrips] = useState([]);
  const [selectedSection, setSelectedSection] = useState(null);
  const [addMode, setAddMode] = useState(false);
  const [addPath, setAddPath] = useState([]);
  const [mapDraft, setMapDraft] = useState({
    limitKmh: '',
    source: 'user_confirmed_posted_sign',
    note: '',
    roadName: '',
    directionMode: 'both',
    timeRuleMode: 'always',
    startTime: '07:00',
    endTime: '17:00',
    expiresAtDate: '',
  });
  const [page, setPage] = useState(1);
  const settings = useLocalSettings();
  const privacyZones = useMemo(() => getPrivacyZones(settings), [settings]);
  const pageCount = Math.max(1, Math.ceil(rows.length / SPEEDS_PER_PAGE));
  const visibleRows = rows.slice(
    (page - 1) * SPEEDS_PER_PAGE,
    page * SPEEDS_PER_PAGE
  );
  const mapSections = useMemo(() => buildSpeedMapSections(mapTrips, rows), [mapTrips, rows]);
  const conflictsByGeohash = useMemo(() => new Map(
    mapSections
      .filter((section) => section.conflict)
      .map((section) => [section.geohash, section.conflict])
  ), [mapSections]);
  const selectedSectionPointCount = selectedSection?.sectionPoints?.length || 0;
  const canSaveSelectedMapSection = Boolean(selectedSection) && (
    selectedSection.saved || selectedSectionPointCount >= 2
  );
  const matchingTripsForCorrection = useCallback((correction) => (
    mapTrips.filter((trip) => trip?.status === 'completed' && tripCrossesCorrection(trip, correction))
  ), [mapTrips]);

  const buildRecalculationStatus = useCallback((message, beforeTrips = [], updatedTrips = null) => {
    if (!Array.isArray(updatedTrips)) return message;
    return {
      message,
      scoreDeltas: summarizeTripScoreDeltas(beforeTrips, updatedTrips),
      trips: updatedTrips,
    };
  }, []);

  const loadRows = useCallback(async () => {
    setLoading(true);
    const [nextRows, nextTrips] = await Promise.all([
      knowledge.listUserCorrections().catch(() => []),
      tripService.list({ sort: '-start_time', limit: 500 }).catch(() => []),
    ]);
    setRows(nextRows);
    setMapTrips(nextTrips);
    setDrafts((current) => {
      const next = { ...current };
      for (const row of nextRows) {
        if (!next[row.geohash]) {
          next[row.geohash] = {
            limitKmh: String(row.limitKmh || ''),
            source: row.source || 'user_entered_estimate',
            note: row.note || '',
            directionMode: row.directionMode || 'both',
            timeRuleMode: timeRuleModeForRow(row),
            startTime: timeString(row.timeRule?.startMinutes),
            endTime: timeString(row.timeRule?.endMinutes, '17:00'),
            expiresAtDate: dateInputValue(row.expiresAt),
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
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  useEffect(() => {
    let cancelled = false;
    if (!tripId) {
      setLinkedTrip(null);
      return undefined;
    }
    tripService.getById(tripId)
      .then((trip) => {
        if (!cancelled) setLinkedTrip(trip || null);
      })
      .catch(() => {
        if (!cancelled) setLinkedTrip(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

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
    const updatedCorrection = {
      ...row,
      limitKmh: Math.round(limitKmh),
      source: draft.source || row.source || 'user_entered_estimate',
      note: draft.note,
      directionMode: draft.directionMode || 'both',
      timeRule: timeRuleFromDraft(draft),
      expiresAt: expiresAtFromDate(draft.expiresAtDate),
    };
    const beforeTrips = matchingTripsForCorrection(updatedCorrection);
    const saved = await knowledge.updateUserCorrection(
      row.geohash,
      Math.round(limitKmh),
      draft.source || row.source || 'user_entered_estimate',
      draft.note,
      {
        directionMode: draft.directionMode || 'both',
        timeRule: timeRuleFromDraft(draft),
        expiresAt: expiresAtFromDate(draft.expiresAtDate),
      }
    ).catch(() => false);
    if (saved) {
      const updatedTrips = await refreshTripsCrossingLocalSpeedCorrection(updatedCorrection).catch(() => null);
      setStatus(buildRecalculationStatus(
        updatedTrips
          ? `Saved road speed updated. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
          : 'Saved road speed updated, but matching trips could not be recalculated right now.',
        beforeTrips,
        updatedTrips
      ));
      await loadRows();
    } else {
      setStatus('Could not update that saved speed.');
    }
    setBusyGeohash(null);
  };

  const removeRow = async (row) => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this saved road speed?')) return;
    setBusyGeohash(row.geohash);
    const beforeTrips = matchingTripsForCorrection(row);
    const removed = await knowledge.removeUserCorrection(row.geohash).catch(() => false);
    if (removed) {
      const updatedTrips = await refreshTripsCrossingLocalSpeedCorrection(row).catch(() => null);
      setStatus(buildRecalculationStatus(
        updatedTrips
          ? `Saved road speed removed. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} using remaining speed data and fallbacks.`
          : 'Saved road speed removed, but matching trips could not be recalculated right now.',
        beforeTrips,
        updatedTrips
      ));
      await loadRows();
    } else {
      setStatus('Could not remove that saved speed.');
    }
    setBusyGeohash(null);
  };

  const selectMapSection = (section) => {
    setSelectedSection(section);
    setMapDraft({
      limitKmh: section.saved ? String(section.limitKmh || '') : '',
      source: section.source || 'user_confirmed_posted_sign',
      note: section.note || '',
      roadName: section.roadName || '',
      directionMode: section.directionMode || 'both',
      timeRuleMode: timeRuleModeForRow(section),
      startTime: timeString(section.timeRule?.startMinutes),
      endTime: timeString(section.timeRule?.endMinutes, '17:00'),
      expiresAtDate: dateInputValue(section.expiresAt),
    });
    setAddMode(false);
    setAddPath([]);
  };

  const startAddingSection = () => {
    setSelectedSection(null);
    setAddPath([]);
    setAddMode(true);
    setMapDraft({
      limitKmh: '',
      source: 'user_confirmed_posted_sign',
      note: '',
      roadName: '',
      directionMode: 'both',
      timeRuleMode: 'always',
      startTime: '07:00',
      endTime: '17:00',
      expiresAtDate: '',
    });
    setStatus('Trace the road by tapping several points along it. Add more points around bends, then enter the speed and save.');
  };

  const selectNewMapPoint = (point) => {
    setAddPath((current) => {
      const next = [...current, point].slice(-24);
      const midpoint = next[Math.floor(next.length / 2)];
      setSelectedSection({
        ...midpoint,
        geohash: geohashEncode(midpoint.lat, midpoint.lng),
        saved: false,
        roadName: '',
        sectionPoints: next,
      });
      return next;
    });
  };

  const undoAddPoint = () => {
    setAddPath((current) => {
      const next = current.slice(0, -1);
      if (!next.length) {
        setSelectedSection(null);
      } else {
        const midpoint = next[Math.floor(next.length / 2)];
        setSelectedSection((section) => ({
          ...(section || {}),
          ...midpoint,
          geohash: geohashEncode(midpoint.lat, midpoint.lng),
          sectionPoints: next,
        }));
      }
      return next;
    });
  };

  const saveMapSection = async () => {
    if (!selectedSection) return;
    const limitKmh = Number(mapDraft.limitKmh);
    if (!Number.isFinite(limitKmh) || limitKmh <= 0) {
      setStatus('Enter a valid speed limit before saving.');
      return;
    }
    if (!selectedSection.saved && selectedSection.sectionPoints?.length < 2) {
      setStatus('Tap at least two points along the road so Road Sage can save a real road section.');
      return;
    }
    setBusyGeohash(selectedSection.geohash);
    const saved = selectedSection.saved
      ? await knowledge.updateUserCorrection(
        selectedSection.geohash,
        Math.round(limitKmh),
        mapDraft.source,
        mapDraft.note,
        {
          roadName: mapDraft.roadName || selectedSection.roadName || '',
          sectionPoints: selectedSection.sectionPoints || [],
          directionMode: mapDraft.directionMode || 'both',
          directionBearing: selectedSection.directionBearing,
          timeRule: timeRuleFromDraft(mapDraft),
          expiresAt: expiresAtFromDate(mapDraft.expiresAtDate),
        }
      ).catch(() => false)
      : await knowledge.saveUserCorrection(
        selectedSection.lat,
        selectedSection.lng,
        Math.round(limitKmh),
        mapDraft.note,
        expiresAtFromDate(mapDraft.expiresAtDate),
        privacyZones,
        mapDraft.source,
        {
          roadName: mapDraft.roadName || selectedSection.roadName || '',
          contextLabel: 'Selected from the saved road speed map',
          directionLabel: directionLabel(mapDraft.directionMode),
          directionMode: mapDraft.directionMode || 'both',
          directionBearing: selectedSection.directionBearing,
          timeRule: timeRuleFromDraft(mapDraft),
          sectionPoints: selectedSection.sectionPoints || [selectedSection],
        }
      ).catch(() => false);

    if (saved) {
      const correction = {
        ...selectedSection,
        limitKmh: Math.round(limitKmh),
        roadName: mapDraft.roadName || selectedSection.roadName || '',
        sectionPoints: selectedSection.sectionPoints || [],
        directionMode: mapDraft.directionMode || 'both',
        timeRule: timeRuleFromDraft(mapDraft),
        expiresAt: expiresAtFromDate(mapDraft.expiresAtDate),
      };
      const beforeTrips = matchingTripsForCorrection(correction);
      const updatedTrips = await refreshTripsCrossingLocalSpeedCorrection(correction).catch(() => null);
      setStatus(buildRecalculationStatus(
        updatedTrips
          ? `Saved ${Math.round(limitKmh)} km/h for this road section. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
          : `Saved ${Math.round(limitKmh)} km/h for this road section, but matching trips could not be recalculated right now.`,
        beforeTrips,
        updatedTrips
      ));
      setSelectedSection(null);
      setAddMode(false);
      setAddPath([]);
      await loadRows();
    } else {
      setStatus('Could not save this road section. Private-zone sections cannot be saved.');
    }
    setBusyGeohash(null);
  };

  const removeMapSection = async () => {
    if (!selectedSection?.saved) return;
    if (typeof window !== 'undefined' && !window.confirm('Remove the saved speed from this road section?')) return;
    await removeRow(selectedSection);
    setSelectedSection(null);
  };

  const splitMapSection = async () => {
    if (!selectedSection?.saved) return;
    const parts = buildSplitCorrections({
      ...selectedSection,
      limitKmh: Number(mapDraft.limitKmh || selectedSection.limitKmh),
      source: mapDraft.source || selectedSection.source,
      note: mapDraft.note || selectedSection.note || '',
      roadName: mapDraft.roadName || selectedSection.roadName || '',
      directionMode: mapDraft.directionMode || selectedSection.directionMode || 'both',
      timeRule: timeRuleFromDraft(mapDraft),
      expiresAt: expiresAtFromDate(mapDraft.expiresAtDate),
    });
    if (parts.length !== 2) {
      setStatus('This road section needs at least three trace points before it can be split.');
      return;
    }
    const distinct = new Set(parts.map((part) => part.geohash));
    if (distinct.size !== parts.length) {
      setStatus('This section is too short to split safely. Add a longer traced section first.');
      return;
    }
    if (typeof window !== 'undefined' && !window.confirm('Split this saved speed into two editable road sections?')) return;

    setBusyGeohash(selectedSection.geohash);
    const source = mapDraft.source || selectedSection.source || 'user_entered_estimate';
    const noteBase = mapDraft.note || selectedSection.note || '';
    const expiresAt = expiresAtFromDate(mapDraft.expiresAtDate);
    const savedParts = [];
    for (const part of parts) {
      const metadata = {
        roadName: part.roadName || '',
        contextLabel: part.contextLabel,
        directionLabel: directionLabel(part.directionMode),
        sectionPoints: part.sectionPoints,
        directionMode: part.directionMode,
        directionBearing: part.directionBearing,
        timeRule: part.timeRule,
      };
      const note = noteBase ? `${noteBase} (split ${part.splitPart}/2)` : `Split section ${part.splitPart}/2`;
      const saved = part.geohash === selectedSection.geohash
        ? await knowledge.updateUserCorrection(part.geohash, part.limitKmh, source, note, {
          ...metadata,
          expiresAt,
        }).catch(() => false)
        : await knowledge.saveUserCorrection(
          part.lat,
          part.lng,
          part.limitKmh,
          note,
          expiresAt,
          privacyZones,
          source,
          metadata
        ).catch(() => false);
      if (saved) savedParts.push(part);
    }
    if (savedParts.length === parts.length) {
      if (!parts.some((part) => part.geohash === selectedSection.geohash)) {
        await knowledge.removeUserCorrection(selectedSection.geohash).catch(() => false);
      }
      const updatedTrips = await Promise.all(parts.map((part) => (
        refreshTripsCrossingLocalSpeedCorrection(part).catch(() => null)
      )));
      const recalculated = updatedTrips.flat().filter(Boolean).length;
      setStatus(`Road section split into two saved speeds. Recalculated ${recalculated} matching trip${recalculated === 1 ? '' : 's'} locally.`);
      setSelectedSection(null);
      await loadRows();
    } else {
      setStatus('Could not split this section completely. Review saved speeds before trying again.');
      await loadRows();
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
          {typeof status === 'string' ? status : (
            <div className="space-y-2">
              <div>{status.message}</div>
              {status.scoreDeltas?.length > 0 && (
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {status.scoreDeltas.slice(0, 6).map(({ trip, text, changed }) => (
                    <Link
                      key={trip.id}
                      to={`/trips/${trip.id}`}
                      className={`rounded-full px-2 py-1 font-semibold ${
                        changed
                          ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200'
                          : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
                      }`}
                    >
                      {tripLabel(trip)}: {text}
                    </Link>
                  ))}
                  {status.scoreDeltas.length > 6 && (
                    <span className="rounded-full bg-secondary px-2 py-1 text-muted-foreground">
                      +{status.scoreDeltas.length - 6} more
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <section className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <MapIcon className="h-5 w-5 text-primary" />
              <h2 className="font-grotesk text-lg font-bold">Road speed map</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Colored sections have a saved speed. Gray dashed sections were recorded on your trips but still need a speed.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <button
              type="button"
              onClick={addMode ? () => {
                setAddMode(false);
                setAddPath([]);
                setSelectedSection(null);
              } : startAddingSection}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold ${
                addMode ? 'border border-border bg-secondary text-foreground' : 'bg-primary text-primary-foreground'
              }`}
            >
              {addMode ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              {addMode ? 'Cancel adding' : 'Add road speed'}
            </button>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span><span className="mr-1 inline-block h-2.5 w-5 rounded bg-slate-400" />Not set</span>
              {[30, 40, 50, 60, 80, 100].map((limit) => (
                <span key={limit}>
                  <span className="mr-1 inline-block h-2.5 w-5 rounded" style={{ backgroundColor: speedLimitColor(limit) }} />
                  {limit}
                </span>
              ))}
              <span>km/h</span>
            </div>
          </div>
        </div>

        <SpeedLimitEditorMap
          trips={mapTrips}
          corrections={rows}
          selectedGeohash={selectedSection?.geohash || ''}
          addMode={addMode}
          addPath={addPath}
          onSelect={selectMapSection}
          onAddPoint={selectNewMapPoint}
        />

        {selectedSection && (
          <div className="rounded-2xl border border-primary/30 bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-primary">
                  {selectedSection.saved ? 'Edit saved section' : 'Set road speed'}
                </div>
                <h3 className="mt-1 font-semibold">
                  {mapDraft.roadName || selectedSection.roadName || `Road area ${selectedSection.geohash}`}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedSection.saved
                    ? 'This value follows the highlighted saved road section. Create a separate section where the posted limit changes.'
                    : addMode
                      ? `${addPath.length} trace point${addPath.length === 1 ? '' : 's'}. Tap along the road and around each bend; at least two points are required.`
                    : `${selectedSectionPointCount} recorded point${selectedSectionPointCount === 1 ? '' : 's'} in this trip section. Enter the speed and save it as a road section.`}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold">
                  <span className={`rounded-full px-2 py-0.5 ${speedLimitSourceBadgeClass(mapDraft.source)}`}>
                    {speedLimitSourceLabel(mapDraft.source, { short: true })}
                  </span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">
                    {speedLimitScorePreview(selectedSection.limitKmh ?? selectedSection.observedLimitKmh, mapDraft.limitKmh)}
                  </span>
                </div>
                {!selectedSection.saved && addPath.length > 0 && (
                  <button
                    type="button"
                    onClick={undoAddPoint}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary px-2.5 py-1.5 text-xs font-semibold"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                    Undo last point
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedSection(null);
                  setAddPath([]);
                }}
                className="rounded-lg p-2 text-muted-foreground hover:bg-secondary"
                aria-label="Close road speed editor"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-[12rem_14rem_1fr_1fr_auto] xl:items-end">
              <label className="grid gap-1 text-xs font-semibold">
                Speed limit
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="5"
                    step="5"
                    autoFocus
                    value={mapDraft.limitKmh}
                    onChange={(event) => setMapDraft((current) => ({ ...current, limitKmh: event.target.value }))}
                    className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <span className="text-muted-foreground">km/h</span>
                </div>
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                Road name
                <input
                  type="text"
                  value={mapDraft.roadName}
                  onChange={(event) => setMapDraft((current) => ({ ...current, roadName: event.target.value }))}
                  placeholder="Optional road name"
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                Evidence
                <select
                  value={mapDraft.source}
                  onChange={(event) => setMapDraft((current) => ({ ...current, source: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value="user_confirmed_posted_sign">Posted sign</option>
                  <option value="user_entered_estimate">Estimate</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                Optional note
                <input
                  type="text"
                  value={mapDraft.note}
                  onChange={(event) => setMapDraft((current) => ({ ...current, note: event.target.value }))}
                  placeholder="School zone, construction, sign changed..."
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveMapSection}
                  disabled={busyGeohash === selectedSection.geohash || !canSaveSelectedMapSection}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {selectedSection.saved ? <Pencil className="h-3.5 w-3.5" /> : <Gauge className="h-3.5 w-3.5" />}
                  {selectedSection.saved ? 'Update' : 'Save'}
                </button>
                {selectedSection.saved && (
                  <button
                    type="button"
                    onClick={removeMapSection}
                    disabled={busyGeohash === selectedSection.geohash}
                    className="inline-flex items-center justify-center rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-red-700 disabled:opacity-60 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                    aria-label="Remove saved speed"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            <div className="mt-3 grid gap-3 rounded-xl border border-border bg-secondary/30 p-3 md:grid-cols-5">
              <label className="grid gap-1 text-xs font-semibold">
                Applies by direction
                <select
                  value={mapDraft.directionMode}
                  onChange={(event) => setMapDraft((current) => ({ ...current, directionMode: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value="both">Both directions</option>
                  <option value="forward">Drawn direction only</option>
                  <option value="reverse">Opposite direction only</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                Active days
                <select
                  value={mapDraft.timeRuleMode}
                  onChange={(event) => setMapDraft((current) => ({ ...current, timeRuleMode: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value="always">Always active</option>
                  <option value="daily">Every day</option>
                  <option value="weekdays">Weekdays</option>
                  <option value="weekends">Weekends</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                Start time
                <input
                  type="time"
                  value={mapDraft.startTime}
                  disabled={mapDraft.timeRuleMode === 'always'}
                  onChange={(event) => setMapDraft((current) => ({ ...current, startTime: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                End time
                <input
                  type="time"
                  value={mapDraft.endTime}
                  disabled={mapDraft.timeRuleMode === 'always'}
                  onChange={(event) => setMapDraft((current) => ({ ...current, endTime: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                Active until
                <input
                  type="date"
                  value={mapDraft.expiresAtDate}
                  onChange={(event) => setMapDraft((current) => ({ ...current, expiresAtDate: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
            </div>
            {selectedSection.saved && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={splitMapSection}
                  disabled={busyGeohash === selectedSection.geohash || (selectedSection.sectionPoints || []).length < 3}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-60"
                >
                  Split at midpoint
                </button>
                {selectedSection.conflict && (
                  <span className="inline-flex items-center rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                    Conflict: saved {selectedSection.conflict.savedLimitKmh} km/h, trip data suggests {selectedSection.conflict.observedLimitKmh} km/h
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </section>

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
          {visibleRows.map((row) => {
            const draft = drafts[row.geohash] || {};
            const disabled = busyGeohash === row.geohash;
            const identity = correctionSectionIdentity(row, linkedTrip);
            const conflict = conflictsByGeohash.get(row.geohash);
            return (
              <article key={row.geohash} className="rounded-xl border border-border bg-card p-3 shadow-sm">
                <div className="grid gap-3 lg:grid-cols-[1fr_16rem_13rem] lg:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-foreground">
                        <MapPin className="h-3.5 w-3.5" />
                        {identity.title}
                      </span>
                    </div>
                    <div className="mt-2">
                      <RoadSectionPreview
                        identity={identity}
                        routePoints={linkedTrip?.route_points || []}
                        legacyApproximate={row.coordinateSource === 'geohash_cell_center_legacy'}
                      />
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <div className="rounded-lg bg-secondary/60 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">Current value</div>
                        <div className="font-semibold">{Math.round(Number(row.limitKmh) || 0)} km/h</div>
                      </div>
                      <div className="rounded-lg bg-secondary/60 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">Type</div>
                        <div>
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${speedLimitSourceBadgeClass(row.source)}`}>
                            {sourceLabel(row.source)}
                          </span>
                        </div>
                      </div>
                      <div className="rounded-lg bg-secondary/60 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">Updated</div>
                        <div className="truncate font-semibold">{formatDate(row.appliedAt)}</div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold text-muted-foreground">
                      <span className="rounded-full bg-secondary px-2 py-1">{directionLabel(row.directionMode)}</span>
                      <span className="rounded-full bg-secondary px-2 py-1">{timeRuleLabel(row.timeRule)}</span>
                      <span className="rounded-full bg-secondary px-2 py-1">{expiryLabel(row.expiresAt)}</span>
                      <span className="rounded-full bg-secondary px-2 py-1">
                        {speedLimitScorePreview(row.limitKmh, draft.limitKmh)}
                      </span>
                      {conflict && (
                        <span className="rounded-full bg-red-100 px-2 py-1 text-red-700 dark:bg-red-950/40 dark:text-red-300">
                          Conflict: trip data suggests {conflict.observedLimitKmh} km/h
                        </span>
                      )}
                      {Array.isArray(row.editHistory) && row.editHistory.length > 0 && (
                        <span className="rounded-full bg-secondary px-2 py-1">{row.editHistory.length} previous edit{row.editHistory.length === 1 ? '' : 's'}</span>
                      )}
                    </div>
                    <details className="mt-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer font-medium">Saved location reference</summary>
                      <div className="mt-1">
                        {coordinateLabel(row.coordinateSource)}: {formatCoordinate(row.lat)}, {formatCoordinate(row.lng)}; cell {row.geohash}
                      </div>
                    </details>
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
                    <select
                      value={draft.directionMode || 'both'}
                      onChange={(event) => updateDraft(row.geohash, { directionMode: event.target.value })}
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    >
                      <option value="both">Both directions</option>
                      <option value="forward">Drawn direction only</option>
                      <option value="reverse">Opposite direction only</option>
                    </select>
                    <div className="grid grid-cols-3 gap-2">
                      <select
                        value={draft.timeRuleMode || 'always'}
                        onChange={(event) => updateDraft(row.geohash, { timeRuleMode: event.target.value })}
                        className="rounded-xl border border-border bg-background px-2 py-2 text-xs outline-none focus:border-primary"
                        aria-label="Active days"
                      >
                        <option value="always">Always</option>
                        <option value="daily">Daily</option>
                        <option value="weekdays">Weekdays</option>
                        <option value="weekends">Weekends</option>
                      </select>
                      <input
                        type="time"
                        value={draft.startTime || '07:00'}
                        disabled={(draft.timeRuleMode || 'always') === 'always'}
                        onChange={(event) => updateDraft(row.geohash, { startTime: event.target.value })}
                        className="rounded-xl border border-border bg-background px-2 py-2 text-xs outline-none focus:border-primary disabled:opacity-50"
                        aria-label="Start time"
                      />
                      <input
                        type="time"
                        value={draft.endTime || '17:00'}
                        disabled={(draft.timeRuleMode || 'always') === 'always'}
                        onChange={(event) => updateDraft(row.geohash, { endTime: event.target.value })}
                        className="rounded-xl border border-border bg-background px-2 py-2 text-xs outline-none focus:border-primary disabled:opacity-50"
                        aria-label="End time"
                      />
                    </div>
                    <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                      Active until
                      <input
                        type="date"
                        value={draft.expiresAtDate || ''}
                        onChange={(event) => updateDraft(row.geohash, { expiresAtDate: event.target.value })}
                        className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                      />
                    </label>
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
          {pageCount > 1 && (
            <nav
              className="flex items-center justify-between gap-3 border-t border-border pt-3"
              aria-label="Saved road speed pages"
            >
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page === 1}
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
                title="Previous page"
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="text-center text-xs text-muted-foreground">
                <div className="font-semibold text-foreground">Page {page} of {pageCount}</div>
                <div>
                  Showing {(page - 1) * SPEEDS_PER_PAGE + 1}-{Math.min(page * SPEEDS_PER_PAGE, rows.length)} of {rows.length}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                disabled={page === pageCount}
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
                title="Next page"
                aria-label="Next page"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </nav>
          )}
        </div>
      )}

      <section className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <div className="min-w-0">
            <h2 className="font-semibold">How saved road speeds are used</h2>
            <div className="mt-2 grid gap-2 text-xs leading-relaxed">
              <p>
                Speeds you add, edit, split, expire, or delete here are saved locally on this device. When a saved rule matches the road, direction, date, and time, Road Sage uses it first for trip scoring, map colors, speed checks, and voice alerts.
              </p>
              <p>
                If no matching saved rule is available, Road Sage falls back to learned local data, OpenStreetMap/Get Road Data results, then lower-confidence road-type, regional, or GPS estimates.
              </p>
              <p>
                Your saved speed, road name, notes, split sections, direction rules, and time rules are not uploaded to OpenStreetMap. Get Road Data only sends privacy-filtered public-road bounding boxes to an OpenStreetMap Overpass service, which may receive normal network metadata such as your IP address.
              </p>
              <p>
                This map uses OpenStreetMap tiles. Tile providers can see the map tile area viewed and normal network metadata. Privacy-zone interiors are excluded from road-data lookups, but visible map tiles still describe the area shown on screen.
              </p>
              <p>
                Settings warning margins change when Road Sage warns you; they do not change the saved speed itself.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
