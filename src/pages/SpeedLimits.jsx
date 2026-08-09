// @ts-check
import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';

// Lazy: the diagnostics workspace runs two of its own queries and is the least
// visited of the four, so it should not weigh on the map or review views.
const SpeedIntelligenceConsole = lazy(() => import('@/components/speedLimits/SpeedIntelligenceConsole'));
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, ArrowLeft, Download, Gauge, Info, Map as MapIcon, Plus, RefreshCw, ShieldCheck, SlidersHorizontal, Undo2, Upload } from 'lucide-react';
import { geohashEncode, LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';
import { refreshTripsCrossingLocalSpeedCorrection, refreshTripsForLocalSpeedKnowledgeChanges, tripCrossesCorrection } from '@/lib/localSpeedScoreRefresh';
import { correctionSectionIdentity } from '@/lib/roadSectionIdentity';
import { beginMeasure, TRIAGE_DISABLE_MAPS } from '@/lib/performanceTriage';
import {
  SPEED_MAP_LAYER_FAST_DEFAULTS,
  buildSpeedMapSections,
  buildSplitCorrections,
  buildSpeedZoneReviewItems,
  findOverlappingSpeedSections,
  findMergeableSpeedSection,
  filterSpeedMapSections,
  mergeTrustedSpeedMapSections,
  mergeSpeedSections,
  snapSectionPointsToTripRoutesWithStats,
  speedMapSectionFlags,
  summarizeSpeedMapSections,
} from '@/lib/speedLimitMapSections';
import {
  summarizeTripScoreDeltas,
} from '@/lib/speedLimitDisplay';
import { tripService } from '@/api/trips';
import { getHydratedPrivacyZones, getPrivacyZones } from '@/lib/privacyZones';
import useLocalSettings from '@/hooks/useLocalSettings';
import RoadSpeedCommandCenter from '@/components/RoadSpeedCommandCenter';
import SpeedRescoreStatus from '@/components/SpeedRescoreStatus';
import RoadMemoryIntelligencePanel from '@/components/RoadMemoryIntelligencePanel';
import {
  listSpeedSignEvidence,
  SPEED_SIGN_EVIDENCE_CHANGED_EVENT,
  syncNativeSpeedSignEvidence,
} from '@/lib/speedSignEvidence';
import { assessSpeedLimitEvidence } from '@/lib/speedLimitConfidence';
import {
  buildCorrectionImpactPreview,
  buildSpeedLimitRecommendation,
} from '@/lib/speedLimitIntelligence';
import {
  getNativeSpeedKnowledgeMirrorStatus,
  retryNativeSpeedKnowledgeMirror,
  speedKnowledgeStore,
} from '@/lib/speedKnowledgeRepository';
import { inspectSpeedKnowledgeHealth } from '@/lib/speedKnowledgeHealth';
import {
  isSpeedSectionExcluded,
  readExcludedSpeedSectionKeys,
  speedSectionExclusionKeys,
  writeExcludedSpeedSectionKeys,
} from '@/lib/speedSectionExclusions';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { isNativePlatform } from '@/lib/nativePlatform';
import { logSystemFailure } from '@/lib/systemLog';
import {
  buildSpeedMapModelCacheKey,
  readSpeedMapModelCache,
  writeSpeedMapModelCache,
} from '@/lib/speedMapModelCache';
import InlineRefreshBadge from '@/components/InlineRefreshBadge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/use-toast';
import { requestAppConfirm } from '@/lib/appDialog';
import {
  matchesSavedRoadSpeedFilter,
  savedRoadSpeedSearchText,
  sortSavedRoadSpeedRows,
} from '@/lib/savedRoadSpeedFilters';
import { backfillLocalRoadMemoryFromTripHistory } from '@/lib/roadMemoryCoordinator';
import {
  readSpeedGeometryIndex,
  rebuildSpeedGeometryIndex,
} from '@/lib/speedGeometryIndex';
import { buildLocalCorridorGraph, summarizeLocalCorridorGraph } from '@/lib/localCorridorGraph';
import { buildSpeedEvidenceDecision } from '@/lib/speedEvidenceReasoning';
import { sanitizeSpeedKnowledge } from '@/lib/dataBackup';
import { MAX_SAVED_SPEED_LIMIT_KMH } from '@/lib/speedKnowledgeCellPolicy';
import SpeedLimitSavedWorkspace from '@/components/speedLimits/SpeedLimitSavedWorkspace';
import SpeedLimitReviewWorkspace from '@/components/speedLimits/SpeedLimitReviewWorkspace';
import SpeedLimitMapWorkspace from '@/components/speedLimits/SpeedLimitMapWorkspace';
import {
  sourceLabel,
  formatSpeedLimit,
  formatSourceList,
  speedSectionAttentionLabel,
  directionLabel,
  tripLabel,
  undoActionText,
  speedStatusToast,
  mapSectionReasonText,
} from '@/components/speedLimits/speedRuleFormatting';
import {
  qualifierStatusForDraft,
  invalidCustomDayRule,
  validityFromDraft,
  qualifierDraftError,
  invalidValidityWindow,
  DEFAULT_MAP_DRAFT,
  mapDraftForSection,
  draftForCorrection,
  normalizeMapDraftForCompare,
  speedConflictCompareKey,
  timeRuleFromDraft,
} from '@/components/speedLimits/speedRuleDrafts';
import {
  sectionGeometryCompareKey,
  hasTracedRoadGeometry,
  distanceMeters,
  sectionLengthMeters,
  sectionMidpoint,
} from '@/components/speedLimits/speedRuleGeometry';
import {
  correctionKey,
  IGNORED_UNSET_SPEED_SECTIONS_STORAGE_KEY,
  speedRuleLifecycleAt,
  isUnsetMapSection,
  ignoredUnsetSectionKey,
  readIgnoredUnsetSectionKeys,
} from '@/components/speedLimits/speedRuleSections';
import {
  speedUnitLabel,
} from '@/lib/unitFormatting';
import {
  changedSavedSpeedDraftKeys,
  reconcileSavedSpeedDrafts,
} from '@/lib/speedLimitDraftReconciliation';

const SPEED_MAP_TRIP_BATCH_SIZE = 80;
const SPEED_RULE_EXPORT_PRIVACY_WARNING = [
  'This export contains precise road locations, map-line coordinates, and your saved speed rules.',
  'Store it securely and share it only with people you trust.',
  '',
  'Continue with the export?',
].join('\n');







const scheduleIdleWork = (callback) => {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const idleId = window.requestIdleCallback(callback, { timeout: 1200 });
    return () => window.cancelIdleCallback?.(idleId);
  }
  const timer = window.setTimeout(callback, 120);
  return () => window.clearTimeout(timer);
};




































const COMMON_SPEED_LIMITS_KMH = [30, 40, 50, 60, 70, 80, 100];
const SPEED_WORKSPACES = [
  { value: 'map', label: 'Map', Icon: MapIcon },
  { value: 'review', label: 'Needs review', Icon: AlertTriangle },
  { value: 'saved', label: 'Saved roads', Icon: SlidersHorizontal },
  // Absorbed from the former /tracking/speed page, which was a read-only view
  // of this page's data whose only navigation was three links back to here.
  { value: 'console', label: 'Diagnostics', Icon: Gauge },
];
const SPEED_WORKSPACE_VALUES = SPEED_WORKSPACES.map((workspace) => workspace.value);
const MAP_MODEL_WORKSPACES = new Set(['map', 'review']);









const downloadBrowserJson = (filename, payload) => {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: 'application/json;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const saveSpeedKnowledgeExport = async (filename, payload) => {
  const data = `${JSON.stringify(payload, null, 2)}\n`;
  if (isNativePlatform()) {
    try {
      const result = await saveExportToDownloads({
        filename,
        data,
        mimeType: 'application/json',
      });
      return { native: true, filename, uri: result?.uri || null };
    } catch (error) {
      logSystemFailure('speed_knowledge_native_export_failed', error, {
        filename,
        native_fallback: true,
      });
    }
  }
  downloadBrowserJson(filename, payload);
  return { native: false, filename };
};

function SavedRoadSpeedsSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading saved road speeds">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-96 max-w-[75vw]" />
        </div>
        <Skeleton className="h-9 w-24 rounded-xl" />
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-20 rounded-xl" />)}
      </div>
      <Skeleton className="h-12 rounded-2xl" />
      <div className="rounded-2xl border border-border bg-card p-3">
        <Skeleton className="h-[28rem] min-h-[22rem] rounded-xl" />
      </div>
      <div className="space-y-3">
        {[1, 2, 3].map((item) => (
          <div key={item} className="rounded-xl border border-border bg-card p-4">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="mt-3 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-4/5" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading saved road speeds</span>
    </div>
  );
}



export default function SpeedLimits() {
  const [searchParams] = useSearchParams();
  const tripId = searchParams.get('tripId');
  const initialWorkspace = SPEED_WORKSPACE_VALUES.includes(searchParams.get('view'))
    ? searchParams.get('view')
    : tripId ? 'review' : 'map';
  const knowledge = useMemo(() => new LocalSpeedKnowledge(speedKnowledgeStore), []);
  const [rows, setRows] = useState([]);
  const [drafts, setDrafts] = useState({});
  const dirtyDraftKeysRef = useRef(new Set());
  const persistedDraftBaselinesRef = useRef({});
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [mapModelState, setMapModelState] = useState(/** @type {any} */ ({
    status: 'idle',
    error: null,
    totalTripCount: 0,
    nextOffset: 0,
  }));
  const mapModelStateRef = useRef(/** @type {any} */ ({
    status: 'idle',
    error: null,
    totalTripCount: 0,
    nextOffset: 0,
  }));
  const [mapSectionBuildState, setMapSectionBuildState] = useState(/** @type {any} */ ({
    status: 'idle',
    durationMs: null,
  }));
  const [rawMapSections, setRawMapSections] = useState([]);
  const [mapMoreBusy, setMapMoreBusy] = useState(false);
  const [recalculationBusy, setRecalculationBusy] = useState(false);
  const recalculationCountRef = useRef(0);
  const loadedOnceRef = useRef(false);
  const [busyGeohash, setBusyGeohash] = useState(null);
  const [status, setStatus] = useState(/** @type {string | { message: string, scoreDeltas?: any[], canUndo?: boolean }} */ (''));
  const [linkedTrip, setLinkedTrip] = useState(null);
  const [mapTrips, setMapTrips] = useState([]);
  const [geometryIndexState, setGeometryIndexState] = useState({
    status: 'idle',
    indexedTripCount: 0,
    totalAvailable: 0,
    truncated: false,
  });
  const [roadMemoryCandidates, setRoadMemoryCandidates] = useState([]);
  const [smartProtection, setSmartProtection] = useState({
    confirmedCorridorCount: 0,
    suppressedSuggestionCount: 0,
  });
  const [memoryHistorySync, setMemoryHistorySync] = useState({
    status: 'idle',
    scannedTripCount: 0,
    observationCount: 0,
  });
  const [cameraReviewCount, setCameraReviewCount] = useState(0);
  const [selectedSection, setSelectedSection] = useState(null);
  const [addMode, setAddMode] = useState(false);
  const [addPath, setAddPath] = useState([]);
  const [mapQuery, setMapQuery] = useState('');
  const deferredMapQuery = useDeferredValue(mapQuery);
  const [mapLayers, setMapLayers] = useState(SPEED_MAP_LAYER_FAST_DEFAULTS);
  const [activeWorkspace, setActiveWorkspace] = useState(initialWorkspace);
  const [showAllAttention, setShowAllAttention] = useState(false);
  const [workspacePending, startWorkspaceTransition] = useTransition();
  const [autoSnapTrace, setAutoSnapTrace] = useState(true);
  const [ignoredUnsetSectionKeys, setIgnoredUnsetSectionKeys] = useState(readIgnoredUnsetSectionKeys);
  const [excludedSpeedSectionKeys, setExcludedSpeedSectionKeys] = useState(readExcludedSpeedSectionKeys);
  const [persistedExcludedSpeedSections, setPersistedExcludedSpeedSections] = useState([]);
  const [rowQueryInput, setRowQueryInput] = useState('');
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [rowFilter, setRowFilter] = useState('all');
  const [rowSort, setRowSort] = useState('updated');
  const deferredRowQuery = useDeferredValue(rowQueryInput);
  const deferredRowFilter = useDeferredValue(rowFilter);
  const deferredRowSort = useDeferredValue(rowSort);
  const isRowQueryPending = deferredRowQuery !== rowQueryInput ||
    deferredRowFilter !== rowFilter || deferredRowSort !== rowSort;
  const [selectedRows, setSelectedRows] = useState(() => new Set());
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' });
  const [health, setHealth] = useState(null);
  const [nativeMirrorHealth, setNativeMirrorHealth] = useState(() => getNativeSpeedKnowledgeMirrorStatus());
  const [nativeMirrorRetrying, setNativeMirrorRetrying] = useState(false);
  const [lifecycleNow, setLifecycleNow] = useState(() => Date.now());
  const restoreInputRef = useRef(null);
  const reviewWorkspaceRef = useRef(null);
  const reviewInventoryRef = useRef(null);
  const learningInventoryRef = useRef(null);
  const knowledgeReloadTimerRef = useRef(null);
  const mapTripsLoadRef = useRef(0);
  const mapModelCancelRef = useRef(null);
  const mapModelWorkerRef = useRef(null);
  const mapSectionBuildRequestRef = useRef(0);
  const savedRowsListRef = useRef(null);
  const lastStatusToastRef = useRef('');
  const selectedMapEditSnapshotRef = useRef(null);
  const legacyExclusionMigrationRef = useRef(new Set());
  const [mapDraft, setMapDraft] = useState(DEFAULT_MAP_DRAFT);
  const settings = useLocalSettings();
  const units = settings.units === 'imperial' ? 'imperial' : 'metric';
  const speedUnit = speedUnitLabel(units);
  const speedQuickPicks = units === 'imperial'
    ? [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70]
    : COMMON_SPEED_LIMITS_KMH;
  const privacyZones = useMemo(() => getPrivacyZones(settings), [settings]);
  const tripEvidenceLayersRequested = activeWorkspace === 'review' || (
    activeWorkspace === 'map' && (
      mapLayers.conflicts ||
      mapLayers.learned ||
      mapLayers.observed ||
      mapLayers.unset
    )
  );
  const mapModelActive = MAP_MODEL_WORKSPACES.has(activeWorkspace) && tripEvidenceLayersRequested;
  const mapModelLoading = mapModelState.status === 'loading';
  const mapModelLoaded = mapModelState.status === 'loaded' && mapSectionBuildState.status === 'ready';
  const mapQueryPending = mapQuery !== deferredMapQuery;
  const switchWorkspace = useCallback((workspace) => {
    startWorkspaceTransition(() => setActiveWorkspace(workspace));
  }, []);
  const ignoredUnsetSectionKeySet = useMemo(() => new Set(ignoredUnsetSectionKeys), [ignoredUnsetSectionKeys]);
  const excludedSpeedSectionKeySet = useMemo(() => new Set(excludedSpeedSectionKeys), [excludedSpeedSectionKeys]);
  const currentMapRows = useMemo(
    () => rows.filter((row) => speedRuleLifecycleAt(row, lifecycleNow) === 'active'),
    [lifecycleNow, rows]
  );
  useEffect(() => {
    const now = Date.now();
    const nextBoundary = rows
      .flatMap((row) => [row.validFrom, row.expiresAt])
      .map((value) => value ? new Date(value).getTime() : Number.NaN)
      .filter((time) => Number.isFinite(time) && time > now)
      .sort((a, b) => a - b)[0];
    if (!Number.isFinite(nextBoundary)) return undefined;
    const timer = window.setTimeout(
      () => setLifecycleNow(Date.now()),
      Math.max(25, Math.min(2_147_000_000, nextBoundary - now + 25))
    );
    return () => window.clearTimeout(timer);
  }, [lifecycleNow, rows]);
  const trustedMapSections = useMemo(
    () => buildSpeedMapSections(
      [],
      currentMapRows,
      activeWorkspace === 'review' || mapLayers.learned ? roadMemoryCandidates : []
    ),
    [activeWorkspace, currentMapRows, mapLayers.learned, roadMemoryCandidates]
  );
  const completeRawMapSections = useMemo(
    () => mergeTrustedSpeedMapSections(rawMapSections, trustedMapSections),
    [rawMapSections, trustedMapSections]
  );
  const visibleRawMapSections = useMemo(() => completeRawMapSections.filter((section) => (
    (section.saved || !isSpeedSectionExcluded(section, excludedSpeedSectionKeySet)) &&
    (
      !isUnsetMapSection(section) ||
      !ignoredUnsetSectionKeySet.has(ignoredUnsetSectionKey(section))
    )
  )), [completeRawMapSections, excludedSpeedSectionKeySet, ignoredUnsetSectionKeySet]);
  const graphInputSections = useMemo(
    () => filterSpeedMapSections(visibleRawMapSections, { layers: mapLayers }),
    [mapLayers, visibleRawMapSections]
  );
  const completeCorridorGraph = useMemo(
    () => buildLocalCorridorGraph(visibleRawMapSections),
    [visibleRawMapSections]
  );
  const knowledgeSections = useMemo(
    () => completeCorridorGraph.sections.filter((section) => !section.graphDuplicateOf),
    [completeCorridorGraph.sections]
  );
  const corridorGraph = useMemo(
    () => buildLocalCorridorGraph(graphInputSections),
    [graphInputSections]
  );
  const corridorGraphSummary = useMemo(
    () => summarizeLocalCorridorGraph(corridorGraph),
    [corridorGraph]
  );
  const mapSections = useMemo(
    () => corridorGraph.sections.filter((section) => !section.graphDuplicateOf),
    [corridorGraph.sections]
  );
  const hiddenUnsetSectionCount = useMemo(() => completeRawMapSections.filter((section) => (
    isUnsetMapSection(section) &&
    ignoredUnsetSectionKeySet.has(ignoredUnsetSectionKey(section))
  )).length, [completeRawMapSections, ignoredUnsetSectionKeySet]);
  const excludedSpeedSectionCount = useMemo(() => Math.max(
    persistedExcludedSpeedSections.length,
    completeRawMapSections.filter((section) => (
      isSpeedSectionExcluded(section, excludedSpeedSectionKeySet)
    )).length
  ), [completeRawMapSections, excludedSpeedSectionKeySet, persistedExcludedSpeedSections.length]);
  const mapStats = useMemo(() => summarizeSpeedMapSections(mapSections), [mapSections]);
  // Prepared sections contain the full indexed history. The Leaflet component
  // only needs a small recent route sample for centering and edit assistance.
  const mapDisplayTrips = useMemo(
    () => mapTrips.slice(0, SPEED_MAP_TRIP_BATCH_SIZE),
    [mapTrips]
  );
  const activeManualRows = currentMapRows;
  const historicalRuleCount = rows.filter((row) => row.historicalVersion === true).length;
  const scheduledOrExpiredRuleCount = Math.max(0, rows.length - activeManualRows.length - historicalRuleCount);
  const postedRuleCount = useMemo(
    () => activeManualRows.filter((row) => row?.source === 'user_confirmed_posted_sign').length,
    [activeManualRows]
  );
  const operationalMemoryCount = useMemo(
    () => roadMemoryCandidates.filter((candidate) => candidate?.canAffectScoreAndAlerts === true).length,
    [roadMemoryCandidates]
  );
  const estimatedRuleCount = Math.max(0, activeManualRows.length - postedRuleCount) + operationalMemoryCount;
  const savedRowsNeedingReviewCount = useMemo(
    () => activeManualRows.filter((row) => assessSpeedLimitEvidence(row).needsReview).length,
    [activeManualRows]
  );
  const learningMemoryCandidates = useMemo(
    () => roadMemoryCandidates.filter((candidate) => (
      candidate?.usageStage === 'learning' || candidate?.usageStage === 'shadow'
    )),
    [roadMemoryCandidates]
  );
  const staleMemoryCount = useMemo(
    () => roadMemoryCandidates.filter((candidate) => candidate?.stage === 'stale').length,
    [roadMemoryCandidates]
  );
  const memoryChangeReviewCount = useMemo(
    () => roadMemoryCandidates.filter((candidate) => candidate?.stage === 'change_review').length,
    [roadMemoryCandidates]
  );
  const reviewInventory = useMemo(() => {
    const manualRules = activeManualRows.map((row) => ({
      key: `saved-${correctionKey(row)}`,
      kind: 'saved',
      focusKind: 'review',
      title: row.roadName || `Saved road ${String(row.geohash || '').slice(0, 6)}`,
      detail: `${formatSpeedLimit(row.limitKmh, units)} · ${sourceLabel(row.source)}`,
      badge: row.source === 'user_confirmed_posted_sign' ? 'Saved posted' : 'Saved estimate',
      tone: row.source === 'user_confirmed_posted_sign' ? 'violet' : 'emerald',
      section: {
        ...row,
        saved: true,
        effectiveLimitKmh: Number(row.limitKmh) || null,
      },
    }));
    const learnedRules = roadMemoryCandidates.map((candidate) => {
      const stage = candidate?.stage || 'learning';
      const stageDetail = candidate?.canAffectScoreAndAlerts === true
        ? `validated local estimate from ${Number(candidate.tripCount) || 0} drives`
        : candidate?.usageStage === 'shadow'
          ? `shadow estimate from ${Number(candidate.tripCount) || 0} drives · blocked from scores and alerts`
        : stage === 'change_review'
          ? `possible change ${formatSpeedLimit(candidate.changeDetection?.previousLimitKmh, units)} → ${formatSpeedLimit(candidate.changeDetection?.proposedLimitKmh, units)}`
          : stage === 'stale'
            ? `stale after ${Number(candidate.ageDays) || 0} days`
            : `${Number(candidate.tripCount) || 0} drives · not used for scores yet`;
      const badge = candidate?.canAffectScoreAndAlerts === true
        ? 'Validated Road Memory'
        : candidate?.usageStage === 'shadow'
          ? 'Shadow check'
        : stage === 'change_review'
          ? 'Possible change'
          : stage === 'stale'
            ? 'Stale'
            : stage === 'suggested'
              ? 'Almost ready'
              : 'Learning';
      return {
        key: `learned-${candidate.id || candidate.sectionKey || candidate.geohash}`,
        kind: 'learned',
        focusKind: stage === 'change_review' || stage === 'stale' ? 'memoryReview' : 'observed',
        title: candidate.roadName || `Learned road ${String(candidate.geohash || '').slice(0, 6)}`,
        detail: `${formatSpeedLimit(candidate.limitKmh, units)} · ${stageDetail}`,
        badge,
        tone: candidate?.canAffectScoreAndAlerts === true
          ? 'sky'
          : stage === 'change_review'
            ? 'amber'
            : stage === 'stale'
              ? 'slate'
              : 'cyan',
        section: {
          ...candidate,
          saved: false,
          operational: stage === 'operational',
          roadMemoryCandidate: true,
          source: 'local_road_memory',
          effectiveLimitKmh: Number(candidate.limitKmh) || null,
        },
      };
    });
    const query = knowledgeQuery.trim().toLowerCase();
    return [...manualRules, ...learnedRules].filter((item) => (
      !query || `${item.title} ${item.detail} ${item.badge}`.toLowerCase().includes(query)
    )).map((item) => ({
      ...item,
      intelligence: buildSpeedEvidenceDecision(item.section),
    })).sort((a, b) => (
      b.intelligence.reviewUrgency - a.intelligence.reviewUrgency ||
      a.title.localeCompare(b.title) || a.detail.localeCompare(b.detail)
    ));
  }, [activeManualRows, knowledgeQuery, roadMemoryCandidates, units]);
  const reviewInventoryVirtualizer = useVirtualizer({
    count: reviewInventory.length,
    getScrollElement: () => reviewInventoryRef.current,
    estimateSize: () => 68,
    overscan: 6,
  });
  const learningInventoryVirtualizer = useVirtualizer({
    count: learningMemoryCandidates.length,
    getScrollElement: () => learningInventoryRef.current,
    estimateSize: () => 76,
    overscan: 6,
  });
  const conflictsByGeohash = useMemo(() => new Map(
    knowledgeSections
      .filter((section) => section.conflict)
      .map((section) => [correctionKey(section), section.conflict])
  ), [knowledgeSections]);
  const filteredRows = useMemo(() => {
    const query = deferredRowQuery.trim().toLowerCase();
    const items = rows
      .map((row) => ({ row, conflict: conflictsByGeohash.get(correctionKey(row)) || null }))
      .filter(({ row, conflict }) => matchesSavedRoadSpeedFilter(row, conflict, deferredRowFilter))
      .filter(({ row, conflict }) => !query || savedRoadSpeedSearchText(row, conflict).includes(query));
    return sortSavedRoadSpeedRows(items, deferredRowSort).map(({ row }) => row);
  }, [conflictsByGeohash, deferredRowFilter, deferredRowQuery, deferredRowSort, rows]);
  const updateRowQuery = (value) => setRowQueryInput(value);
  const updateRowFilter = (value) => setRowFilter(value);
  const updateRowSort = (value) => setRowSort(value);
  const revealSavedSpeedMapLayer = useCallback((source = 'user_entered_estimate') => {
    const posted = source === 'user_confirmed_posted_sign';
    setMapLayers((current) => ({
      ...current,
      conflicts: true,
      saved: true,
      observed: false,
      unset: false,
      posted: posted ? true : current.posted,
      estimates: posted ? current.estimates : true,
    }));
  }, []);
  const revealSavedRowsFilter = useCallback((source = 'user_entered_estimate') => {
    const posted = source === 'user_confirmed_posted_sign';
    setRowFilter((current) => {
      if (current === 'estimates' && posted) return 'posted';
      if (current === 'posted' && !posted) return 'estimates';
      return current;
    });
  }, []);
  const rowCardModels = useMemo(() => (
    filteredRows.map((row) => {
      const key = correctionKey(row);
      const draft = drafts[key] || {};
      const conflict = conflictsByGeohash.get(key) || null;
      return {
        key,
        row,
        draft,
        disabled: busyGeohash === key || row.historicalVersion === true,
        identity: correctionSectionIdentity(row, linkedTrip),
        conflict,
        evidence: assessSpeedLimitEvidence(row),
        recommendation: buildSpeedLimitRecommendation({ ...row, conflict }),
      };
    })
  ), [busyGeohash, conflictsByGeohash, drafts, filteredRows, linkedTrip]);
  const savedRowsVirtualizer = useVirtualizer({
    count: rowCardModels.length,
    getScrollElement: () => savedRowsListRef.current,
    estimateSize: () => 300,
    overscan: 3,
  });
  const virtualRowItems = savedRowsVirtualizer.getVirtualItems();
  const visibleRows = useMemo(
    () => virtualRowItems.map((item) => filteredRows[item.index]).filter(Boolean),
    [filteredRows, virtualRowItems]
  );
  const visibleRowImpactByKey = useMemo(() => {
    if (!mapModelLoaded || !mapTrips.length) return new Map();
    const entries = [];
    virtualRowItems.forEach((item) => {
      const model = rowCardModels[item.index];
      if (!model) return;
      const { key, row, draft } = model;
      entries.push([key, buildCorrectionImpactPreview(mapTrips, {
        ...row,
        limitKmh: Number(draft.limitKmh || row.limitKmh),
        qualifierStatus: qualifierStatusForDraft({ ...row, ...draft }),
        directionMode: draft.directionMode || row.directionMode,
        timeRule: timeRuleFromDraft(draft),
      }, draft.limitKmh || row.limitKmh)]);
    });
    return new Map(entries);
  }, [mapModelLoaded, mapTrips, rowCardModels, virtualRowItems]);
  const firstConflictSection = useMemo(
    () => knowledgeSections.find((section) => section.conflict),
    [knowledgeSections]
  );
  const speedZoneReviewItems = useMemo(() => (
    buildSpeedZoneReviewItems(knowledgeSections)
      .filter((item) => (
        Number(item?.section?.confirmedObservedLimits?.length) > 0 ||
        (item?.section?.observedSources || []).some((source) => (
          source === 'user_confirmed_posted_sign' || source === 'camera_sign_confirmed'
        ))
      ))
      .map((item) => ({
        ...item,
        title: item.section.roadName || `Trip speed zone ${item.zoneIndex}`,
        detail: `Zone ${item.zoneIndex} of ${item.zoneCount}: observed ${formatSpeedLimit(item.limitKmh, units)} from ${formatSourceList(item.section.observedSources)}. Save or adjust this segment separately.`,
      }))
  ), [knowledgeSections, units]);
  const attentionItems = useMemo(() => {
    const conflicts = knowledgeSections
      .filter((section) => section.conflict)
      .map((section) => ({
        key: `conflict-${correctionKey(section)}`,
        kind: 'conflict',
        title: section.roadName || `Road area ${section.geohash}`,
        detail: `Saved ${formatSpeedLimit(section.conflict.savedLimitKmh, units)}, observed ${formatSpeedLimit(section.conflict.observedLimitKmh, units)}`,
        section,
      }));
    const reviewableSaved = knowledgeSections
      .filter((section) => {
        if (!section.saved || section.conflict) return false;
        const flags = speedMapSectionFlags(section);
        return flags.expired ||
          flags.expiring ||
          flags.stale ||
          flags.lowConfidence ||
          flags.missingGeometry;
      })
      .map((section) => ({
        key: `review-${correctionKey(section)}`,
        kind: 'review',
        title: section.roadName || `Road area ${section.geohash}`,
        detail: `${speedSectionAttentionLabel(section)}; saved ${formatSpeedLimit(section.limitKmh, units)} from ${sourceLabel(section.source)}`,
        section,
      }));
    const memoryChanges = knowledgeSections
      .filter((section) => (
        section.roadMemoryCandidate &&
        (section.stage === 'change_review' || section.stage === 'stale')
      ))
      .map((section) => ({
        key: `memory-review-${correctionKey(section)}`,
        kind: 'memoryReview',
        title: section.roadName || `Road area ${section.geohash}`,
        detail: section.stage === 'change_review'
          ? `Possible speed change: ${formatSpeedLimit(section.changeDetection?.previousLimitKmh, units)} to ${formatSpeedLimit(section.changeDetection?.proposedLimitKmh, units)}; confirmation needed`
          : `This previously active local estimate is stale and needs fresh evidence.`,
        section,
      }));
    return [...conflicts, ...speedZoneReviewItems, ...reviewableSaved, ...memoryChanges];
  }, [knowledgeSections, speedZoneReviewItems, units]);
  const visibleAttentionItems = showAllAttention ? attentionItems : attentionItems.slice(0, 24);
  const selectedSectionPointCount = selectedSection?.sectionPoints?.length || 0;
  const traceLengthM = useMemo(() => sectionLengthMeters(addPath), [addPath]);
  const traceQuality = useMemo(() => {
    if (!addMode) return null;
    if (addPath.length < 2) return { level: 'warn', text: autoSnapTrace ? 'Tap the start and end of the road segment.' : 'Tap at least two points along the road.' };
    if (traceLengthM < 25) return { level: 'warn', text: 'Trace a longer section so the saved rule matches real driving.' };
    if (!mapTrips.some((trip) => Array.isArray(trip?.route_points) && trip.route_points.length > 0)) {
      return { level: 'info', text: 'No recorded trip route is available for snapping; review the line carefully.' };
    }
    return {
      level: 'good',
      text: autoSnapTrace && addPath.length > 2
        ? `Route assist built a ${Math.round(traceLengthM)} m trace from recorded geometry.`
        : `Ready to save. The trace is about ${Math.round(traceLengthM)} m long.`,
    };
  }, [addMode, addPath.length, autoSnapTrace, mapTrips, traceLengthM]);
  const selectedCorrectionDraft = useMemo(() => selectedSection ? ({
    ...selectedSection,
    limitKmh: Number(mapDraft.limitKmh),
    source: mapDraft.source,
    qualifierStatus: qualifierStatusForDraft(mapDraft),
    directionMode: mapDraft.directionMode || 'both',
    timeRule: timeRuleFromDraft(mapDraft),
    ...validityFromDraft(mapDraft),
    sectionPoints: selectedSection.sectionPoints || addPath,
  }) : null, [addPath, mapDraft, selectedSection]);
  const selectedImpactPreview = useMemo(() => (
    selectedCorrectionDraft
      ? buildCorrectionImpactPreview(mapTrips, selectedCorrectionDraft, mapDraft.limitKmh)
      : null
  ), [mapDraft.limitKmh, mapTrips, selectedCorrectionDraft]);
  const selectedEvidence = useMemo(() => (
    selectedCorrectionDraft ? assessSpeedLimitEvidence(selectedCorrectionDraft) : null
  ), [selectedCorrectionDraft]);
  const selectedRecommendation = useMemo(() => (
    selectedCorrectionDraft
      ? buildSpeedLimitRecommendation(selectedCorrectionDraft, {
        observedLimitKmh: selectedSection?.observedLimitKmh,
      })
      : null
  ), [selectedCorrectionDraft, selectedSection?.observedLimitKmh]);
  const selectedOverlapChecks = useMemo(() => (
    selectedCorrectionDraft
      ? findOverlappingSpeedSections(selectedCorrectionDraft, knowledgeSections, {
        excludeKey: correctionKey(selectedSection),
      })
      : []
  ), [knowledgeSections, selectedCorrectionDraft, selectedSection]);
  const blockingOverlapChecks = useMemo(
    () => selectedOverlapChecks.filter((item) => item.severity === 'block'),
    [selectedOverlapChecks]
  );
  const selectedBlockingOverlap = blockingOverlapChecks[0] || null;
  const selectedSectionReason = useMemo(
    () => selectedSection ? mapSectionReasonText(selectedSection, addMode, units) : '',
    [addMode, selectedSection, units]
  );
  const canSaveSelectedMapSection = Boolean(selectedSection) && (
    selectedSection.saved || selectedSectionPointCount >= 2
  ) && blockingOverlapChecks.length === 0 &&
    !invalidValidityWindow(mapDraft) &&
    !invalidCustomDayRule(mapDraft) &&
    !qualifierDraftError(mapDraft);
  const mergeCandidate = useMemo(() => (
    selectedSection?.saved
      ? findMergeableSpeedSection(selectedSection, knowledgeSections)
      : null
  ), [knowledgeSections, selectedSection]);
  const editorWarnings = useMemo(() => {
    if (!selectedSection) return [];
    const warnings = [];
    if (blockingOverlapChecks.length > 0) {
      const overlap = blockingOverlapChecks[0];
      warnings.push(`Blocked: this section overlaps ${overlap.roadName || 'another saved section'} saved at ${formatSpeedLimit(overlap.limitKmh, units)}. Split, merge, or edit the existing rule first.`);
    } else if (selectedOverlapChecks.length > 0) {
      const overlap = selectedOverlapChecks[0];
      warnings.push(`This geometry overlaps ${overlap.roadName || 'another saved section'} (${formatSpeedLimit(overlap.limitKmh, units)}). Save only if the direction or time rule makes it distinct.`);
    }
    if ((selectedSection.sectionPoints || []).length < 2) warnings.push('Trace at least two points to define a road section.');
    if (addMode && traceLengthM > 0 && traceLengthM < 25) warnings.push('Trace a longer section before saving; very short rules are easy to match to the wrong road.');
    if (!String(mapDraft.roadName || selectedSection.roadName || '').trim()) warnings.push('Add a road name to make future review and merging more reliable.');
    if (mapDraft.source === 'user_confirmed_posted_sign' && !String(mapDraft.note || '').trim()) {
      warnings.push('Add a short confirmation note for the audit history.');
    }
    if (invalidValidityWindow(mapDraft)) {
      warnings.push('Effective from must be earlier than Active until.');
    }
    if (invalidCustomDayRule(mapDraft)) {
      warnings.push('Choose at least one active day for this custom schedule.');
    }
    const qualifierError = qualifierDraftError(mapDraft);
    if (qualifierError) warnings.push(qualifierError);
    if (selectedImpactPreview?.affectedTripCount === 0) warnings.push('No stored completed trips currently cross this rule.');
    if (selectedImpactPreview && selectedImpactPreview.affectedTripCount > 0 && selectedImpactPreview.matchedPointCount < 2) {
      warnings.push('Only one stored route sample matches this rule. Snap to route or trace a longer section before relying on it.');
    }
    return warnings;
    // mapDraft fields are listed individually on purpose: the draft object gets
    // a new identity on every keystroke, and recomputing the whole warning set
    // then is wasteful. The fields below cover everything invalidCustomDayRule
    // and qualifierDraftError read (timeRuleMode, customDays, qualifierStatus,
    // and the validity dates).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    addMode,
    blockingOverlapChecks,
    mapDraft.note,
    mapDraft.roadName,
    mapDraft.source,
    mapDraft.validFromDate,
    mapDraft.expiresAtDate,
    mapDraft.customDays,
    mapDraft.qualifierStatus,
    mapDraft.timeRuleMode,
    selectedImpactPreview,
    selectedOverlapChecks,
    selectedSection,
    traceLengthM,
    units,
  ]);
  const matchingTripsForCorrection = useCallback((correction) => (
    mapTrips.filter((trip) => trip?.status === 'completed' && tripCrossesCorrection(trip, correction))
  ), [mapTrips]);

  const removeSavedRowsFromView = useCallback((removedRows = []) => {
    const removedIds = new Set(
      removedRows
        .map((row) => row?.id || row?.ruleId || row?.sectionKey)
        .filter(Boolean)
    );
    const removedFallbackGeohashes = new Set(
      removedRows
        .filter((row) => !(row?.id || row?.ruleId || row?.sectionKey))
        .map((row) => row?.geohash)
        .filter(Boolean)
    );
    if (!removedIds.size && !removedFallbackGeohashes.size) return;
    const removedKeys = new Set(removedRows.map(correctionKey).filter(Boolean));
    removedKeys.forEach((key) => dirtyDraftKeysRef.current.delete(key));
    persistedDraftBaselinesRef.current = Object.fromEntries(
      Object.entries(persistedDraftBaselinesRef.current)
        .filter(([key]) => !removedKeys.has(key))
    );
    setDrafts((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !removedKeys.has(key))
    ));

    setRows((current) => current.filter((row) => (
      !removedIds.has(row?.id || row?.ruleId || row?.sectionKey) &&
      !removedFallbackGeohashes.has(row?.geohash)
    )));
    setSelectedRows((current) => {
      const next = new Set(current);
      removedRows.forEach((row) => next.delete(correctionKey(row)));
      return next;
    });
    setSelectedSection((current) => {
      if (!current?.saved) return current;
      const currentId = current.id || current.ruleId || current.sectionKey;
      return removedIds.has(currentId) || (!currentId && removedFallbackGeohashes.has(current.geohash))
        ? null
        : current;
    });
  }, []);

  const beginRecalculation = useCallback(() => {
    recalculationCountRef.current += 1;
    setRecalculationBusy(true);
    return () => {
      recalculationCountRef.current = Math.max(0, recalculationCountRef.current - 1);
      if (recalculationCountRef.current === 0) setRecalculationBusy(false);
    };
  }, []);

  const withRecalculation = useCallback(async (task) => {
    const finish = beginRecalculation();
    try {
      return await task();
    } finally {
      finish();
    }
  }, [beginRecalculation]);

  const buildRecalculationStatus = useCallback((message, beforeTrips = [], updatedTrips = null) => {
    if (!Array.isArray(updatedTrips)) return message;
    const updatedTripsWithQueue = /** @type {any} */ (updatedTrips);
    const queuedTripCount = Math.max(0, Number(updatedTripsWithQueue.queuedTripCount) || 0);
    return {
      message: queuedTripCount
        ? `${message} ${queuedTripCount} more matching trip${queuedTripCount === 1 ? ' is' : 's are'} safely queued in the background.`
        : message,
      scoreDeltas: summarizeTripScoreDeltas(beforeTrips, updatedTrips),
      trips: updatedTrips,
      queuedTripCount,
    };
  }, []);

  const withUndo = useCallback((nextStatus) => (
    typeof nextStatus === 'string'
      ? { message: nextStatus, canUndo: true }
      : { ...nextStatus, canUndo: true }
  ), []);

  const retryNativeMirror = useCallback(async () => {
    if (nativeMirrorRetrying) return;
    setNativeMirrorRetrying(true);
    try {
      const next = await retryNativeSpeedKnowledgeMirror();
      setNativeMirrorHealth(next);
      setStatus(next.state === 'synced'
        ? 'Background Android speed alerts now use the latest privacy-safe saved roads.'
        : 'Background speed syncing remains paused until privacy filtering is available.');
    } catch (error) {
      setNativeMirrorHealth(getNativeSpeedKnowledgeMirrorStatus());
      setStatus(error?.message || 'Background speed syncing could not be retried yet.');
    } finally {
      setNativeMirrorRetrying(false);
    }
  }, [nativeMirrorRetrying]);

  useEffect(() => {
    if (!isNativePlatform() || nativeMirrorHealth.state !== 'unknown') return;
    void retryNativeMirror();
  }, [nativeMirrorHealth.state, retryNativeMirror]);

  const loadRows = useCallback(async ({ silent = false } = {}) => {
    const firstLoad = !loadedOnceRef.current;
    if (firstLoad && !silent) setLoading(true);
    else if (!silent) setRefreshing(true);
    const snapshot = await knowledge.getSpeedLimitsSnapshot().catch(() => ({
      rows: [],
      candidates: [],
      history: { canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' },
      rawKnowledge: { cells: {}, corrections: [] },
      exclusions: [],
      protection: { confirmedCorridorCount: 0, suppressedSuggestionCount: 0 },
    }));
    const nextRows = snapshot.rows;
    const nextCandidates = snapshot.candidates;
    const nextHistory = snapshot.history;
    const rawKnowledge = snapshot.rawKnowledge;
    const nextExclusions = snapshot.exclusions;
    setSmartProtection(snapshot.protection || {
      confirmedCorridorCount: 0,
      suppressedSuggestionCount: 0,
    });
    const safeRows = (Array.isArray(nextRows) ? nextRows : []).filter(Boolean);
    setRows(safeRows);
    setRoadMemoryCandidates((Array.isArray(nextCandidates) ? nextCandidates : []).filter(Boolean));
    const safeExclusions = (Array.isArray(nextExclusions) ? nextExclusions : []).filter(Boolean);
    setPersistedExcludedSpeedSections(safeExclusions);
    setExcludedSpeedSectionKeys((current) => [
      ...new Set([
        ...current,
        ...safeExclusions.flatMap(speedSectionExclusionKeys),
      ]),
    ]);
    setHistoryState(nextHistory);
    setHealth(inspectSpeedKnowledgeHealth(rawKnowledge));
    setNativeMirrorHealth(getNativeSpeedKnowledgeMirrorStatus());
    setSelectedRows((current) => new Set([...current].filter((key) => (
      safeRows.some((row) => correctionKey(row) === key && row.historicalVersion !== true)
    ))));
    const previousBaselines = persistedDraftBaselinesRef.current;
    /** @type {Record<string, any>} */
    const nextBaselines = {};
    safeRows.forEach((row) => {
      const key = correctionKey(row);
      if (key) nextBaselines[key] = draftForCorrection(row);
    });
    setDrafts((current) => {
      const dirtyKeys = changedSavedSpeedDraftKeys({
        current,
        baselines: previousBaselines,
        rows: safeRows,
        keyForRow: correctionKey,
        normalizeDraft: normalizeMapDraftForCompare,
      });
      dirtyDraftKeysRef.current = dirtyKeys;
      return reconcileSavedSpeedDrafts({
        current,
        rows: safeRows,
        dirtyKeys,
        keyForRow: correctionKey,
        draftForRow: draftForCorrection,
      });
    });
    persistedDraftBaselinesRef.current = nextBaselines;
    loadedOnceRef.current = true;
    setLoadedOnce(true);
    if (!silent) {
      setLoading(false);
      setRefreshing(false);
    }
  }, [knowledge]);

  const loadMapModel = useCallback(({ force = false } = {}) => {
    if (TRIAGE_DISABLE_MAPS || !loadedOnceRef.current) return;
    const currentStatus = mapModelStateRef.current.status;
    if (!force && (currentStatus === 'loading' || currentStatus === 'loaded')) return;
    mapModelCancelRef.current?.();
    const loadId = mapTripsLoadRef.current + 1;
    mapTripsLoadRef.current = loadId;
    mapModelStateRef.current = { status: 'loading', error: null };
    setMapModelState({ status: 'loading', error: null });
    setMapSectionBuildState({ status: 'idle', durationMs: null });
    if (force) {
      setMapTrips([]);
      setRawMapSections([]);
    }
    mapModelCancelRef.current = scheduleIdleWork(() => {
      Promise.all([
        tripService.listForSpeedMap({
          sort: '-start_time',
          offset: 0,
          limit: SPEED_MAP_TRIP_BATCH_SIZE,
        }),
        readSpeedGeometryIndex().catch(() => ({ trips: [], totalAvailable: 0, truncated: false })),
      ])
        .then(([result, geometryIndex]) => {
          if (mapTripsLoadRef.current !== loadId) return;
          const recentTrips = Array.isArray(result?.trips) ? result.trips : [];
          const indexedTrips = Array.isArray(geometryIndex?.trips) ? geometryIndex.trips : [];
          const byId = new Map(indexedTrips.map((trip) => [String(trip?.id), trip]));
          recentTrips.forEach((trip) => byId.set(String(trip?.id), trip));
          const safeTrips = [...byId.values()];
          setMapTrips(safeTrips);
          setGeometryIndexState({
            status: indexedTrips.length ? 'ready' : 'idle',
            indexedTripCount: indexedTrips.length,
            totalAvailable: Math.max(indexedTrips.length, Number(geometryIndex?.totalAvailable) || 0),
            truncated: geometryIndex?.truncated === true,
          });
          const nextState = {
            status: 'loaded',
            error: null,
            totalTripCount: Math.max(
              safeTrips.length,
              Number(result?.totalAvailable) || 0,
              Number(geometryIndex?.totalAvailable) || 0
            ),
            nextOffset: Math.max(safeTrips.length, Number(result?.nextOffset) || 0),
          };
          mapModelStateRef.current = nextState;
          setMapModelState(nextState);
        })
        .catch((error) => {
          if (mapTripsLoadRef.current !== loadId) return;
          setMapTrips([]);
          mapModelStateRef.current = { status: 'error', error };
          setMapModelState({ status: 'error', error });
        })
        .finally(() => {
          if (mapTripsLoadRef.current === loadId) mapModelCancelRef.current = null;
      });
    });
  }, []);

  const loadMoreMapTrips = useCallback(async () => {
    if (mapMoreBusy || mapModelStateRef.current.status !== 'loaded') return;
    const offset = Math.max(0, Number(mapModelStateRef.current.nextOffset) || mapTrips.length);
    const total = Math.max(0, Number(mapModelStateRef.current.totalTripCount) || 0);
    if (total > 0 && offset >= total) return;
    setMapMoreBusy(true);
    try {
      const result = await tripService.listForSpeedMap({
        sort: '-start_time',
        offset,
        limit: SPEED_MAP_TRIP_BATCH_SIZE,
      });
      const incoming = Array.isArray(result?.trips) ? result.trips : [];
      setMapTrips((current) => {
        const byId = new Map(current.map((trip) => [String(trip?.id), trip]));
        incoming.forEach((trip) => byId.set(String(trip?.id), trip));
        return [...byId.values()];
      });
      const nextState = {
        ...mapModelStateRef.current,
        status: 'loaded',
        error: null,
        totalTripCount: Math.max(
          Number(mapModelStateRef.current.totalTripCount) || 0,
          Number(result?.totalAvailable) || 0
        ),
        nextOffset: Math.max(offset + incoming.length, Number(result?.nextOffset) || 0),
      };
      mapModelStateRef.current = nextState;
      setMapModelState(nextState);
    } catch (error) {
      setStatus(error?.message || 'Older road evidence could not be loaded.');
    } finally {
      setMapMoreBusy(false);
    }
  }, [mapMoreBusy, mapTrips.length]);

  const syncRoadMemoryHistory = useCallback(async () => {
    if (memoryHistorySync.status === 'syncing') return;
    setMemoryHistorySync((current) => ({ ...current, status: 'syncing' }));
    try {
      const result = await backfillLocalRoadMemoryFromTripHistory();
      setMemoryHistorySync({
        status: 'ready',
        scannedTripCount: Number(result?.scannedTripCount) || 0,
        observationCount: Number(result?.observationCount) || 0,
      });
      await loadRows({ silent: true });
      if (mapModelActive) loadMapModel({ force: true });
    } catch (error) {
      setMemoryHistorySync((current) => ({ ...current, status: 'error' }));
      setStatus(error?.message || 'Stored trip history could not be scanned.');
      logSystemFailure('speed_limits_road_memory_history_backfill', error);
    }
  }, [loadMapModel, loadRows, mapModelActive, memoryHistorySync.status]);

  const loadFullGeometryHistory = useCallback(async () => {
    if (geometryIndexState.status === 'building') return;
    setGeometryIndexState((current) => ({ ...current, status: 'building' }));
    try {
      const index = await rebuildSpeedGeometryIndex();
      setGeometryIndexState({
        status: 'ready',
        indexedTripCount: Number(index?.indexedTripCount) || 0,
        totalAvailable: Number(index?.totalAvailable) || 0,
        truncated: index?.truncated === true,
      });
      setMapTrips((current) => {
        const byId = new Map((index?.trips || []).map((trip) => [String(trip?.id), trip]));
        current.forEach((trip) => byId.set(String(trip?.id), trip));
        return [...byId.values()];
      });
      const nextState = {
        ...mapModelStateRef.current,
        totalTripCount: Math.max(
          Number(mapModelStateRef.current.totalTripCount) || 0,
          Number(index?.totalAvailable) || 0
        ),
        nextOffset: Math.max(
          Number(mapModelStateRef.current.nextOffset) || 0,
          Number(index?.indexedTripCount) || 0
        ),
      };
      mapModelStateRef.current = nextState;
      setMapModelState(nextState);
    } catch (error) {
      setGeometryIndexState((current) => ({ ...current, status: 'error' }));
      setStatus(error?.message || 'Full road history could not be indexed.');
      logSystemFailure('speed_geometry_index_build', error);
    }
  }, [geometryIndexState.status]);

  const refreshRowsAndMap = useCallback(async ({ silent = false, forceMap = false } = {}) => {
    await loadRows({ silent });
    if (forceMap && (mapModelActive || mapModelStateRef.current.status !== 'idle')) {
      loadMapModel({ force: true });
    }
  }, [loadMapModel, loadRows, mapModelActive]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  useEffect(() => {
    let active = true;
    const refreshCameraReviewCount = async () => {
      await syncNativeSpeedSignEvidence().catch(() => null);
      const evidence = await listSpeedSignEvidence({ pendingOnly: false }).catch(() => []);
      if (active) setCameraReviewCount(Array.isArray(evidence) ? evidence.length : 0);
    };
    void refreshCameraReviewCount();
    const onEvidenceChanged = () => void refreshCameraReviewCount();
    window.addEventListener(SPEED_SIGN_EVIDENCE_CHANGED_EVENT, onEvidenceChanged);
    window.addEventListener('focus', onEvidenceChanged);
    return () => {
      active = false;
      window.removeEventListener(SPEED_SIGN_EVIDENCE_CHANGED_EVENT, onEvidenceChanged);
      window.removeEventListener('focus', onEvidenceChanged);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        IGNORED_UNSET_SPEED_SECTIONS_STORAGE_KEY,
        JSON.stringify([...new Set(ignoredUnsetSectionKeys)].slice(-500))
      );
    } catch {
      // Ignore storage failures; dismissing unset map hints is a convenience only.
    }
  }, [ignoredUnsetSectionKeys]);

  useEffect(() => {
    try {
      writeExcludedSpeedSectionKeys(excludedSpeedSectionKeys);
    } catch {
      // The engine exclusion is persisted with speed knowledge; these keys only
      // keep the map presentation in sync across reloads.
    }
  }, [excludedSpeedSectionKeys]);

  useEffect(() => {
    if (!completeRawMapSections.length || !excludedSpeedSectionKeys.length) return undefined;
    const persistedKeys = new Set(persistedExcludedSpeedSections.flatMap(speedSectionExclusionKeys));
    const legacyKeys = new Set(excludedSpeedSectionKeys);
    const migrations = new Map();

    completeRawMapSections.forEach((section) => {
      const matchingKeys = speedSectionExclusionKeys(section).filter((key) => legacyKeys.has(key));
      if (!matchingKeys.length || matchingKeys.some((key) => persistedKeys.has(key))) return;
      const migrationKey = matchingKeys[0];
      if (!legacyExclusionMigrationRef.current.has(migrationKey)) {
        migrations.set(migrationKey, { section, matchingKeys });
      }
    });
    if (!migrations.size) return undefined;

    migrations.forEach((_entry, key) => legacyExclusionMigrationRef.current.add(key));
    let cancelled = false;
    void (async () => {
      const beforeKnowledge = await knowledge.exportData().catch(() => null);
      const migrated = [];
      for (const [key, entry] of migrations) {
        try {
          const result = await knowledge.excludeSpeedSection({
            ...entry.section,
            exclusionKeys: entry.matchingKeys,
          });
          if (result && typeof result === 'object' && result.exclusion) {
            migrated.push(result.exclusion);
          }
        } catch (error) {
          legacyExclusionMigrationRef.current.delete(key);
          logSystemFailure('legacy_speed_exclusion_migration', error, { exclusion_key: key });
        }
      }
      if (!cancelled && migrated.length) {
        setPersistedExcludedSpeedSections((current) => [...current, ...migrated]);
        const afterKnowledge = await knowledge.exportData().catch(() => null);
        if (beforeKnowledge && afterKnowledge) {
          const updatedTrips = await refreshTripsForLocalSpeedKnowledgeChanges(
            beforeKnowledge,
            afterKnowledge
          ).catch(() => null);
          if (!cancelled) {
            const queuedCount = Math.max(
              0,
              Number(/** @type {any} */ (updatedTrips)?.queuedTripCount) || 0
            );
            setStatus(
              `Migrated ${migrated.length} private/parking exclusion${migrated.length === 1 ? '' : 's'} into protected saved-speed storage.` +
              (updatedTrips
                ? ` Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'}${queuedCount ? `; ${queuedCount} more queued` : ''}.`
                : ' Matching trip history will refresh when the queue resumes.')
            );
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    completeRawMapSections,
    excludedSpeedSectionKeys,
    knowledge,
    persistedExcludedSpeedSections,
  ]);

  useEffect(() => {
    if (!mapModelActive || mapModelState.status !== 'loaded') return undefined;
    const cacheKey = buildSpeedMapModelCacheKey(mapTrips, currentMapRows, roadMemoryCandidates);
    const cachedSections = readSpeedMapModelCache(cacheKey);
    if (cachedSections) {
      setRawMapSections(cachedSections);
      setMapSectionBuildState({ status: 'ready', durationMs: 0, source: 'memory-cache' });
      return undefined;
    }

    const requestId = mapSectionBuildRequestRef.current + 1;
    mapSectionBuildRequestRef.current = requestId;
    const endMeasure = beginMeasure('SpeedLimits.buildMapModel', {
      tripCount: mapTrips.length,
      correctionCount: currentMapRows.length,
      roadMemoryCandidateCount: roadMemoryCandidates.length,
    });
    let cancelled = false;
    let settled = false;
    let cancelFallback = null;
    setMapSectionBuildState({ status: 'building', durationMs: null });

    const commitSections = (sections, durationMs, source) => {
      if (cancelled || settled || requestId !== mapSectionBuildRequestRef.current) return;
      settled = true;
      const safeSections = Array.isArray(sections) ? sections : [];
      writeSpeedMapModelCache(cacheKey, safeSections);
      setRawMapSections(safeSections);
      setMapSectionBuildState({ status: 'ready', durationMs, source });
      endMeasure({ outcome: 'success', sectionCount: safeSections.length, source, workerDurationMs: durationMs });
    };

    const buildOnMainThreadWhenIdle = () => {
      if (cancelled || settled) return;
      cancelFallback = scheduleIdleWork(() => {
        try {
          const startedAt = performance.now();
          const sections = buildSpeedMapSections(mapTrips, currentMapRows, roadMemoryCandidates);
          commitSections(
            sections,
            Math.round((performance.now() - startedAt) * 10) / 10,
            'idle-main-thread'
          );
        } catch (error) {
          if (cancelled || settled) return;
          settled = true;
          setMapSectionBuildState({ status: 'error', durationMs: null, error });
          endMeasure({ outcome: 'error', error: error?.message || String(error) });
        }
      });
    };

    if (typeof Worker === 'undefined') {
      buildOnMainThreadWhenIdle();
    } else {
      try {
        if (!mapModelWorkerRef.current) {
          mapModelWorkerRef.current = new Worker(
            new URL('../workers/speedMapModel.worker.js', import.meta.url),
            { type: 'module' }
          );
        }
        const worker = mapModelWorkerRef.current;
        const onMessage = (event) => {
          if (event.data?.requestId !== requestId || cancelled || settled) return;
          if (event.data?.error) {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            buildOnMainThreadWhenIdle();
            return;
          }
          commitSections(event.data?.sections, event.data?.durationMs, 'worker');
        };
        const onError = () => {
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
          mapModelWorkerRef.current?.terminate();
          mapModelWorkerRef.current = null;
          buildOnMainThreadWhenIdle();
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.postMessage({
          requestId,
          trips: mapTrips,
          corrections: currentMapRows,
          roadMemoryCandidates,
        });
        return () => {
          cancelled = true;
          cancelFallback?.();
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
          endMeasure({ outcome: 'cancelled' });
        };
      } catch {
        mapModelWorkerRef.current?.terminate();
        mapModelWorkerRef.current = null;
        buildOnMainThreadWhenIdle();
      }
    }

    return () => {
      cancelled = true;
      cancelFallback?.();
      endMeasure({ outcome: 'cancelled' });
    };
  }, [currentMapRows, mapModelActive, mapModelState.status, mapTrips, roadMemoryCandidates]);

  useEffect(() => () => {
    mapModelCancelRef.current?.();
    mapModelWorkerRef.current?.terminate();
    mapModelWorkerRef.current = null;
  }, []);

  useEffect(() => {
    if (loadedOnce && mapModelActive) loadMapModel();
  }, [loadedOnce, loadMapModel, mapModelActive]);

  useEffect(() => {
    const nextToast = speedStatusToast(status);
    if (!nextToast) return;
    const key = `${nextToast.title}:${nextToast.description}`;
    if (lastStatusToastRef.current === key) return;
    lastStatusToastRef.current = key;
    toast(nextToast);
  }, [status]);

  useEffect(() => {
    if (!selectedSection?.saved) return;
    const selectedKey = correctionKey(selectedSection);
    const latestRow = rows.find((row) => (
      correctionKey(row) === selectedKey ||
      (!selectedKey && row.geohash === selectedSection.geohash)
    ));
    if (!latestRow) {
      setSelectedSection(null);
      setMapDraft(DEFAULT_MAP_DRAFT);
      selectedMapEditSnapshotRef.current = null;
      return;
    }

    const snapshot = selectedMapEditSnapshotRef.current;
    const editorIsPristine = snapshot?.key === selectedKey &&
      !selectedSection.pendingMerge &&
      !selectedSection.linkedGeometryEdits?.length &&
      sectionGeometryCompareKey(selectedSection) === snapshot.geometry &&
      normalizeMapDraftForCompare(mapDraft) === snapshot.draft;
    if (!editorIsPristine) return;

    const latestKnowledgeSection = knowledgeSections.find((section) => (
      correctionKey(section) === selectedKey ||
      (!selectedKey && section.geohash === selectedSection.geohash)
    ));
    const latestConflict = latestKnowledgeSection
      ? latestKnowledgeSection.conflict || null
      : selectedSection.conflict || null;
    const conflictChanged = speedConflictCompareKey(latestConflict) !==
      speedConflictCompareKey(selectedSection.conflict);

    const nextSection = {
      ...selectedSection,
      ...latestRow,
      saved: true,
      sectionPoints: Array.isArray(latestRow.sectionPoints) && latestRow.sectionPoints.length
        ? latestRow.sectionPoints
        : selectedSection.sectionPoints,
      conflict: latestConflict,
    };
    const nextDraft = mapDraftForSection(nextSection);
    const nextGeometry = sectionGeometryCompareKey(nextSection);
    const nextDraftKey = normalizeMapDraftForCompare(nextDraft);
    if (nextGeometry === snapshot.geometry && nextDraftKey === snapshot.draft && !conflictChanged) return;

    setSelectedSection(nextSection);
    setMapDraft(nextDraft);
    selectedMapEditSnapshotRef.current = {
      key: correctionKey(nextSection),
      saved: true,
      geometry: nextGeometry,
      draft: nextDraftKey,
    };
  }, [knowledgeSections, mapDraft, rows, selectedSection]);

  useEffect(() => {
    if (!selectedSection || !isUnsetMapSection(selectedSection)) return;
    if (ignoredUnsetSectionKeySet.has(ignoredUnsetSectionKey(selectedSection))) {
      setSelectedSection(null);
      setAddPath([]);
      setAddMode(false);
    }
  }, [ignoredUnsetSectionKeySet, selectedSection]);

  useEffect(() => {
    if (!selectedSection) return;
    if (isSpeedSectionExcluded(selectedSection, excludedSpeedSectionKeySet)) {
      setSelectedSection(null);
      setAddPath([]);
      setAddMode(false);
    }
  }, [excludedSpeedSectionKeySet, selectedSection]);

  useEffect(() => {
    savedRowsVirtualizer.scrollToIndex(0, { align: 'start' });
  }, [deferredRowFilter, deferredRowQuery, deferredRowSort, savedRowsVirtualizer]);

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
    const onKnowledgeChanged = () => {
      window.clearTimeout(knowledgeReloadTimerRef.current);
      knowledgeReloadTimerRef.current = window.setTimeout(() => {
        void refreshRowsAndMap({ silent: true });
      }, 200);
    };
    window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onKnowledgeChanged);
    return () => {
      window.clearTimeout(knowledgeReloadTimerRef.current);
      window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onKnowledgeChanged);
    };
  }, [refreshRowsAndMap]);

  const updateDraft = (geohash, patch) => {
    setDrafts((current) => {
      const nextDraft = {
        limitKmh: '',
        source: 'user_entered_estimate',
        note: '',
        roadName: '',
        ...(current[geohash] || {}),
        ...patch,
      };
      const baseline = persistedDraftBaselinesRef.current[geohash];
      if (baseline &&
        normalizeMapDraftForCompare(nextDraft) === normalizeMapDraftForCompare(baseline)) {
        dirtyDraftKeysRef.current.delete(geohash);
      } else {
        dirtyDraftKeysRef.current.add(geohash);
      }
      return { ...current, [geohash]: nextDraft };
    });
  };

  const saveRow = async (row) => {
    const key = correctionKey(row);
    const draft = drafts[key] || {};
    const limitKmh = Number(draft.limitKmh);
    if (!Number.isFinite(limitKmh) || limitKmh <= 0 || limitKmh > MAX_SAVED_SPEED_LIMIT_KMH) {
      setStatus('Enter a valid speed limit before saving.');
      return;
    }
    if (invalidValidityWindow(draft)) {
      setStatus('Effective from must be earlier than Active until.');
      return;
    }
    if (invalidCustomDayRule(draft)) {
      setStatus('Choose at least one active day for this custom schedule.');
      return;
    }
    const qualifierError = qualifierDraftError(draft);
    if (qualifierError) {
      setStatus(qualifierError);
      return;
    }
    setBusyGeohash(key);
    const updatedCorrection = {
      ...row,
      limitKmh: Math.round(limitKmh),
      source: draft.source || row.source || 'user_entered_estimate',
      qualifierStatus: qualifierStatusForDraft({ ...row, ...draft }),
      note: draft.note,
      roadName: String(draft.roadName ?? row.roadName ?? '').trim(),
      directionMode: draft.directionMode || 'both',
      timeRule: timeRuleFromDraft(draft),
      ...validityFromDraft(draft),
    };
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const beforeTrips = [
      ...new Map([
        ...matchingTripsForCorrection(row),
        ...matchingTripsForCorrection(updatedCorrection),
      ].map((trip) => [String(trip.id), trip])).values(),
    ];
    const saved = await knowledge.updateUserCorrection(
      key,
      Math.round(limitKmh),
      draft.source || row.source || 'user_entered_estimate',
      draft.note,
      {
        qualifierStatus: qualifierStatusForDraft({ ...row, ...draft }),
        directionMode: draft.directionMode || 'both',
        timeRule: timeRuleFromDraft(draft),
        ...validityFromDraft(draft),
        roadName: String(draft.roadName ?? row.roadName ?? '').trim(),
      }
    ).catch(() => false);
    if (saved) {
      dirtyDraftKeysRef.current.delete(key);
      const persistedDraft = draftForCorrection(updatedCorrection);
      persistedDraftBaselinesRef.current = {
        ...persistedDraftBaselinesRef.current,
        [key]: persistedDraft,
      };
      setDrafts((current) => ({
        ...current,
        [key]: persistedDraft,
      }));
      setRows((current) => current.map((item) => (
        correctionKey(item) === key
          ? { ...item, ...updatedCorrection, appliedAt: new Date().toISOString() }
          : item
      )));
      revealSavedRowsFilter(updatedCorrection.source);
      revealSavedSpeedMapLayer(updatedCorrection.source);
      setBusyGeohash(null);
      setStatus(withUndo('Saved road speed updated. Matching trip scores are updating in the background.'));
      void (async () => {
        const afterKnowledge = await knowledge.exportData().catch(() => null);
        const updatedTrips = await withRecalculation(() => (
          beforeKnowledge && afterKnowledge
            ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
            : refreshTripsCrossingLocalSpeedCorrection(updatedCorrection).catch(() => null)
        ));
        setStatus(withUndo(buildRecalculationStatus(
          updatedTrips
            ? `Saved road speed updated. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
            : 'Saved road speed updated, but matching trips could not be recalculated right now.',
          beforeTrips,
          updatedTrips
        )));
        await refreshRowsAndMap({ silent: true });
      })();
    } else {
      setStatus('Could not update that saved speed.');
      setBusyGeohash(null);
    }
  };

  const removeRow = async (row) => {
    const confirmed = await requestAppConfirm({
      title: 'Delete saved speed?',
      message: 'Delete this saved road speed?',
      confirmLabel: 'Delete speed',
      destructive: true,
    });
    if (!confirmed) return;
    const key = correctionKey(row);
    setBusyGeohash(key);
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const beforeTrips = matchingTripsForCorrection(row);
    const removed = await knowledge.removeUserCorrection(key).catch(() => false);
    if (removed) {
      dirtyDraftKeysRef.current.delete(key);
      const nextBaselines = { ...persistedDraftBaselinesRef.current };
      delete nextBaselines[key];
      persistedDraftBaselinesRef.current = nextBaselines;
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      removeSavedRowsFromView([row]);
      const afterKnowledge = await knowledge.exportData().catch(() => null);
      const updatedTrips = await withRecalculation(() => (
        beforeKnowledge && afterKnowledge
          ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
          : refreshTripsCrossingLocalSpeedCorrection(row).catch(() => null)
      ));
      setStatus(withUndo(buildRecalculationStatus(
        updatedTrips
          ? `Saved road speed removed. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} using remaining speed data and fallbacks.`
          : 'Saved road speed removed, but matching trips could not be recalculated right now.',
        beforeTrips,
        updatedTrips
      )));
      await refreshRowsAndMap();
    } else {
      setStatus('Could not remove that saved speed.');
    }
    setBusyGeohash(null);
  };

  const resolveSavedSpeedConflict = async (row, conflict, action, draft = {}) => {
    if (!row?.geohash || !conflict) return;
    if (invalidValidityWindow(draft)) {
      setStatus('Effective from must be earlier than Active until.');
      return;
    }
    if (invalidCustomDayRule(draft)) {
      setStatus('Choose at least one active day for this custom schedule.');
      return;
    }
    const qualifierError = qualifierDraftError({ ...row, ...draft });
    if (qualifierError) {
      setStatus(qualifierError);
      return;
    }
    const keepSaved = action === 'keep_saved';
    const nextLimitKmh = keepSaved
      ? Number(row.limitKmh)
      : Number(conflict.observedLimitKmh);
    if (!Number.isFinite(nextLimitKmh) || nextLimitKmh <= 0 || nextLimitKmh > MAX_SAVED_SPEED_LIMIT_KMH) {
      setStatus('Could not resolve this conflict because the speed value is missing.');
      return;
    }

    const nextCorrection = {
      ...row,
      limitKmh: Math.round(nextLimitKmh),
      // Accepting observed trip evidence is not the same as seeing a posted
      // sign. Preserve posted authority only when the user explicitly keeps
      // the already-confirmed saved value.
      source: keepSaved
        ? draft.source || row.source || 'user_entered_estimate'
        : 'user_entered_estimate',
      qualifierStatus: qualifierStatusForDraft({ ...row, ...draft }),
      note: draft.note ?? row.note ?? '',
      roadName: String(draft.roadName ?? row.roadName ?? '').trim(),
      directionMode: draft.directionMode || row.directionMode || 'both',
      timeRule: timeRuleFromDraft({ ...row, ...draft }),
      ...validityFromDraft(draft),
      sectionPoints: row.sectionPoints || [],
    };
    if (!hasTracedRoadGeometry(nextCorrection)) {
      setStatus('Trace at least two distinct points on the road map before resolving this speed conflict. Point-only rules cannot affect scores or alerts safely.');
      return;
    }
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const beforeTrips = [
      ...new Map([
        ...matchingTripsForCorrection(row),
        ...matchingTripsForCorrection(nextCorrection),
      ].map((trip) => [String(trip.id), trip])).values(),
    ];
    const key = correctionKey(row);
    setBusyGeohash(key);
    // Most visible conflicts compare a saved traced rule with completed-trip
    // evidence and have no coarse conflicted cell. Only ask the core to remove
    // a cell when that exact persisted conflict actually exists; otherwise the
    // saved conflictResolution marker is sufficient to keep the reviewed
    // decision from returning after reload.
    const persistedConflicts = await knowledge.getConflictedCells().catch(() => []);
    const exactConflictCell = persistedConflicts.find((cell) => (
      cell?.geohash && cell.geohash === String(conflict.geohash || row.geohash || '')
    ));
    const saved = await knowledge.updateUserCorrection(
      key,
      nextCorrection.limitKmh,
      nextCorrection.source,
      nextCorrection.note,
      {
        roadName: nextCorrection.roadName,
        sectionPoints: nextCorrection.sectionPoints,
        directionMode: nextCorrection.directionMode,
        qualifierStatus: nextCorrection.qualifierStatus,
        directionBearing: row.directionBearing,
        timeRule: nextCorrection.timeRule,
        validFrom: nextCorrection.validFrom,
        validFromDate: nextCorrection.validFromDate,
        expiresAt: nextCorrection.expiresAt,
        expiresAtDate: nextCorrection.expiresAtDate,
        ...(exactConflictCell ? { resolvesConflictGeohash: exactConflictCell.geohash } : {}),
        conflictResolution: {
          savedLimitKmh: conflict.savedLimitKmh,
          observedLimitKmh: conflict.observedLimitKmh,
          deltaKmh: conflict.deltaKmh,
          action: keepSaved ? 'kept_saved_limit' : 'used_observed_limit',
          note: keepSaved
            ? 'User kept the saved local road speed after reviewing the observed trip evidence.'
            : 'User replaced the saved local road speed with the reviewed observed trip evidence.',
        },
      }
    ).catch(() => false);

    if (!saved) {
      setBusyGeohash(null);
      setStatus('Could not resolve that speed conflict.');
      return;
    }

    dirtyDraftKeysRef.current.delete(key);
    const persistedDraft = draftForCorrection(nextCorrection);
    persistedDraftBaselinesRef.current = {
      ...persistedDraftBaselinesRef.current,
      [key]: persistedDraft,
    };
    setRows((current) => current.map((item) => (
      correctionKey(item) === key
        ? {
          ...item,
          ...nextCorrection,
          conflictResolution: {
            savedLimitKmh: conflict.savedLimitKmh,
            observedLimitKmh: conflict.observedLimitKmh,
            deltaKmh: conflict.deltaKmh,
            action: keepSaved ? 'kept_saved_limit' : 'used_observed_limit',
            resolvedAt: new Date().toISOString(),
          },
          appliedAt: new Date().toISOString(),
        }
        : item
    )));
    revealSavedRowsFilter(nextCorrection.source);
    revealSavedSpeedMapLayer(nextCorrection.source);
    setDrafts((current) => ({
      ...current,
      [key]: persistedDraft,
    }));
    if (correctionKey(selectedSection) === key) {
      const nextDraft = {
        ...mapDraft,
        limitKmh: String(nextCorrection.limitKmh),
        source: nextCorrection.source,
        note: nextCorrection.note,
        roadName: nextCorrection.roadName,
      };
      setSelectedSection((current) => current ? {
        ...current,
        ...nextCorrection,
        conflict: null,
        conflictResolution: {
          savedLimitKmh: conflict.savedLimitKmh,
          observedLimitKmh: conflict.observedLimitKmh,
          deltaKmh: conflict.deltaKmh,
          action: keepSaved ? 'kept_saved_limit' : 'used_observed_limit',
          resolvedAt: new Date().toISOString(),
        },
      } : current);
      setMapDraft(nextDraft);
      setMapEditorSnapshot({ ...selectedSection, ...nextCorrection, conflict: null }, nextDraft);
    }
    setBusyGeohash(null);

    if (keepSaved) {
      setStatus(withUndo(`Conflict resolved: kept the saved ${formatSpeedLimit(nextLimitKmh, units)} rule for this road section. Matching trip scores are updating in the background.`));
      void (async () => {
        const afterKnowledge = await knowledge.exportData().catch(() => null);
        const updatedTrips = beforeKnowledge && afterKnowledge
          ? await withRecalculation(() => (
            refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
          ))
          : [];
        setStatus(withUndo(buildRecalculationStatus(
          updatedTrips
            ? `Conflict resolved: kept the saved ${formatSpeedLimit(nextLimitKmh, units)} rule and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
            : `Conflict resolved: kept the saved ${formatSpeedLimit(nextLimitKmh, units)} rule, but matching trips could not be recalculated right now.`,
          beforeTrips,
          updatedTrips
        )));
        await refreshRowsAndMap({ silent: true });
      })();
      return;
    }

    setStatus(withUndo(`Conflict resolved: updated this road section to ${formatSpeedLimit(nextLimitKmh, units)}. Matching trip scores are updating in the background.`));
    void (async () => {
      const afterKnowledge = await knowledge.exportData().catch(() => null);
      const updatedTrips = await withRecalculation(() => (
        beforeKnowledge && afterKnowledge
          ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
          : refreshTripsCrossingLocalSpeedCorrection(nextCorrection).catch(() => null)
      ));
      setStatus(withUndo(buildRecalculationStatus(
        updatedTrips
          ? `Conflict resolved: updated this road section to ${formatSpeedLimit(nextLimitKmh, units)} and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
          : `Conflict resolved: updated this road section to ${formatSpeedLimit(nextLimitKmh, units)}, but matching trips could not be recalculated right now.`,
        beforeTrips,
        updatedTrips
      )));
      await refreshRowsAndMap({ silent: true });
    })();
  };

  const setMapEditorSnapshot = (section = null, draft = DEFAULT_MAP_DRAFT) => {
    selectedMapEditSnapshotRef.current = section
      ? {
        key: correctionKey(section),
        saved: section.saved === true,
        geometry: sectionGeometryCompareKey(section),
        draft: normalizeMapDraftForCompare(draft),
      }
      : null;
  };

  const mapEditorHasUnsavedChanges = () => {
    if (!selectedSection) return false;
    const snapshot = selectedMapEditSnapshotRef.current;
    if (addMode) {
      return addPath.length > 0 ||
        normalizeMapDraftForCompare(mapDraft) !== normalizeMapDraftForCompare(DEFAULT_MAP_DRAFT);
    }
    if (!snapshot) return false;
    const selectedKey = correctionKey(selectedSection);
    if (selectedKey !== snapshot.key) return false;
    if (selectedSection.pendingMerge || selectedSection.linkedGeometryEdits?.length) return true;
    return sectionGeometryCompareKey(selectedSection) !== snapshot.geometry ||
      normalizeMapDraftForCompare(mapDraft) !== snapshot.draft;
  };

  const confirmDiscardMapEditorChanges = async (actionText = 'switch sections') => {
    if (!mapEditorHasUnsavedChanges()) return true;
    const confirmed = await requestAppConfirm({
      title: 'Discard unsaved road speed edits?',
      message: `You have unsaved changes to this road speed. Save or update the road speed to keep the adjusted line.\n\nDiscard those edits and ${actionText}?`,
      confirmLabel: 'Discard edits',
      cancelLabel: 'Keep editing',
      destructive: true,
    });
    if (!confirmed) {
      setStatus('Kept the current road speed edits open. Update road speed to save the adjusted line.');
    }
    return confirmed;
  };

  const selectMapSection = async (section) => {
    if (!section) {
      setStatus('Select a saved or observed road section before editing.');
      return false;
    }
    const nextKey = correctionKey(section);
    if (selectedSection && nextKey === correctionKey(selectedSection) && mapEditorHasUnsavedChanges()) {
      setStatus('Kept the current road speed edits open. Update road speed to save the adjusted line.');
      return false;
    }
    if (selectedSection && nextKey !== correctionKey(selectedSection)) {
      const confirmed = await confirmDiscardMapEditorChanges('switch to another section');
      if (!confirmed) return false;
    }
    const nextDraft = mapDraftForSection(section);
    setSelectedSection(section);
    setMapDraft(nextDraft);
    setAddMode(false);
    setAddPath([]);
    setMapEditorSnapshot(section, nextDraft);
    return true;
  };

  const ignoreUnsetMapSection = () => {
    if (!selectedSection || !isUnsetMapSection(selectedSection)) {
      setStatus('Select an unset road section before hiding it.');
      return;
    }
    const key = ignoredUnsetSectionKey(selectedSection);
    if (!key) {
      setStatus('Could not hide this unset section because it has no stable map key.');
      return;
    }
    setIgnoredUnsetSectionKeys((current) => (
      current.includes(key) ? current : [...current, key]
    ));
    setSelectedSection(null);
    setAddPath([]);
    setAddMode(false);
    setStatus('Hidden this unset road section from the map and review list on this device.');
  };

  const restoreIgnoredUnsetMapSections = () => {
    setIgnoredUnsetSectionKeys([]);
    setStatus('Restored hidden unset road sections.');
  };

  const addExcludedSpeedSection = (section) => {
    const keys = speedSectionExclusionKeys(section);
    if (!keys.length) return false;
    setExcludedSpeedSectionKeys((current) => [...new Set([...current, ...keys])]);
    return true;
  };

  const restoreExcludedSpeedSections = async (selector = null) => {
    const restoreKey = selector
      ? `restore-excluded-${selector.id || selector.exclusionId || selector.geohash || 'section'}`
      : 'restore-excluded-sections';
    setBusyGeohash(restoreKey);
    const restored = await knowledge.restoreExcludedSpeedSections(selector).catch(() => null);
    if (!restored) {
      setBusyGeohash(null);
      setStatus('Could not allow learning on the parking/private sections right now.');
      return;
    }
    const remainingExclusions = await knowledge.listExcludedSpeedSections().catch(() => []);
    setPersistedExcludedSpeedSections(remainingExclusions);
    setExcludedSpeedSectionKeys([
      ...new Set(remainingExclusions.flatMap(speedSectionExclusionKeys)),
    ]);
    const replay = Number(restored.restoredCount) > 0
      ? await backfillLocalRoadMemoryFromTripHistory().catch((error) => ({ error }))
      : null;
    setBusyGeohash(null);
    await refreshRowsAndMap({ silent: true });
    const restoredCount = Number(restored.restoredCount) || 0;
    setStatus(restoredCount > 0
      ? `Allowed learning again on ${restoredCount} parking/private exclusion${restoredCount === 1 ? '' : 's'}. ` + (
        replay?.error
          ? 'The history replay could not finish; new drives can still rebuild evidence safely.'
          : `Scanned ${Number(replay?.scannedTripCount) || 0} eligible historical trip${Number(replay?.scannedTripCount) === 1 ? '' : 's'}${replay?.truncated ? ` of ${Number(replay.totalAvailable) || 'more'} available (older trips were not scanned)` : ''}. Saved speeds return only when the evidence earns them again.`
      )
      : 'There were no parking/private learning exclusions to restore.');
  };

  const markSelectedSectionPrivate = async () => {
    if (!selectedSection) {
      setStatus('Select a parking, driveway, or private-road section before marking it ignored.');
      return;
    }
    const keys = speedSectionExclusionKeys(selectedSection);
    if (!keys.length) {
      setStatus('Could not mark this section ignored because it has no stable geometry key.');
      return;
    }
    const confirmed = await requestAppConfirm({
      title: 'Mark private or parking?',
      message: selectedSection.saved
        ? 'Persistently block learning, matching, scores, and alerts here, and remove all related saved-speed knowledge?'
        : 'Persistently block learning, matching, scores, alerts, and future speed-review prompts on this section?',
      confirmLabel: 'Mark section',
    });
    if (!confirmed) return;

    const selectedKey = correctionKey(selectedSection);
    setBusyGeohash(selectedKey);
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const beforeTrips = matchingTripsForCorrection(selectedSection);
    const excluded = await knowledge.excludeSpeedSection({
      ...selectedSection,
      exclusionKeys: keys,
    }).catch(() => false);
    if (!excluded || typeof excluded !== 'object') {
      setBusyGeohash(null);
      setStatus('Could not persist this parking/private exclusion. No saved-speed data was changed.');
      return;
    }

    addExcludedSpeedSection(selectedSection);
    setPersistedExcludedSpeedSections((current) => [
      ...current.filter((item) => !speedSectionExclusionKeys(item).some((key) => keys.includes(key))),
      excluded.exclusion,
    ]);
    setIgnoredUnsetSectionKeys((current) => {
      const unsetKey = ignoredUnsetSectionKey(selectedSection);
      return unsetKey && !current.includes(unsetKey) ? [...current, unsetKey] : current;
    });
    if (selectedSection.saved) removeSavedRowsFromView([selectedSection]);
    setSelectedSection(null);
    setAddPath([]);
    setAddMode(false);
    const afterKnowledge = await knowledge.exportData().catch(() => null);
    const updatedTrips = await withRecalculation(() => (
      beforeKnowledge && afterKnowledge
        ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
        : refreshTripsCrossingLocalSpeedCorrection(selectedSection).catch(() => null)
    ));
    setBusyGeohash(null);
    const removedCount = Number(excluded.correctionsRemoved || 0) +
      Number(excluded.roadMemoryCandidatesRemoved || 0) +
      Number(excluded.cellsRemoved || 0);
    setStatus(buildRecalculationStatus(
      updatedTrips
        ? `Persistently excluded this parking/private section from learning, speed matching, scores, and alerts; removed ${removedCount} related knowledge record${removedCount === 1 ? '' : 's'} and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
        : `Persistently excluded this parking/private section and removed ${removedCount} related knowledge record${removedCount === 1 ? '' : 's'}, but matching trips could not be recalculated right now.`,
      beforeTrips,
      updatedTrips
    ));
    await refreshRowsAndMap();
  };

  const startAddingSection = async () => {
    const confirmed = await confirmDiscardMapEditorChanges('start a new road speed trace');
    if (!confirmed) return;
    setSelectedSection(null);
    setAddPath([]);
    setAddMode(true);
    setMapDraft(DEFAULT_MAP_DRAFT);
    setMapEditorSnapshot(null);
    setStatus(autoSnapTrace
      ? 'Adding road section started. Tap the start and end of the road segment; Auto snap will fill the recorded route shape when possible.'
      : 'Adding road section started. Tap points around bends, then enter the speed and save.');
  };

  const selectNewMapPoint = (point) => {
    setAddPath((current) => {
      const rawNext = [...current, point].slice(-24);
      let next = rawNext;
      if (autoSnapTrace) {
        const snapResult = snapSectionPointsToTripRoutesWithStats(rawNext, mapTrips, 80, {
          expandToRouteSegment: rawNext.length >= 2,
          maxPoints: 24,
        });
        if (snapResult.points.length) next = snapResult.points;
        if (snapResult.matchType === 'route_segment' && next.length > rawNext.length) {
          setStatus(`Auto snap traced ${next.length} route point${next.length === 1 ? '' : 's'} from ${snapResult.tripLabel || 'a recorded trip'}. Enter the speed and save.`);
        } else if (snapResult.snappedCount > 0 && rawNext.length >= 2) {
          setStatus(`Auto snap matched ${snapResult.snappedCount} point${snapResult.snappedCount === 1 ? '' : 's'} to recorded trip geometry. Add another point or save the speed.`);
        }
      }
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

  const moveAddPoint = (index, point) => {
    setAddPath((current) => {
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return current;
      const next = current.map((item, itemIndex) => (
        itemIndex === index ? { lat: point.lat, lng: point.lng } : item
      ));
      const midpoint = next[Math.floor(next.length / 2)];
      setSelectedSection((section) => ({
        ...(section || {}),
        ...midpoint,
        geohash: geohashEncode(midpoint.lat, midpoint.lng),
        saved: false,
        sectionPoints: next,
      }));
      return next;
    });
  };

  const moveSelectedSectionEndpoint = (index, point) => {
    const current = selectedSection;
    if (!current) return;
    const points = [...(current.sectionPoints || [])];
    if (!points[index]) return;

    const selectedKey = correctionKey(current);
    const originalPoint = points[index];
    const nextPoint = { lat: Number(point.lat), lng: Number(point.lng) };
    if (!Number.isFinite(nextPoint.lat) || !Number.isFinite(nextPoint.lng)) return;

    points[index] = nextPoint;
    const midpoint = points[Math.floor(points.length / 2)] || nextPoint;
    const linkedGeometryEdits = [];

    if (
      current.saved &&
      current.splitParentId &&
      (index === 0 || index === points.length - 1)
    ) {
      rows.forEach((row) => {
        const rowKey = correctionKey(row);
        if (
          rowKey === selectedKey ||
          row.splitParentId !== current.splitParentId ||
          !Array.isArray(row.sectionPoints) ||
          row.sectionPoints.length < 2
        ) return;

        const siblingPoints = row.sectionPoints.map((item) => ({ lat: Number(item.lat), lng: Number(item.lng) }));
        const siblingIndex = [0, siblingPoints.length - 1].find((pointIndex) => (
          distanceMeters(siblingPoints[pointIndex], originalPoint) <= 8
        ));
        if (!Number.isInteger(siblingIndex)) return;

        siblingPoints[siblingIndex] = nextPoint;
        const siblingMidpoint = siblingPoints[Math.floor(siblingPoints.length / 2)] || nextPoint;
        linkedGeometryEdits.push({
          selector: rowKey,
          lat: siblingMidpoint.lat,
          lng: siblingMidpoint.lng,
          geohash: geohashEncode(siblingMidpoint.lat, siblingMidpoint.lng),
          limitKmh: row.limitKmh,
          source: row.source,
          note: row.note || '',
          roadName: row.roadName || '',
          directionMode: row.directionMode || 'both',
          directionBearing: row.directionBearing,
          timeRule: row.timeRule,
          validFrom: row.validFrom || null,
          expiresAt: row.expiresAt || null,
          sectionPoints: siblingPoints,
        });
      });
    }

    const nextSection = {
      ...current,
      lat: midpoint.lat,
      lng: midpoint.lng,
      geohash: geohashEncode(midpoint.lat, midpoint.lng),
      sectionPoints: points,
    };
    if (linkedGeometryEdits.length) nextSection.linkedGeometryEdits = linkedGeometryEdits;
    else delete nextSection.linkedGeometryEdits;

    setSelectedSection(nextSection);
    if (linkedGeometryEdits.length) {
      setRows((currentRows) => currentRows.map((row) => {
        const linked = linkedGeometryEdits.find((edit) => edit.selector === correctionKey(row));
        return linked
          ? {
            ...row,
            lat: linked.lat,
            lng: linked.lng,
            geohash: linked.geohash,
            sectionPoints: linked.sectionPoints,
          }
          : row;
      }));
      setStatus('Moved the shared split point. Update road speed to save both adjusted halves.');
    }
  };

  const focusAttentionItem = async (item) => {
    if (!item?.section) return;
    const selected = await selectMapSection(item.section);
    if (!selected) return;
    switchWorkspace('map');
    setMapLayers((current) => ({
      ...current,
      conflicts: true,
      saved: true,
      learned: true,
      observed: true,
      unset: true,
      posted: true,
      estimates: true,
      lowConfidence: true,
      stale: true,
      expiring: true,
      missingGeometry: true,
    }));
    setStatus(item.kind === 'conflict'
      ? 'Conflict selected. Choose Use observed or Keep saved to clear it.'
      : item.kind === 'speedZone'
        ? `Trip speed zone ${item.zoneIndex} of ${item.zoneCount} selected. Save, adjust, or confirm this ${formatSpeedLimit(item.limitKmh, units)} segment independently.`
      : item.kind === 'review'
        ? `${speedSectionAttentionLabel(item.section)} selected. Review the saved speed, source, timing, and traced road line before updating.`
      : item.kind === 'learning'
        ? 'Learning corridor selected. No action is required; this view shows the GPS line and current local estimate.'
      : 'Road section selected. Enter a posted sign or local estimate, then save.');
  };

  const undoAddPoint = () => {
    setAddPath((current) => {
      if (!current.length) {
        setStatus('Cannot undo a trace point because no trace points have been added yet.');
        return current;
      }
      const next = current.slice(0, -1);
      if (!next.length) {
        setSelectedSection(null);
        setStatus('Removed the last trace point. Add road section mode is still active.');
      } else {
        const midpoint = next[Math.floor(next.length / 2)];
        setSelectedSection((section) => ({
          ...(section || {}),
          ...midpoint,
          geohash: geohashEncode(midpoint.lat, midpoint.lng),
          sectionPoints: next,
        }));
        setStatus(`Removed one trace point. ${next.length} point${next.length === 1 ? '' : 's'} remain.`);
      }
      return next;
    });
  };

  const snapSelectedSectionToTrips = async () => {
    if (!selectedSection) {
      setStatus('Select or trace a road section before using Snap to route.');
      return;
    }
    if (selectedSection.saved && invalidValidityWindow(mapDraft)) {
      setStatus('Effective from must be earlier than Active until before saving snapped geometry.');
      return;
    }
    if (selectedSection.saved && invalidCustomDayRule(mapDraft)) {
      setStatus('Choose at least one active day before saving snapped geometry.');
      return;
    }
    if (selectedSection.saved && qualifierDraftError(mapDraft)) {
      setStatus(`${qualifierDraftError(mapDraft)} Fix it before saving snapped geometry.`);
      return;
    }
    const currentPoints = selectedSection.sectionPoints || addPath;
    const hasRecordedRoute = mapTrips.some((trip) => (
      Array.isArray(trip?.route_points) && trip.route_points.length > 0
    ));
    if (!hasRecordedRoute) {
      setStatus('Snap to route needs at least one recorded trip. The traced line was not changed.');
      return;
    }
    const snapResult = snapSectionPointsToTripRoutesWithStats(currentPoints, mapTrips, 80, {
      expandToRouteSegment: true,
      maxPoints: 24,
    });
    const snapped = snapResult.points;
    if (snapped.length < 2) {
      setStatus('This section needs at least two points before it can snap to recorded routes.');
      return;
    }
    const geometryChanged = snapResult.changedCount > 0 ||
      snapped.length !== currentPoints.length ||
      snapped.some((point, index) => (
        Number(point.lat) !== Number(currentPoints[index]?.lat) ||
        Number(point.lng) !== Number(currentPoints[index]?.lng)
      ));
    if (!geometryChanged) {
      setStatus('No recorded route samples were within 80 metres, so the traced line was not changed.');
      return;
    }
    const midpoint = snapped[Math.floor(snapped.length / 2)];
    const snappedSection = {
      ...selectedSection,
      lat: midpoint.lat,
      lng: midpoint.lng,
      geohash: geohashEncode(midpoint.lat, midpoint.lng),
      sectionPoints: snapped,
      directionBearing: selectedSection.directionBearing,
    };
    setSelectedSection(snappedSection);
    if (addMode) setAddPath(snapped);
    const snapSummary = snapResult.matchType === 'route_segment'
      ? `matched ${snapped.length} ordered route point${snapped.length === 1 ? '' : 's'} from ${snapResult.tripLabel || 'a recorded trip'}, average ${snapResult.averageMoveM} m, max ${snapResult.maxMoveM} m`
      : `${snapResult.changedCount} point${snapResult.changedCount === 1 ? '' : 's'} moved, average ${snapResult.averageMoveM} m, max ${snapResult.maxMoveM} m`;
    if (!selectedSection.saved) {
      setStatus(`Section snapped to recorded route samples (${snapSummary}). Review the line, then save the road speed.`);
      return;
    }

    const selectedKey = correctionKey(selectedSection);
    const limitKmh = Number(mapDraft.limitKmh || selectedSection.limitKmh);
    if (!Number.isFinite(limitKmh) || limitKmh <= 0 || limitKmh > MAX_SAVED_SPEED_LIMIT_KMH) {
      setStatus('Snapped the line on the map, but could not save it because the speed limit is missing.');
      return;
    }
    setBusyGeohash(selectedKey);
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const saved = await knowledge.updateUserCorrection(
      selectedKey,
      Math.round(limitKmh),
      mapDraft.source || selectedSection.source || 'user_entered_estimate',
      mapDraft.note || selectedSection.note || '',
      {
        lat: snappedSection.lat,
        lng: snappedSection.lng,
        roadName: mapDraft.roadName || selectedSection.roadName || '',
        sectionPoints: snapped,
        directionMode: mapDraft.directionMode || selectedSection.directionMode || 'both',
        qualifierStatus: qualifierStatusForDraft(mapDraft),
        directionBearing: snappedSection.directionBearing,
        timeRule: timeRuleFromDraft(mapDraft),
        ...validityFromDraft(mapDraft),
      }
    ).catch(() => false);
    if (!saved) {
      setBusyGeohash(null);
      setStatus('Snapped the line on the map, but could not save it. Try Update road speed.');
      return;
    }
    const updatedSection = {
      ...snappedSection,
      limitKmh: Math.round(limitKmh),
      source: mapDraft.source || selectedSection.source || 'user_entered_estimate',
      note: mapDraft.note || selectedSection.note || '',
      roadName: mapDraft.roadName || selectedSection.roadName || '',
      directionMode: mapDraft.directionMode || selectedSection.directionMode || 'both',
      qualifierStatus: qualifierStatusForDraft(mapDraft),
      timeRule: timeRuleFromDraft(mapDraft),
      ...validityFromDraft(mapDraft),
    };
    setRows((current) => current.map((row) => (
      correctionKey(row) === selectedKey ? { ...row, ...updatedSection } : row
    )));
    setSelectedSection(updatedSection);
    setMapEditorSnapshot(updatedSection, mapDraft);
    setStatus(withUndo(`Saved snapped route geometry (${snapSummary}). Matching trip scores are updating in the background.`));
    void (async () => {
      const afterKnowledge = await knowledge.exportData().catch(() => null);
      const updatedTrips = await withRecalculation(() => (
        beforeKnowledge && afterKnowledge
          ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
          : refreshTripsCrossingLocalSpeedCorrection(updatedSection).catch(() => null)
      ));
      setStatus(withUndo(buildRecalculationStatus(
        updatedTrips
          ? `Saved snapped route geometry (${snapSummary}) and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'}.`
          : `Saved snapped route geometry (${snapSummary}), but matching trips could not be recalculated right now.`,
        matchingTripsForCorrection(selectedSection),
        updatedTrips
      )));
      await refreshRowsAndMap();
    })();
    setBusyGeohash(null);
  };

  const prepareMergeWithNearbySection = () => {
    if (!selectedSection?.saved) {
      setStatus('Select a saved road section before using Merge nearby.');
      return;
    }
    if (!mergeCandidate?.candidate) {
      setStatus('Cannot merge this road section yet. No nearby saved section with the same speed was found.');
      return;
    }
    const merged = mergeSpeedSections(selectedSection, mergeCandidate.candidate);
    if (!merged) {
      setStatus('These sections could not be merged because their saved geometry is incomplete.');
      return;
    }
    setSelectedSection({
      ...merged,
      saved: false,
      pendingMerge: true,
      mergedSelectors: merged.mergedSelectors,
    });
    setAddMode(false);
    setAddPath(merged.sectionPoints);
    setStatus(`Prepared a merged section with ${mergeCandidate.candidate.roadName || 'the nearby saved section'}. Saving will replace both original rules.`);
  };

  const saveMapSection = async () => {
    if (!selectedSection) {
      setStatus('Select or trace a road section before saving.');
      return;
    }
    const limitKmh = Number(mapDraft.limitKmh);
    if (!Number.isFinite(limitKmh) || limitKmh <= 0 || limitKmh > MAX_SAVED_SPEED_LIMIT_KMH) {
      setStatus('Enter a valid speed limit before saving.');
      return;
    }
    if (invalidValidityWindow(mapDraft)) {
      setStatus('Effective from must be earlier than Active until.');
      return;
    }
    if (invalidCustomDayRule(mapDraft)) {
      setStatus('Choose at least one active day for this custom schedule.');
      return;
    }
    const qualifierError = qualifierDraftError(mapDraft);
    if (qualifierError) {
      setStatus(qualifierError);
      return;
    }
    if (!selectedSection.saved && selectedSection.sectionPoints?.length < 2) {
      setStatus('Tap at least two points along the road so Road Sage can save a real road section.');
      return;
    }
    if (blockingOverlapChecks.length > 0) {
      const overlap = blockingOverlapChecks[0];
      setStatus(`Cannot save this road speed because it overlaps ${overlap.roadName || 'another saved section'} at ${formatSpeedLimit(overlap.limitKmh, units)}. Edit, split, merge, or add a distinct direction/time rule first.`);
      return;
    }
    const selectedKey = correctionKey(selectedSection);
    setBusyGeohash(selectedKey);
    const linkedGeometryEdits = Array.isArray(selectedSection.linkedGeometryEdits)
      ? selectedSection.linkedGeometryEdits
      : [];
    const historyGroup = selectedSection.pendingMerge
      ? `merge-${Date.now()}`
      : linkedGeometryEdits.length
        ? `linked-geometry-${Date.now()}`
      : null;
    const validity = validityFromDraft(mapDraft);
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const saved = selectedSection.saved
      ? await knowledge.updateUserCorrection(
        selectedKey,
        Math.round(limitKmh),
        mapDraft.source,
        mapDraft.note,
        {
          lat: selectedSection.lat,
          lng: selectedSection.lng,
          roadName: mapDraft.roadName || selectedSection.roadName || '',
          sectionPoints: selectedSection.sectionPoints || [],
          directionMode: mapDraft.directionMode || 'both',
          qualifierStatus: qualifierStatusForDraft(mapDraft),
          directionBearing: selectedSection.directionBearing,
          timeRule: timeRuleFromDraft(mapDraft),
          ...validity,
          historyGroup,
        }
      ).catch(() => false)
      : await knowledge.saveUserCorrection(
        selectedSection.lat,
        selectedSection.lng,
        Math.round(limitKmh),
        mapDraft.note,
        validity.expiresAt,
        privacyZones,
        mapDraft.source,
        {
          roadName: mapDraft.roadName || selectedSection.roadName || '',
          contextLabel: 'Selected from the saved road speed map',
          directionLabel: directionLabel(mapDraft.directionMode),
          directionMode: mapDraft.directionMode || 'both',
          qualifierStatus: qualifierStatusForDraft(mapDraft),
          directionBearing: selectedSection.directionBearing,
          timeRule: timeRuleFromDraft(mapDraft),
          ...validity,
          sectionPoints: selectedSection.sectionPoints || [selectedSection],
          provenance: selectedSection.roadMemoryCandidate
            ? 'road_memory_map_edit'
            : 'saved_speed_map',
          roadMemoryCandidateId: selectedSection.roadMemoryCandidate
            ? selectedSection.id || selectedSection.candidateId || selectedSection.sectionKey
            : null,
          historyGroup,
        }
      ).catch(() => false);

    if (saved) {
      const savedCorrection = saved && typeof saved === 'object' ? saved : null;
      if (linkedGeometryEdits.length) {
        await Promise.all(linkedGeometryEdits.map((edit) => knowledge.updateUserCorrection(
          edit.selector,
          Number(edit.limitKmh),
          edit.source || 'user_entered_estimate',
          edit.note || '',
          {
            lat: edit.lat,
            lng: edit.lng,
            roadName: edit.roadName || '',
            sectionPoints: edit.sectionPoints,
            directionMode: edit.directionMode || 'both',
            directionBearing: edit.directionBearing,
            timeRule: edit.timeRule,
            validFrom: edit.validFrom,
            expiresAt: edit.expiresAt,
            historyGroup,
          }
        ).catch(() => false)));
      }
      if (selectedSection.pendingMerge && Array.isArray(selectedSection.mergedSelectors)) {
        await Promise.all(selectedSection.mergedSelectors
          .filter((selector) => selector && selector !== selectedKey)
          .map((selector) => knowledge.removeUserCorrection(selector, { historyGroup }).catch(() => false)));
      }
      const correction = {
        ...selectedSection,
        ...(savedCorrection || {}),
        limitKmh: Math.round(limitKmh),
        source: mapDraft.source,
        note: mapDraft.note,
        roadName: mapDraft.roadName || selectedSection.roadName || '',
        sectionPoints: selectedSection.sectionPoints || [],
        directionMode: mapDraft.directionMode || 'both',
        qualifierStatus: qualifierStatusForDraft(mapDraft),
        timeRule: timeRuleFromDraft(mapDraft),
        ...validity,
      };
      const linkedGeometryLabel = linkedGeometryEdits.length ? ' and updated the linked split half' : '';
      const beforeTrips = matchingTripsForCorrection(correction);
      const nextRow = {
        ...correction,
        saved: true,
        appliedAt: correction.appliedAt || new Date().toISOString(),
      };
      setRows((current) => {
        const existingIndex = current.findIndex((item) => correctionKey(item) === selectedKey);
        if (existingIndex < 0) return [nextRow, ...current];
        return current.map((item, index) => index === existingIndex ? { ...item, ...nextRow } : item);
      });
      revealSavedSpeedMapLayer(mapDraft.source);
      setSelectedSection(nextRow);
      setAddMode(false);
      setAddPath([]);
      setMapEditorSnapshot(nextRow, mapDraft);
      setBusyGeohash(null);
      setStatus(withUndo(`Saved ${formatSpeedLimit(limitKmh, units)} for this road section${linkedGeometryLabel}. Matching trip scores are updating in the background.`));
      void (async () => {
        const afterKnowledge = await knowledge.exportData().catch(() => null);
        const updatedTrips = await withRecalculation(() => (
          beforeKnowledge && afterKnowledge
            ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
            : refreshTripsCrossingLocalSpeedCorrection(correction).catch(() => null)
        ));
        setStatus(withUndo(buildRecalculationStatus(
          updatedTrips
            ? `Saved ${formatSpeedLimit(limitKmh, units)} for this road section${linkedGeometryLabel}. Recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
            : `Saved ${formatSpeedLimit(limitKmh, units)} for this road section${linkedGeometryLabel}, but matching trips could not be recalculated right now.`,
          beforeTrips,
          updatedTrips
        )));
        await refreshRowsAndMap({ silent: true });
      })();
    } else {
      setStatus('Could not save this road section. Private-zone sections cannot be saved.');
      setBusyGeohash(null);
    }
  };

  const trimSavedMapSection = async (side) => {
    if (!selectedSection?.saved) {
      setStatus('Select a saved road section before trimming it.');
      return;
    }
    if (invalidValidityWindow(mapDraft)) {
      setStatus('Effective from must be earlier than Active until before trimming this section.');
      return;
    }
    if (invalidCustomDayRule(mapDraft)) {
      setStatus('Choose at least one active day before trimming this section.');
      return;
    }
    const qualifierError = qualifierDraftError(mapDraft);
    if (qualifierError) {
      setStatus(`${qualifierError} Fix it before trimming this section.`);
      return;
    }
    const points = (selectedSection.sectionPoints || [])
      .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
    if (points.length < 3) {
      setStatus('This section only has start and end points. Drag S or E, then Update road speed to trim it.');
      return;
    }
    const nextPoints = side === 'start' ? points.slice(1) : points.slice(0, -1);
    const midpoint = sectionMidpoint(nextPoints);
    const limitKmh = Number(mapDraft.limitKmh || selectedSection.limitKmh);
    if (!midpoint || !Number.isFinite(limitKmh) || limitKmh <= 0 || limitKmh > MAX_SAVED_SPEED_LIMIT_KMH) {
      setStatus('Could not trim this section because its geometry or speed limit is incomplete.');
      return;
    }

    const selectedKey = correctionKey(selectedSection);
    setBusyGeohash(selectedKey);
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const updatedSection = {
      ...selectedSection,
      lat: midpoint.lat,
      lng: midpoint.lng,
      geohash: geohashEncode(midpoint.lat, midpoint.lng),
      limitKmh: Math.round(limitKmh),
      source: mapDraft.source || selectedSection.source || 'user_entered_estimate',
      note: mapDraft.note || selectedSection.note || '',
      roadName: mapDraft.roadName || selectedSection.roadName || '',
      directionMode: mapDraft.directionMode || selectedSection.directionMode || 'both',
      qualifierStatus: qualifierStatusForDraft(mapDraft),
      timeRule: timeRuleFromDraft(mapDraft),
      ...validityFromDraft(mapDraft),
      sectionPoints: nextPoints,
    };
    const saved = await knowledge.updateUserCorrection(
      selectedKey,
      updatedSection.limitKmh,
      updatedSection.source,
      updatedSection.note,
      {
        lat: updatedSection.lat,
        lng: updatedSection.lng,
        roadName: updatedSection.roadName,
        sectionPoints: nextPoints,
        directionMode: updatedSection.directionMode,
        qualifierStatus: updatedSection.qualifierStatus,
        directionBearing: selectedSection.directionBearing,
        timeRule: updatedSection.timeRule,
        validFrom: updatedSection.validFrom,
        expiresAt: updatedSection.expiresAt,
        historyGroup: `trim-section-${Date.now()}`,
      }
    ).catch(() => false);
    if (!saved) {
      setBusyGeohash(null);
      setStatus('Could not trim this saved road section.');
      return;
    }

    setRows((current) => current.map((row) => (
      correctionKey(row) === selectedKey ? { ...row, ...updatedSection, appliedAt: new Date().toISOString() } : row
    )));
    setSelectedSection(updatedSection);
    setMapEditorSnapshot(updatedSection, mapDraft);
    revealSavedSpeedMapLayer(updatedSection.source);
    const beforeTrips = [
      ...new Map([
        ...matchingTripsForCorrection(selectedSection),
        ...matchingTripsForCorrection(updatedSection),
      ].map((trip) => [String(trip.id), trip])).values(),
    ];
    const afterKnowledge = await knowledge.exportData().catch(() => null);
    const updatedTrips = await withRecalculation(() => (
      beforeKnowledge && afterKnowledge
        ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
        : refreshTripsCrossingLocalSpeedCorrection(updatedSection).catch(() => null)
    ));
    setBusyGeohash(null);
    setStatus(withUndo(buildRecalculationStatus(
      updatedTrips
        ? `Trimmed the ${side} of this saved road section and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
        : `Trimmed the ${side} of this saved road section, but matching trips could not be recalculated right now.`,
      beforeTrips,
      updatedTrips
    )));
    await refreshRowsAndMap({ silent: true });
  };

  const removeMapSection = async () => {
    if (!selectedSection?.saved) {
      setStatus('Select a saved road section before removing it.');
      return;
    }
    const confirmed = await requestAppConfirm({
      title: 'Remove saved speed?',
      message: 'Remove the saved speed from this road section?',
      confirmLabel: 'Remove speed',
      destructive: true,
    });
    if (!confirmed) return;
    await removeRow(selectedSection);
    setSelectedSection(null);
    setMapEditorSnapshot(null);
  };

  const splitMapSection = async () => {
    if (!selectedSection?.saved) {
      setStatus('Select a saved road section before splitting it.');
      return;
    }
    if (invalidValidityWindow(mapDraft)) {
      setStatus('Effective from must be earlier than Active until before splitting this section.');
      return;
    }
    if (invalidCustomDayRule(mapDraft)) {
      setStatus('Choose at least one active day before splitting this section.');
      return;
    }
    const qualifierError = qualifierDraftError(mapDraft);
    if (qualifierError) {
      setStatus(`${qualifierError} Fix it before splitting this section.`);
      return;
    }
    const originalSection = selectedSection;
    const parts = buildSplitCorrections({
      ...originalSection,
      limitKmh: Number(mapDraft.limitKmh || originalSection.limitKmh),
      source: mapDraft.source || originalSection.source,
      note: mapDraft.note || originalSection.note || '',
      roadName: mapDraft.roadName || originalSection.roadName || '',
      directionMode: mapDraft.directionMode || originalSection.directionMode || 'both',
      qualifierStatus: qualifierStatusForDraft(mapDraft),
      timeRule: timeRuleFromDraft(mapDraft),
      ...validityFromDraft(mapDraft),
    });
    if (parts.length !== 2) {
      setStatus('This road section needs at least two valid trace points before it can be split.');
      return;
    }
    const confirmed = await requestAppConfirm({
      title: 'Split saved speed?',
      message: 'Split this saved speed into two editable road sections?',
      confirmLabel: 'Split section',
    });
    if (!confirmed) return;

    const selectedKey = correctionKey(originalSection);
    setBusyGeohash(selectedKey);
    const source = mapDraft.source || originalSection.source || 'user_entered_estimate';
    const noteBase = mapDraft.note || originalSection.note || '';
    const { validFrom, validFromDate, expiresAt, expiresAtDate } = validityFromDraft(mapDraft);
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    if (!beforeKnowledge) {
      setStatus('Could not load saved road speeds before splitting. Try refresh, then split again.');
      setBusyGeohash(null);
      return;
    }

    const originalId = originalSection.id || originalSection.ruleId || originalSection.sectionKey || null;
    const matchesOriginal = (correction = {}) => {
      const correctionId = correction.id || correction.ruleId || correction.sectionKey || null;
      return originalId
        ? correctionId === originalId
        : correction.geohash === originalSection.geohash;
    };
    const originalCorrection = (beforeKnowledge.corrections || []).find(matchesOriginal) || originalSection;
    const now = new Date().toISOString();
    const splitCorrections = parts.map((part, index) => {
      const note = noteBase ? `${noteBase} (split ${part.splitPart}/2)` : `Split section ${part.splitPart}/2`;
      return {
        ...originalCorrection,
        ...part,
        id: `${originalId || selectedKey || 'speed-rule'}-split-${Date.now()}-${index + 1}`,
        ruleId: undefined,
        sectionKey: undefined,
        source,
        note,
        validFrom,
        validFromDate,
        expiresAt,
        expiresAtDate,
        appliedAt: now,
        verifiedAt: source === 'user_confirmed_posted_sign' ? now : originalCorrection.verifiedAt || null,
        verificationStatus: source === 'user_confirmed_posted_sign' ? 'confirmed_posted_sign' : 'user_estimate',
        directionMode: part.directionMode || originalCorrection.directionMode || 'both',
        directionBearing: part.directionBearing,
        timeRule: part.timeRule,
        roadName: part.roadName || '',
        contextLabel: part.contextLabel,
        directionLabel: directionLabel(part.directionMode),
        sectionPoints: part.sectionPoints,
        splitParentId: originalId || selectedKey || null,
        splitPart: part.splitPart,
        auditTrail: [
          ...(Array.isArray(originalCorrection.auditTrail) ? originalCorrection.auditTrail : []),
          {
            action: 'split_from_midpoint',
            changedAt: now,
            splitPart: part.splitPart,
          },
        ].slice(-25),
      };
    });
    const nextKnowledge = {
      ...beforeKnowledge,
      corrections: [
        ...(beforeKnowledge.corrections || []).filter((correction) => !matchesOriginal(correction)),
        ...splitCorrections,
      ],
    };
    const replaced = await knowledge.replaceData(nextKnowledge, 'split_correction').catch(() => false);
    if (replaced) {
      setRows((current) => [
        ...current.filter((row) => !matchesOriginal(row)),
        ...splitCorrections,
      ]);
      setSelectedSection(splitCorrections[0]);
      setAddMode(false);
      setAddPath([]);
      setMapEditorSnapshot(splitCorrections[0], mapDraft);
      revealSavedSpeedMapLayer(source);
      const updatedTrips = await withRecalculation(() => (
        refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, nextKnowledge).catch(() => null)
      ));
      const recalculated = Array.isArray(updatedTrips) ? updatedTrips.length : 0;
      setStatus(withUndo(`Road section split into two saved speeds. First half is selected; drag S, E, or any numbered bend handle to refine it. Recalculated ${recalculated} matching trip${recalculated === 1 ? '' : 's'} locally.`));
      await refreshRowsAndMap();
    } else {
      setStatus('Could not split this section completely. Review saved speeds before trying again.');
      await refreshRowsAndMap();
    }
    setBusyGeohash(null);
  };

  const undoKnowledgeChange = async () => {
    setBusyGeohash('undo');
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const undone = await knowledge.undo().catch(() => false);
    if (!undone) {
      setStatus('There is no saved road-speed change to undo.');
      setBusyGeohash(null);
      return;
    }
    dirtyDraftKeysRef.current.clear();
    persistedDraftBaselinesRef.current = {};
    setDrafts({});
    setSelectedSection(null);
    setMapDraft(DEFAULT_MAP_DRAFT);
    setMapEditorSnapshot(null);
    const afterKnowledge = await knowledge.exportData().catch(() => null);
    const updatedTrips = beforeKnowledge && afterKnowledge
      ? await withRecalculation(() => (
        refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
      ))
      : null;
    setStatus(updatedTrips
      ? `Change undone. Recalculated ${updatedTrips.length} affected trip${updatedTrips.length === 1 ? '' : 's'}.`
      : 'Change undone, but affected trips could not be recalculated right now.');
    setBusyGeohash(null);
    await refreshRowsAndMap();
  };

  const exportSpeedKnowledge = async () => {
    const confirmed = await requestAppConfirm({
      title: 'Export speed rules?',
      message: SPEED_RULE_EXPORT_PRIVACY_WARNING,
      confirmLabel: 'Export rules',
    });
    if (!confirmed) return;
    const data = await knowledge.exportData();
    const filename = `road-sage-speed-rules-${new Date().toISOString().slice(0, 10)}.json`;
    const payload = {
      app: 'Road Sage',
      format: 'road-sage-speed-knowledge',
      version: 1,
      exported_at: new Date().toISOString(),
      includes: {
        saved_rules: true,
        map_line_geometry: true,
        learned_speed_cells: true,
        local_road_memory: true,
        map_tiles: false,
      },
      speed_knowledge: data,
    };
    try {
      const result = await saveSpeedKnowledgeExport(filename, payload);
      setStatus(result.native
        ? `Saved ${rows.length} road-speed rule${rows.length === 1 ? '' : 's'} to Downloads as ${result.filename}. Map lines and speed-map data are included.`
        : `Downloading ${rows.length} road-speed rule${rows.length === 1 ? '' : 's'} as ${result.filename}. Map lines and speed-map data are included.`);
    } catch (error) {
      logSystemFailure('speed_knowledge_export_failed', error, {
        rule_count: rows.length,
      });
      setStatus('Could not export saved road speeds right now. Check system logs for the exact failure.');
    }
  };

  const refreshSavedRoadSpeeds = async () => {
    await refreshRowsAndMap({ forceMap: mapModelActive });
    setStatus('Saved road speeds refreshed.');
  };

  const repairSavedRoadSpeeds = async () => {
    setBusyGeohash('repair');
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const result = await knowledge.repairSavedSpeedData().catch(() => null);
    if (!result) {
      setStatus('Could not repair saved road speeds right now. Try refresh, then repair again.');
      setBusyGeohash(null);
      return;
    }
    const afterKnowledge = await knowledge.exportData().catch(() => null);
    const updatedTrips = result.changed && beforeKnowledge && afterKnowledge
      ? await withRecalculation(() => (
        refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
      ))
      : null;
    setBusyGeohash(null);
    await refreshRowsAndMap({ silent: true });
    if (!result.changed) {
      setStatus('Repair checked saved road speeds. No expired or duplicate saved rules needed cleanup.');
      return;
    }
    const removed = Number(result.removedExpired || 0) + Number(result.removedDuplicates || 0);
    setStatus(withUndo(updatedTrips
      ? `Repair removed ${removed} stale or duplicate saved rule${removed === 1 ? '' : 's'} and recalculated ${updatedTrips.length} matching trip${updatedTrips.length === 1 ? '' : 's'} locally.`
      : `Repair removed ${removed} stale or duplicate saved rule${removed === 1 ? '' : 's'}. Matching trips could not be recalculated right now.`));
  };

  const closeMapEditor = async () => {
    const confirmed = await confirmDiscardMapEditorChanges('close the editor');
    if (!confirmed) return;
    setAddMode(false);
    setAddPath([]);
    setSelectedSection(null);
    setMapEditorSnapshot(null);
  };

  const cancelAddSection = async () => {
    const confirmed = await confirmDiscardMapEditorChanges('cancel adding this road speed');
    if (!confirmed) return;
    setAddMode(false);
    setAddPath([]);
    setSelectedSection(null);
    setMapEditorSnapshot(null);
    setStatus('Add road section cancelled.');
  };

  const toggleAutoSnapTrace = () => {
    setAutoSnapTrace((value) => {
      const next = !value;
      setStatus(next
        ? 'Auto-snap enabled. New trace points will snap to nearby recorded trip geometry when possible.'
        : 'Auto-snap disabled. New trace points will stay where you tap them.');
      return next;
    });
  };

  const importSpeedKnowledge = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setStatus('Speed-rule backup is too large. Choose a JSON file smaller than 5 MB.');
      return;
    }
    try {
      const payload = JSON.parse(await file.text());
      const data = payload?.speed_knowledge ?? payload?.data ?? payload;
      if (!data || typeof data !== 'object' || typeof data.cells !== 'object' || !Array.isArray(data.corrections)) {
        throw new Error('Invalid speed-rule backup');
      }
      const hydratedPrivacyZones = await getHydratedPrivacyZones();
      if (!Array.isArray(hydratedPrivacyZones)) {
        throw new Error('Road Sage could not securely load your privacy zones, so no speed rules were restored.');
      }
      const warnings = [];
      const sanitized = sanitizeSpeedKnowledge(data, hydratedPrivacyZones, warnings);
      if (
        !sanitized ||
        typeof sanitized.cells !== 'object' ||
        !Array.isArray(sanitized.corrections) ||
        !Array.isArray(sanitized.excludedSections)
      ) {
        throw new Error('Unsafe speed-rule backup');
      }
      const beforeKnowledge = await knowledge.exportData();
      const restored = await knowledge.replaceData(sanitized, 'restore_speed_backup');
      if (!restored) throw new Error('Speed-rule restore did not commit');
      dirtyDraftKeysRef.current.clear();
      persistedDraftBaselinesRef.current = {};
      setDrafts({});
      setSelectedSection(null);
      setMapDraft(DEFAULT_MAP_DRAFT);
      setMapEditorSnapshot(null);
      const afterKnowledge = await knowledge.exportData();
      const updatedTrips = await withRecalculation(() => (
        refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
      ));
      const importedLearnedCount = Object.values(sanitized.cells || {}).filter((cell) => (
        cell?.importTrustState === 'shadow_relearning'
      )).length +
        (sanitized.roadMemory?.candidates?.length || 0);
      const relearningNotice = importedLearnedCount
        ? ` ${importedLearnedCount} imported learned corridor${importedLearnedCount === 1 ? ' was' : 's were'} reset to shadow/relearning and cannot affect scores or alerts until fresh local evidence revalidates ${importedLearnedCount === 1 ? 'it' : 'them'}.`
        : '';
      const postedReconfirmationCount = sanitized.corrections.filter((correction) => (
        correction?.importTrustState === 'posted_reconfirmation_required'
      )).length;
      const postedReconfirmationNotice = postedReconfirmationCount
        ? ` ${postedReconfirmationCount} imported posted-sign rule${postedReconfirmationCount === 1 ? ' was' : 's were'} downgraded to an estimate; confirm ${postedReconfirmationCount === 1 ? 'it' : 'them'} while parked before posted-sign authority is restored.`
        : '';
      setStatus(withUndo(updatedTrips
        ? `Safely restored ${sanitized.corrections.length} saved road-speed rule${sanitized.corrections.length === 1 ? '' : 's'} and ${sanitized.excludedSections.length} persistent exclusion${sanitized.excludedSections.length === 1 ? '' : 's'}; recalculated ${updatedTrips.length} affected trip${updatedTrips.length === 1 ? '' : 's'}.${relearningNotice}${postedReconfirmationNotice}${warnings.length ? ` ${warnings.length} unsafe or private record${warnings.length === 1 ? ' was' : 's were'} skipped.` : ''}`
        : `Safely restored ${sanitized.corrections.length} saved road-speed rule${sanitized.corrections.length === 1 ? '' : 's'} and ${sanitized.excludedSections.length} persistent exclusion${sanitized.excludedSections.length === 1 ? '' : 's'}, but affected trips could not be recalculated right now.${relearningNotice}${postedReconfirmationNotice}${warnings.length ? ` ${warnings.length} unsafe or private record${warnings.length === 1 ? ' was' : 's were'} skipped.` : ''}`));
      await refreshRowsAndMap();
    } catch (error) {
      setStatus(error?.message?.startsWith('Road Sage could not securely load your privacy zones')
        ? error.message
        : 'Could not restore that file. Choose a Road Sage speed-rule or full-backup JSON file.');
    }
  };

  const toggleSelectedRow = (key) => {
    setSelectedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectVisibleRows = () => {
    setSelectedRows((current) => {
      const next = new Set(current);
      const selectableRows = visibleRows.filter((row) => row.historicalVersion !== true);
      const allSelected = selectableRows.length > 0 && selectableRows.every((row) => next.has(correctionKey(row)));
      selectableRows.forEach((row) => {
        const key = correctionKey(row);
        if (allSelected) next.delete(key);
        else next.add(key);
      });
      return next;
    });
  };

  const confirmSelectedAsPosted = async () => {
    const selected = rows.filter((row) => (
      row.historicalVersion !== true && selectedRows.has(correctionKey(row))
    ));
    if (!selected.length) {
      setStatus('Select at least one saved road-speed rule before confirming posted signs.');
      return;
    }
    const historyGroup = `bulk-confirm-${Date.now()}`;
    setBusyGeohash('bulk');
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const results = await Promise.all(selected.map((row) => knowledge.updateUserCorrection(
      correctionKey(row),
      row.limitKmh,
      'user_confirmed_posted_sign',
      row.note || 'Bulk confirmed from saved speed review',
      { historyGroup }
    ).catch(() => false)));
    const updated = selected.filter((_, index) => results[index]);
    const afterKnowledge = await knowledge.exportData().catch(() => null);
    await withRecalculation(() => (
      beforeKnowledge && afterKnowledge
        ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
        : Promise.all(updated.map((row) => refreshTripsCrossingLocalSpeedCorrection(row).catch(() => null)))
    ));
    setSelectedRows(new Set());
    if (updated.length > 0) {
      revealSavedRowsFilter('user_confirmed_posted_sign');
      revealSavedSpeedMapLayer('user_confirmed_posted_sign');
    }
    setStatus(withUndo(updated.length > 0
      ? `Confirmed ${updated.length} selected rule${updated.length === 1 ? '' : 's'} as posted signs.`
      : 'Could not confirm the selected rules as posted signs.'));
    setBusyGeohash(null);
    await refreshRowsAndMap();
  };

  const deleteSelectedRows = async () => {
    const selected = rows.filter((row) => (
      row.historicalVersion !== true && selectedRows.has(correctionKey(row))
    ));
    if (!selected.length) {
      setStatus('Select at least one saved road-speed rule before deleting.');
      return;
    }
    const confirmed = await requestAppConfirm({
      title: 'Delete selected speed rules?',
      message: `Delete ${selected.length} selected saved road-speed rule${selected.length === 1 ? '' : 's'}?`,
      confirmLabel: 'Delete selected',
      destructive: true,
    });
    if (!confirmed) return;
    const historyGroup = `bulk-delete-${Date.now()}`;
    setBusyGeohash('bulk');
    const beforeKnowledge = await knowledge.exportData().catch(() => null);
    const results = await Promise.all(selected.map((row) => (
      knowledge.removeUserCorrection(correctionKey(row), { historyGroup }).catch(() => false)
    )));
    const removed = selected.filter((_, index) => results[index]);
    removeSavedRowsFromView(removed);
    const afterKnowledge = await knowledge.exportData().catch(() => null);
    await withRecalculation(() => (
      beforeKnowledge && afterKnowledge
        ? refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
        : Promise.all(removed.map((row) => refreshTripsCrossingLocalSpeedCorrection(row).catch(() => null)))
    ));
    setSelectedRows(new Set());
    setStatus(withUndo(`Deleted ${removed.length} selected rule${removed.length === 1 ? '' : 's'}.`));
    setBusyGeohash(null);
    await refreshRowsAndMap();
  };

  const cleanExpiredSpeedKnowledge = async () => {
    const beforeKnowledge = await knowledge.exportData();
    await knowledge.prune(180);
    const afterKnowledge = await knowledge.exportData();
    const updatedTrips = await withRecalculation(() => (
      refreshTripsForLocalSpeedKnowledgeChanges(beforeKnowledge, afterKnowledge).catch(() => null)
    ));
    setStatus(withUndo(updatedTrips
      ? `Removed expired temporary rules and learned evidence older than 180 days while preserving historical speed versions. Recalculated ${updatedTrips.length} affected trip${updatedTrips.length === 1 ? '' : 's'}.`
      : 'Removed expired temporary rules and old learned evidence while preserving historical speed versions, but affected trips could not be recalculated right now.'));
    await refreshRowsAndMap();
  };

  if (loading && !loadedOnce) return <SavedRoadSpeedsSkeleton />;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-grotesk text-2xl font-bold tracking-tight">Saved road speeds</h1>
            <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground">
              {activeManualRows.length + operationalMemoryCount} active
            </span>
            {historicalRuleCount > 0 && (
              <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-800 dark:bg-violet-950/40 dark:text-violet-200">
                {historicalRuleCount} historical version{historicalRuleCount === 1 ? '' : 's'} retained
              </span>
            )}
            {scheduledOrExpiredRuleCount > 0 && (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-900 dark:text-slate-200">
                {scheduledOrExpiredRuleCount} scheduled or expired
              </span>
            )}
            <span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-800 dark:bg-sky-950/40 dark:text-sky-200">
              Road Memory v2 · calibrated locally
            </span>
            <InlineRefreshBadge visible={refreshing} label="Refreshing saved speeds" />
            <InlineRefreshBadge
              visible={memoryHistorySync.status === 'syncing'}
              label="Learning from existing trips"
            />
            <InlineRefreshBadge visible={workspacePending} label="Opening workspace" />
            <InlineRefreshBadge visible={mapModelLoading} label="Loading map model" />
            <InlineRefreshBadge
              visible={mapSectionBuildState.status === 'building'}
              label="Building road lines in background"
            />
            <InlineRefreshBadge visible={recalculationBusy} label="Updating trip scores" />
            <InlineRefreshBadge visible={mapQueryPending} label="Updating map filter" />
            <InlineRefreshBadge visible={isRowQueryPending} label="Updating saved speed rows" />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Existing and new trips build private corridor suggestions automatically. New estimates stay in shadow mode until parked decisions prove the model reliable; confirmed posted limits remain authoritative.
          </p>
          {memoryHistorySync.status === 'ready' && memoryHistorySync.scannedTripCount > 0 && (
            <p className="mt-1 text-xs font-medium text-sky-700 dark:text-sky-300">
              Checked {memoryHistorySync.scannedTripCount} stored trip{memoryHistorySync.scannedTripCount === 1 ? '' : 's'}
              {memoryHistorySync.observationCount > 0
                ? ` and learned ${memoryHistorySync.observationCount} road observation${memoryHistorySync.observationCount === 1 ? '' : 's'}.`
                : '; no new usable public road observations were found.'}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={restoreInputRef}
            type="file"
            accept=".json,application/json"
            onChange={importSpeedKnowledge}
            className="hidden"
            aria-label="Restore speed-rule JSON"
          />
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
            onClick={exportSpeedKnowledge}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-foreground hover:bg-secondary"
            title="Export speed rules and precise road locations"
            aria-label="Export speed rules and precise road locations"
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setStatus('Choose a Road Sage speed-rule JSON file to restore.');
              restoreInputRef.current?.click();
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-foreground hover:bg-secondary"
            title="Restore speed rules"
            aria-label="Restore speed rules"
          >
            <Upload className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={refreshSavedRoadSpeeds}
            disabled={loading}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          <button
            type="button"
            onClick={syncRoadMemoryHistory}
            disabled={memoryHistorySync.status === 'syncing'}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
            title="Scan stored trips only when you ask; new completed trips are learned automatically"
          >
            <Gauge className="h-3.5 w-3.5" />
            {memoryHistorySync.status === 'syncing' ? 'Scanning history…' : 'Scan trip history'}
          </button>
          <button
            type="button"
            onClick={repairSavedRoadSpeeds}
            disabled={loading || busyGeohash === 'repair'}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Repair
          </button>
        </div>
      </div>

      {status && (
        <div className="flex items-start gap-3 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium" aria-live="polite">
          <div className="min-w-0 flex-1">
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
          {typeof status === 'object' && status.canUndo && historyState.canUndo && (
            <button
              type="button"
              onClick={undoKnowledgeChange}
              disabled={loading || busyGeohash === 'undo'}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-50"
            >
              <Undo2 className="h-3.5 w-3.5" />
              Undo {undoActionText(historyState.undoLabel)}
            </button>
          )}
        </div>
      )}

      {nativeMirrorHealth.state !== 'not_applicable' && (
        <section
          data-testid="native-speed-mirror-status"
          data-state={nativeMirrorHealth.state}
          className={`flex flex-col gap-2 rounded-xl border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between ${
            nativeMirrorHealth.state === 'synced'
              ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/20'
              : nativeMirrorHealth.state === 'error'
                ? 'border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/20'
                : 'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/20'
          }`}
          aria-live="polite"
        >
          <div className="flex items-start gap-2">
            {nativeMirrorHealth.state === 'synced'
              ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" />
              : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />}
            <div>
              <div className="text-xs font-semibold">
                {nativeMirrorHealth.state === 'synced'
                  ? 'Background Android speed alerts are synchronized'
                  : nativeMirrorHealth.state === 'privacy_blocked'
                    ? 'Background saved-speed alerts are privacy-paused'
                    : nativeMirrorHealth.state === 'error'
                      ? 'Background Android speed alerts need a sync retry'
                      : 'Checking the background Android speed copy'}
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {nativeMirrorHealth.state === 'synced'
                  ? `Only eligible, privacy-safe rules are mirrored in an encrypted device copy${nativeMirrorHealth.syncedAt ? `; last synced ${new Date(nativeMirrorHealth.syncedAt).toLocaleTimeString()}` : ''}.`
                  : nativeMirrorHealth.state === 'privacy_blocked'
                    ? 'The encrypted location-bearing native copy was replaced with an encrypted empty copy because privacy zones could not be verified. In-app rules remain intact.'
                    : nativeMirrorHealth.state === 'error'
                      ? (nativeMirrorHealth.error || 'The native service may not have the latest saved-road rules yet.')
                      : 'Road Sage is reconciling the versioned in-app store with the native background service.'}
              </p>
            </div>
          </div>
          {nativeMirrorHealth.state !== 'synced' && (
            <button
              type="button"
              onClick={retryNativeMirror}
              disabled={nativeMirrorRetrying}
              className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-current/20 bg-background px-3 text-xs font-semibold disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${nativeMirrorRetrying ? 'animate-spin' : ''}`} />
              {nativeMirrorRetrying ? 'Retrying' : 'Retry background sync'}
            </button>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-emerald-300 bg-emerald-50/80 p-4 shadow-sm dark:border-emerald-900/60 dark:bg-emerald-950/20" aria-label="Smart Speed protection status">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Smart Speed · authority status</div>
            <h2 className="mt-1 font-grotesk text-lg font-bold">Confirmed posted speeds are protected</h2>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              A confirmed traced corridor always wins over Road Memory. Matching learned suggestions are suppressed before they can appear, score a trip, or drive an alert.
            </p>
          </div>
          <span className="w-fit rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white">Protection active</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:max-w-md">
          <div className="rounded-xl bg-background/80 px-3 py-2">
            <div className="text-[10px] font-bold uppercase text-muted-foreground">Confirmed corridors</div>
            <div className="mt-1 text-xl font-bold">{smartProtection.confirmedCorridorCount}</div>
          </div>
          <div className="rounded-xl bg-background/80 px-3 py-2">
            <div className="text-[10px] font-bold uppercase text-muted-foreground">Suggestions blocked</div>
            <div className="mt-1 text-xl font-bold">{smartProtection.suppressedSuggestionCount}</div>
          </div>
        </div>
      </section>

      <RoadSpeedCommandCenter
        cameraCount={cameraReviewCount}
        estimatedCount={estimatedRuleCount}
        learningCount={learningMemoryCandidates.length}
        mapStatus={mapModelState.status}
        postedCount={postedRuleCount}
        reviewCount={mapModelLoaded
          ? attentionItems.length
          : savedRowsNeedingReviewCount + memoryChangeReviewCount + staleMemoryCount}
        savedCount={activeManualRows.length + operationalMemoryCount}
        onAdd={() => {
          switchWorkspace('map');
          void startAddingSection();
        }}
        onOpenMap={() => switchWorkspace('map')}
        onOpenReview={() => {
          switchWorkspace('review');
          window.setTimeout(() => {
            reviewWorkspaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 120);
        }}
        onOpenSaved={() => switchWorkspace('saved')}
      />
      <SpeedRescoreStatus />

      <section className="rounded-2xl border border-indigo-200 bg-indigo-50/70 px-4 py-3 text-xs dark:border-indigo-900/60 dark:bg-indigo-950/20" aria-label="Private road corridor intelligence">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-semibold text-indigo-950 dark:text-indigo-100">Private corridor intelligence</div>
            <p className="mt-1 leading-relaxed text-indigo-900/80 dark:text-indigo-200/80">
              Built only from your saved and driven GPS geometry. It protects nearby parallel roads, detects speed boundaries at junctions, and collapses repeated evidence before drawing.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 font-semibold">
            <span className="rounded-full bg-background px-2 py-1">{corridorGraphSummary.corridors} corridors</span>
            <span className="rounded-full bg-background px-2 py-1">{corridorGraphSummary.boundaries} boundary edges</span>
            <span className="rounded-full bg-background px-2 py-1">{corridorGraphSummary.parallelProtected} parallel protected</span>
            <span className="rounded-full bg-background px-2 py-1">{corridorGraphSummary.duplicateEvidence} duplicates hidden</span>
          </div>
        </div>
      </section>

      <RoadMemoryIntelligencePanel
        candidates={roadMemoryCandidates}
        onChanged={() => refreshRowsAndMap({ silent: true, forceMap: true })}
        onFocus={(candidate) => focusAttentionItem({
          kind: 'learning',
          section: {
            ...candidate,
            roadMemoryCandidate: true,
            source: 'local_road_memory',
            effectiveLimitKmh: Number(candidate.limitKmh) || null,
          },
        })}
      />

      <nav className="grid grid-cols-3 gap-1 rounded-2xl border border-border bg-card p-1.5 shadow-sm" aria-label="Saved road speed workspace">
        {SPEED_WORKSPACES.map(({ value, label, Icon }) => {
          const active = activeWorkspace === value;
          const count = value === 'review'
            ? cameraReviewCount + (
                mapModelLoaded
                  ? attentionItems.length
                  : savedRowsNeedingReviewCount + memoryChangeReviewCount + staleMemoryCount
              )
            : value === 'saved'
              ? rows.length + operationalMemoryCount
              : mapStats.total;
          return (
            <button
              key={value}
              type="button"
              onClick={() => switchWorkspace(value)}
              aria-pressed={active}
              className={`inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold transition-colors ${
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                active ? 'bg-primary-foreground/15' : 'bg-secondary'
              }`}>
                {count}
              </span>
            </button>
          );
        })}
      </nav>

      {mapModelActive && mapModelState.status === 'loaded' && (
        <section className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="font-semibold text-foreground">
              {geometryIndexState.status === 'building'
                ? 'Indexing older road geometry without blocking the page'
                : geometryIndexState.status === 'ready'
                  ? 'Full local road geometry index loaded'
                  : 'Recent road evidence loaded without blocking the page'}
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {mapTrips.length} compact trip route{mapTrips.length === 1 ? '' : 's'} loaded
              {Number(mapModelState.totalTripCount) > 0
                ? ` from ${Number(mapModelState.totalTripCount)} available`
                : ''}
              {mapSectionBuildState.status === 'ready' && Number(mapSectionBuildState.durationMs) > 0
                ? ` · road lines built in ${Math.round(Number(mapSectionBuildState.durationMs))} ms`
                : ''}
            </div>
          </div>
          {geometryIndexState.status !== 'building' &&
            geometryIndexState.status !== 'ready' &&
            Number(mapModelState.nextOffset) < Number(mapModelState.totalTripCount) && (
            <button
              type="button"
              onClick={loadMoreMapTrips}
              disabled={mapMoreBusy || mapSectionBuildState.status === 'building'}
              className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 font-semibold hover:bg-secondary disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {mapMoreBusy ? 'Loading older roads…' : `Load ${SPEED_MAP_TRIP_BATCH_SIZE} older trips`}
            </button>
          )}
          {geometryIndexState.status !== 'building' &&
            Number(mapTrips.length) < Number(mapModelState.totalTripCount) && (
            <button
              type="button"
              onClick={loadFullGeometryHistory}
              disabled={mapMoreBusy || mapSectionBuildState.status === 'building'}
              className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 font-semibold hover:bg-secondary disabled:opacity-50"
              title="Explicitly load and index all stored trip routes; this no longer runs during normal page loading"
            >
              <MapIcon className="h-3.5 w-3.5" />
              Load full road history
            </button>
          )}
        </section>
      )}

      {activeWorkspace === 'review' && (
        <SpeedLimitReviewWorkspace
          attentionItems={attentionItems}
          cleanExpiredSpeedKnowledge={cleanExpiredSpeedKnowledge}
          firstConflictSection={firstConflictSection}
          focusAttentionItem={focusAttentionItem}
          health={health}
          knowledgeQuery={knowledgeQuery}
          learningInventoryRef={learningInventoryRef}
          learningInventoryVirtualizer={learningInventoryVirtualizer}
          learningMemoryCandidates={learningMemoryCandidates}
          loadMapModel={loadMapModel}
          mapModelLoaded={mapModelLoaded}
          mapModelState={mapModelState}
          refreshRowsAndMap={refreshRowsAndMap}
          reviewInventory={reviewInventory}
          reviewInventoryRef={reviewInventoryRef}
          reviewInventoryVirtualizer={reviewInventoryVirtualizer}
          reviewWorkspaceRef={reviewWorkspaceRef}
          roadMemoryCandidates={roadMemoryCandidates}
          rows={rows}
          setCameraReviewCount={setCameraReviewCount}
          setKnowledgeQuery={setKnowledgeQuery}
          setShowAllAttention={setShowAllAttention}
          showAllAttention={showAllAttention}
          units={units}
          visibleAttentionItems={visibleAttentionItems}
        />
      )}

      {activeWorkspace === 'map' && (
        <SpeedLimitMapWorkspace
          addMode={addMode}
          addPath={addPath}
          autoSnapTrace={autoSnapTrace}
          busyGeohash={busyGeohash}
          canSaveSelectedMapSection={canSaveSelectedMapSection}
          cancelAddSection={cancelAddSection}
          closeMapEditor={closeMapEditor}
          currentMapRows={currentMapRows}
          deferredMapQuery={deferredMapQuery}
          editorWarnings={editorWarnings}
          excludedSpeedSectionCount={excludedSpeedSectionCount}
          firstConflictSection={firstConflictSection}
          focusAttentionItem={focusAttentionItem}
          hiddenUnsetSectionCount={hiddenUnsetSectionCount}
          historicalRuleCount={historicalRuleCount}
          ignoreUnsetMapSection={ignoreUnsetMapSection}
          loadMapModel={loadMapModel}
          mapDisplayTrips={mapDisplayTrips}
          mapDraft={mapDraft}
          mapLayers={mapLayers}
          mapModelLoading={mapModelLoading}
          mapModelState={mapModelState}
          mapQuery={mapQuery}
          mapSections={mapSections}
          markSelectedSectionPrivate={markSelectedSectionPrivate}
          mergeCandidate={mergeCandidate}
          moveAddPoint={moveAddPoint}
          moveSelectedSectionEndpoint={moveSelectedSectionEndpoint}
          persistedExcludedSpeedSections={persistedExcludedSpeedSections}
          prepareMergeWithNearbySection={prepareMergeWithNearbySection}
          removeMapSection={removeMapSection}
          resolveSavedSpeedConflict={resolveSavedSpeedConflict}
          restoreExcludedSpeedSections={restoreExcludedSpeedSections}
          restoreIgnoredUnsetMapSections={restoreIgnoredUnsetMapSections}
          saveMapSection={saveMapSection}
          scheduledOrExpiredRuleCount={scheduledOrExpiredRuleCount}
          selectMapSection={selectMapSection}
          selectNewMapPoint={selectNewMapPoint}
          selectedBlockingOverlap={selectedBlockingOverlap}
          selectedEvidence={selectedEvidence}
          selectedImpactPreview={selectedImpactPreview}
          selectedRecommendation={selectedRecommendation}
          selectedSection={selectedSection}
          selectedSectionPointCount={selectedSectionPointCount}
          selectedSectionReason={selectedSectionReason}
          setMapDraft={setMapDraft}
          setMapLayers={setMapLayers}
          setMapQuery={setMapQuery}
          setStatus={setStatus}
          snapSelectedSectionToTrips={snapSelectedSectionToTrips}
          speedQuickPicks={speedQuickPicks}
          speedUnit={speedUnit}
          splitMapSection={splitMapSection}
          startAddingSection={startAddingSection}
          toggleAutoSnapTrace={toggleAutoSnapTrace}
          traceLengthM={traceLengthM}
          traceQuality={traceQuality}
          trimSavedMapSection={trimSavedMapSection}
          tripEvidenceLayersRequested={tripEvidenceLayersRequested}
          undoAddPoint={undoAddPoint}
          units={units}
        />
      )}

      {activeWorkspace === 'saved' && (
        <SpeedLimitSavedWorkspace
          busyGeohash={busyGeohash}
          confirmSelectedAsPosted={confirmSelectedAsPosted}
          deleteSelectedRows={deleteSelectedRows}
          filteredRows={filteredRows}
          geometryIndexState={geometryIndexState}
          health={health}
          linkedTrip={linkedTrip}
          removeRow={removeRow}
          resolveSavedSpeedConflict={resolveSavedSpeedConflict}
          rowCardModels={rowCardModels}
          rowFilter={rowFilter}
          rowQueryInput={rowQueryInput}
          rowSort={rowSort}
          rows={rows}
          saveRow={saveRow}
          savedRowsListRef={savedRowsListRef}
          savedRowsVirtualizer={savedRowsVirtualizer}
          selectVisibleRows={selectVisibleRows}
          selectedRows={selectedRows}
          speedQuickPicks={speedQuickPicks}
          speedUnit={speedUnit}
          toggleSelectedRow={toggleSelectedRow}
          units={units}
          updateDraft={updateDraft}
          updateRowFilter={updateRowFilter}
          updateRowQuery={updateRowQuery}
          updateRowSort={updateRowSort}
          virtualRowItems={virtualRowItems}
          visibleRowImpactByKey={visibleRowImpactByKey}
          visibleRows={visibleRows}
        />
      )}

      {activeWorkspace === 'console' && (
        <SectionErrorBoundary
          context="speed_limits_diagnostics"
          title="Speed diagnostics unavailable"
          message="Something went wrong while preparing the speed diagnostics. Reload to try again."
        >
          <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading speed diagnostics…</div>}>
            <SpeedIntelligenceConsole units={units} />
          </Suspense>
        </SectionErrorBoundary>
      )}

      <details className="group rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-2 font-semibold">
            <Info className="h-4 w-4 flex-shrink-0" />
            <span>How saved road speeds are used</span>
          </span>
          <span className="shrink-0 rounded-lg border border-blue-200 bg-white/70 px-2 py-1 text-xs font-semibold text-blue-900 group-open:hidden dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-100">
            Details
          </span>
          <span className="hidden shrink-0 rounded-lg border border-blue-200 bg-white/70 px-2 py-1 text-xs font-semibold text-blue-900 group-open:inline dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-100">
            Hide
          </span>
        </summary>
        <div className="mt-3 grid gap-2 border-t border-blue-200 pt-3 text-xs leading-relaxed dark:border-blue-900/60 md:grid-cols-2">
          <p>
            Speeds you add, edit, split, expire, or delete here are saved locally on this device. When a saved rule matches the road, direction, date, and time, Road Sage uses it first for trip scoring, map colors, speed checks, and voice alerts.
          </p>
          <p>
            If no matching saved rule is available, Road Sage falls back to learned local data, OpenStreetMap/Get Road Data results, then lower-confidence road-type, regional, or GPS estimates.
          </p>
          <p>
            Saving and reviewing road speeds here can reduce how often you need OpenStreetMap lookups for the same roads. Your saved speed, road name, notes, split sections, direction rules, and time rules are not uploaded to OpenStreetMap.
          </p>
          <p>
            Get Road Data sends only privacy-filtered public-road bounding boxes to an OpenStreetMap Overpass service, which may receive normal network metadata such as your IP address. Privacy zones reduce what enabled road-data features can send, but they are not an absolute protection against device compromise, modified app builds, screenshots, exported files, network metadata, or user-approved external endpoints.
          </p>
          <p>
            This map uses OpenStreetMap tiles while online. Saved roads, trip geometry, editing, and speed labels remain available offline, but standard OpenStreetMap tiles are not downloaded for offline use. Tile providers can see the map tile area viewed and normal network metadata.
          </p>
          <p>
            Settings warning margins change when Road Sage warns you; they do not change the saved speed itself.
          </p>
        </div>
      </details>
    </div>
  );
}
