// @ts-check
// The "Map" workspace of src/pages/SpeedLimits.jsx — the road-line editor,
// its layer controls, and the selected-section inspector.
//
// Kept under src/components/speedLimits/ on purpose: the SpeedLimit* basename
// keeps numericDisplayConsistency's configuration-surface exemption applying,
// and the directory is what src/lib/__tests__/helpers/pageSourceBundle.js
// bundles with the page so the banned-wording and privacy scans keep reading
// this text instead of silently passing on nothing.
import { AlertTriangle, Ban, GitMerge, Gauge, Info, Magnet, Map as MapIcon, Pencil, Plus, RefreshCw, Scissors, Search, Trash2, Undo2, X } from 'lucide-react';
import SpeedLimitEditorMap from '@/components/SpeedLimitEditorMap';
import {
  SPEED_RULE_QUALIFIER_OPTIONS,
  TIME_RULE_DAY_OPTIONS,
  normalizedDraftDays,
  qualifierDraftError,
  qualifierDraftPatch,
  qualifierStatusForDraft,
} from '@/components/speedLimits/speedRuleDrafts';
import { formatSourceList, formatSpeedLimit } from '@/components/speedLimits/speedRuleFormatting';
import { hasTracedRoadGeometry } from '@/components/speedLimits/speedRuleGeometry';
import { correctionKey, isUnsetMapSection } from '@/components/speedLimits/speedRuleSections';
import { TRIAGE_DISABLE_MAPS } from '@/lib/performanceTriage';
import { MAX_SAVED_SPEED_LIMIT_KMH } from '@/lib/speedKnowledgeCellPolicy';
import { speedLimitConfidenceLabel } from '@/lib/speedLimitConfidence';
import {
  speedLimitScorePreview,
  speedLimitSourceBadgeClass,
  speedLimitSourceLabel,
} from '@/lib/speedLimitDisplay';
import { speedLimitColor } from '@/lib/speedLimitMapSections';
import { convertDisplaySpeedToKmh, convertSpeedKmh, speedInputValueFromKmh } from '@/lib/unitFormatting';


/**
 * Workspace block props-threaded out of the page body. Owns no state and
 * runs no hooks, so every value it renders arrives as a prop.
 */
export default function SpeedLimitMapWorkspace({
  addMode,
  addPath,
  autoSnapTrace,
  busyGeohash,
  canSaveSelectedMapSection,
  cancelAddSection,
  closeMapEditor,
  currentMapRows,
  deferredMapQuery,
  editorWarnings,
  excludedSpeedSectionCount,
  firstConflictSection,
  focusAttentionItem,
  hiddenUnsetSectionCount,
  historicalRuleCount,
  ignoreUnsetMapSection,
  loadMapModel,
  mapDisplayTrips,
  mapDraft,
  mapLayers,
  mapModelLoading,
  mapModelState,
  mapQuery,
  mapSections,
  markSelectedSectionPrivate,
  mergeCandidate,
  moveAddPoint,
  moveSelectedSectionEndpoint,
  persistedExcludedSpeedSections,
  prepareMergeWithNearbySection,
  removeMapSection,
  resolveSavedSpeedConflict,
  restoreExcludedSpeedSections,
  restoreIgnoredUnsetMapSections,
  saveMapSection,
  scheduledOrExpiredRuleCount,
  selectMapSection,
  selectNewMapPoint,
  selectedBlockingOverlap,
  selectedEvidence,
  selectedImpactPreview,
  selectedRecommendation,
  selectedSection,
  selectedSectionPointCount,
  selectedSectionReason,
  setMapDraft,
  setMapLayers,
  setMapQuery,
  setStatus,
  snapSelectedSectionToTrips,
  speedQuickPicks,
  speedUnit,
  splitMapSection,
  startAddingSection,
  toggleAutoSnapTrace,
  traceLengthM,
  traceQuality,
  trimSavedMapSection,
  tripEvidenceLayersRequested,
  undoAddPoint,
  units,
}) {
  return (
      <section className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <MapIcon className="h-5 w-5 text-primary" />
              <h2 className="font-grotesk text-lg font-bold">Road speed map</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Only posted signs you confirmed are solid. Saved estimates, Road Memory, and temporary trip evidence stay dashed; red sections disagree with a saved rule.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <div className="flex flex-wrap justify-start gap-2 sm:justify-end">
              {firstConflictSection && (
                <button
                  type="button"
                  onClick={() => focusAttentionItem({ kind: 'conflict', section: firstConflictSection })}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Review conflict
                </button>
              )}
              <button
                type="button"
                onClick={addMode ? cancelAddSection : startAddingSection}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold ${
                  addMode ? 'border border-border bg-secondary text-foreground' : 'bg-primary text-primary-foreground'
                }`}
              >
                {addMode ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                {addMode ? 'Cancel adding' : 'Add road speed'}
              </button>
              {hiddenUnsetSectionCount > 0 && (
                <button
                  type="button"
                  onClick={restoreIgnoredUnsetMapSections}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  Restore hidden unset {hiddenUnsetSectionCount}
                </button>
              )}
              {excludedSpeedSectionCount > 0 && (
                <details className="relative">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary [&::-webkit-details-marker]:hidden">
                    <Undo2 className="h-3.5 w-3.5" />
                    Manage exclusions {excludedSpeedSectionCount}
                  </summary>
                  <div className="absolute right-0 z-30 mt-2 w-80 space-y-2 rounded-xl border border-border bg-card p-3 shadow-xl">
                    <p className="text-[11px] text-muted-foreground">These sections cannot be learned, matched, scored, or used for alerts.</p>
                    {persistedExcludedSpeedSections.map((exclusion) => {
                      const restoreId = exclusion.id || exclusion.exclusionId || exclusion.geohash;
                      return (
                        <div key={restoreId} className="flex items-center justify-between gap-2 rounded-lg bg-secondary/60 px-2.5 py-2">
                          <span className="min-w-0 truncate text-xs font-semibold">
                            {exclusion.roadName || `Private section ${String(exclusion.geohash || '').slice(0, 6)}`}
                          </span>
                          <button
                            type="button"
                            onClick={() => restoreExcludedSpeedSections(exclusion)}
                            disabled={String(busyGeohash || '').startsWith('restore-excluded-')}
                            className="shrink-0 rounded-lg border border-border bg-background px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
                          >
                            Allow
                          </button>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => restoreExcludedSpeedSections()}
                      disabled={String(busyGeohash || '').startsWith('restore-excluded-')}
                      className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-xs font-semibold disabled:opacity-50"
                    >
                      Allow learning on all {excludedSpeedSectionCount}
                    </button>
                  </div>
                </details>
              )}
              {addMode && (
                <button
                  type="button"
                  onClick={toggleAutoSnapTrace}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold ${
                    autoSnapTrace
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200'
                      : 'border-border bg-card text-muted-foreground'
                  }`}
                  aria-pressed={autoSnapTrace}
                >
                  <Magnet className="h-3.5 w-3.5" />
                  Auto snap
                </button>
              )}
            </div>
            <label className="relative w-full sm:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={mapQuery}
                onChange={(event) => setMapQuery(event.target.value)}
                placeholder="Search map by road, source, speed..."
                className="w-full rounded-xl border border-border bg-background py-2 pl-9 pr-3 text-xs outline-none focus:border-primary"
              />
            </label>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span><span className="mr-1 inline-block h-2.5 w-5 rounded bg-slate-400" />Not set</span>
              <span><span className="mr-1 inline-block h-2.5 w-5 rounded border-2 border-dashed border-sky-500 bg-sky-100" />Road Memory estimate</span>
              <span><span className="mr-1 inline-block h-2.5 w-5 rounded border-2 border-dotted border-sky-500 bg-sky-50" />Trip evidence</span>
              <span><span className="mr-1 inline-block h-2.5 w-5 rounded border-2 border-dashed border-red-600 bg-red-100" />Conflict</span>
              {[30, 40, 50, 60, 80, 100].map((limit) => (
                <span key={limit}>
                  <span className="mr-1 inline-block h-2.5 w-5 rounded" style={{ backgroundColor: speedLimitColor(limit) }} />
                  {Math.round(convertSpeedKmh(limit, units) || limit)}
                </span>
              ))}
              <span>{speedUnit}</span>
            </div>
          </div>
        </div>

        {mapModelLoading && (
          <div className="flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-200" role="status">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            Saved roads are ready. Adding recent trip evidence in the background…
          </div>
        )}
        {!tripEvidenceLayersRequested && (
          <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
            <Gauge className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Fast start is on: only saved posted-sign roads are loaded. Open Filters to load Road Memory, estimates, observed roads, or roads without a saved speed.
            </span>
          </div>
        )}
        {(historicalRuleCount + scheduledOrExpiredRuleCount) > 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-medium text-violet-900 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-100">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              This map shows rules active right now. Saved roads keeps {historicalRuleCount} historical and {scheduledOrExpiredRuleCount} future/expired version{historicalRuleCount + scheduledOrExpiredRuleCount === 1 ? '' : 's'} in the visible timeline; use the Historical or Expiring filters to inspect them.
            </span>
          </div>
        )}
        {mapModelState.status === 'error' && (
          <div className="flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200 sm:flex-row sm:items-center sm:justify-between">
            <span>Trip evidence could not load. The saved-road map is still available.</span>
            <button
              type="button"
              onClick={() => loadMapModel({ force: true })}
              className="inline-flex items-center justify-center rounded-lg border border-current/30 px-2.5 py-1 font-semibold hover:bg-background/50"
            >
              Retry trip evidence
            </button>
          </div>
        )}

        {TRIAGE_DISABLE_MAPS ? (
          <div className="flex h-[28rem] min-h-[22rem] items-center justify-center rounded-2xl border border-border bg-secondary/30 text-sm text-muted-foreground">
            Map disabled for Phase 0 timing test
          </div>
        ) : <SpeedLimitEditorMap
          trips={mapDisplayTrips}
          corrections={currentMapRows}
          preparedSections={mapSections}
          selectedGeohash={correctionKey(selectedSection) || ''}
          mapQuery={deferredMapQuery}
          layers={mapLayers}
          addMode={addMode}
          addPath={addPath}
          selectedSectionOverride={selectedSection}
          onLayerChange={setMapLayers}
          onSelect={selectMapSection}
          onAddPoint={selectNewMapPoint}
          onMoveAddPoint={moveAddPoint}
          onMoveSectionPoint={moveSelectedSectionEndpoint}
          emptyMessage={!tripEvidenceLayersRequested
            ? 'No saved posted-sign road lines yet. Open Filters to load other local road evidence.'
            : undefined}
        />}

        {addMode && (
          <div className="grid gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950 shadow-sm dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <div className="font-semibold">Add speed trace</div>
              <div className="mt-1 text-xs opacity-85">
                {autoSnapTrace
                  ? 'Tap the start and end of the segment; Auto snap fills the recorded route shape when possible. Drag trace points if needed, then enter the speed below.'
                  : 'Tap along the road, drag trace points if needed, then enter the speed below.'}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs font-semibold">
                <span className="rounded-full bg-background/80 px-2 py-1">{addPath.length} point{addPath.length === 1 ? '' : 's'}</span>
                <span className="rounded-full bg-background/80 px-2 py-1">{Math.round(traceLengthM)} m traced</span>
                <span className="rounded-full bg-background/80 px-2 py-1">{autoSnapTrace ? 'Auto snap on' : 'Auto snap off'}</span>
              </div>
            </div>
            {traceQuality && (
              <div className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                traceQuality.level === 'good'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200'
                  : traceQuality.level === 'info'
                    ? 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200'
                    : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100'
              }`}>
                {traceQuality.text}
              </div>
            )}
          </div>
        )}

        <details className="rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-semibold text-foreground">What the map actions do</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <p><strong>Snap to route</strong> matches the trace to one ordered recorded route segment within 80 metres. It never contacts a routing service.</p>
            <p><strong>Split at midpoint</strong> replaces one saved rule with two independently editable road sections.</p>
            <p><strong>Trim start/end</strong> removes one bad tail point from a saved rule and immediately updates affected trip scores.</p>
            <p><strong>Parking/private</strong> removes a saved rule or hides an unset section when it is a lot, driveway, or private access road.</p>
            <p><strong>Edit trace points</strong> hides the selected section&apos;s old line while editing. Drag S, E, or numbered bend handles, then update the road speed to save the new geometry.</p>
            <p><strong>Merge nearby</strong> joins two nearby saved sections only when their speeds match.</p>
            <p><strong>Continue tracing</strong> means the road is still being drawn. It disappears immediately after a successful save.</p>
          </div>
        </details>

        {selectedSection && (
          <div className="max-h-[78vh] overflow-y-auto rounded-2xl border border-primary/30 bg-card p-4 shadow-sm sm:max-h-none sm:overflow-visible">
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
                      ? `${addPath.length} trace point${addPath.length === 1 ? '' : 's'}. ${autoSnapTrace ? 'Tap start and end; add more anchors only if the road match needs help.' : 'Tap along the road and around each bend; at least two points are required.'}`
                    : `${selectedSectionPointCount} recorded point${selectedSectionPointCount === 1 ? '' : 's'} in this trip section. Enter the speed and save it as a road section.`}
                </p>
                {selectedSectionReason && (
                  <div className="mt-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                    {selectedSectionReason}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold">
                  <span className={`rounded-full px-2 py-0.5 ${speedLimitSourceBadgeClass(mapDraft.source)}`}>
                    {speedLimitSourceLabel(mapDraft.source, { short: true })}
                  </span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">
                    {speedLimitScorePreview(selectedSection.limitKmh ?? selectedSection.observedLimitKmh, mapDraft.limitKmh)}
                  </span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">
                    Observed {formatSpeedLimit(selectedSection.observedLimitKmh ?? selectedSection.effectiveLimitKmh, units)}
                  </span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">
                    {formatSourceList(selectedSection.observedSources)}
                  </span>
                  {selectedEvidence && (
                    <span className={`rounded-full px-2 py-0.5 ${
                      selectedEvidence.level === 'high'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                        : selectedEvidence.level === 'medium'
                          ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
                          : 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100'
                    }`}>
                      {speedLimitConfidenceLabel(selectedEvidence)} {selectedEvidence.confidencePercent}%
                    </span>
                  )}
                  {selectedImpactPreview && (
                    <span className="rounded-full bg-slate-900 px-2 py-0.5 text-white dark:bg-slate-100 dark:text-slate-900">
                      {selectedImpactPreview.affectedTripCount} affected trip{selectedImpactPreview.affectedTripCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {selectedSection.conflict && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-700 dark:bg-red-950/40 dark:text-red-300">
                      Saved {formatSpeedLimit(selectedSection.conflict.savedLimitKmh, units)} vs observed {formatSpeedLimit(selectedSection.conflict.observedLimitKmh, units)}
                    </span>
                  )}
                </div>
                {!selectedSection.saved && addPath.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={undoAddPoint}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary px-2.5 py-1.5 text-xs font-semibold"
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                      Undo last point
                    </button>
                    <button
                      type="button"
                      onClick={snapSelectedSectionToTrips}
                      disabled={selectedSectionPointCount < 2}
                      title="Match the trace to one ordered recorded route segment within 80 metres. No online routing service is used."
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                    >
                      <Magnet className="h-3.5 w-3.5" />
                      Snap to route
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={closeMapEditor}
                className="rounded-lg p-2 text-muted-foreground hover:bg-secondary"
                aria-label="Close road speed editor"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-[14rem_1fr_1fr_auto] xl:items-end">
              <label className="grid gap-1 text-xs font-semibold">
                Speed limit
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={units === 'imperial' ? 3 : 5}
                    max={Math.floor(convertSpeedKmh(MAX_SAVED_SPEED_LIMIT_KMH, units) || MAX_SAVED_SPEED_LIMIT_KMH)}
                    step="5"
                    autoFocus
                    value={speedInputValueFromKmh(mapDraft.limitKmh, units)}
                    onChange={(event) => setMapDraft((current) => {
                      const canonical = convertDisplaySpeedToKmh(event.target.value, units);
                      return { ...current, limitKmh: canonical == null ? '' : String(canonical) };
                    })}
                    className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <span className="text-muted-foreground">{speedUnit}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {speedQuickPicks.map((limit) => (
                    <button
                      key={limit}
                      type="button"
                      onClick={() => setMapDraft((current) => ({
                        ...current,
                        limitKmh: String(convertDisplaySpeedToKmh(limit, units) ?? limit),
                      }))}
                      className={`rounded-lg border px-2 py-1 text-[11px] font-semibold ${
                        Math.round(convertSpeedKmh(mapDraft.limitKmh, units) || 0) === limit
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-secondary text-foreground hover:bg-secondary/80'
                      }`}
                    >
                      {limit}
                    </button>
                  ))}
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
                How do you know?
                <select
                  value={mapDraft.source}
                  onChange={(event) => setMapDraft((current) => ({ ...current, source: event.target.value }))}
                  className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value="user_confirmed_posted_sign">Posted sign</option>
                  <option value="user_entered_estimate">Estimate</option>
                </select>
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveMapSection}
                  disabled={busyGeohash === correctionKey(selectedSection) || !canSaveSelectedMapSection}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {selectedSection.saved ? <Pencil className="h-3.5 w-3.5" /> : <Gauge className="h-3.5 w-3.5" />}
                  {selectedSection.saved ? 'Update road speed' : 'Save road speed'}
                </button>
                {selectedSection.saved && (
                  <button
                    type="button"
                    onClick={removeMapSection}
                    disabled={busyGeohash === correctionKey(selectedSection)}
                    className="inline-flex items-center justify-center rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-red-700 disabled:opacity-60 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                    aria-label="Remove saved speed"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
                {!selectedSection.saved && isUnsetMapSection(selectedSection) && (
                  <button
                    type="button"
                    onClick={ignoreUnsetMapSection}
                    disabled={busyGeohash === correctionKey(selectedSection)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-60"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Hide unset
                  </button>
                )}
              </div>
            </div>
            {!selectedSection.saved && isUnsetMapSection(selectedSection) && (
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-950/30 dark:text-slate-200">
                Hide unset removes this small prompt from the saved speed map and review list on this device. It does not delete the trip route.
              </div>
            )}
            <details className="mt-3 rounded-xl border border-border bg-secondary/30 p-3">
              <summary className="cursor-pointer text-xs font-semibold text-foreground">Cleanup and trace tools</summary>
              <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="text-xs font-semibold text-foreground">Cleanup tools</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Parking/private permanently blocks this geometry from learning, saved-speed matching, scores, alerts, and review prompts until you explicitly allow learning again.
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {selectedSection.saved && (
                    <>
                      <button
                        type="button"
                        onClick={() => trimSavedMapSection('start')}
                        disabled={busyGeohash === correctionKey(selectedSection) || (selectedSection.sectionPoints || []).length < 3}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-60"
                      >
                        <Scissors className="h-3.5 w-3.5" />
                        Trim start
                      </button>
                      <button
                        type="button"
                        onClick={() => trimSavedMapSection('end')}
                        disabled={busyGeohash === correctionKey(selectedSection) || (selectedSection.sectionPoints || []).length < 3}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-60"
                      >
                        <Scissors className="h-3.5 w-3.5" />
                        Trim end
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={markSelectedSectionPrivate}
                    disabled={busyGeohash === correctionKey(selectedSection)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
                  >
                    <Ban className="h-3.5 w-3.5" />
                    Parking/private
                  </button>
                </div>
              </div>
            </details>
            {editorWarnings.length > 0 && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                {editorWarnings[0]}
                {editorWarnings.length > 1 && ` +${editorWarnings.length - 1} more check${editorWarnings.length === 2 ? '' : 's'} in Advanced options.`}
              </div>
            )}
            {selectedBlockingOverlap && (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                <div className="font-semibold">This save would duplicate an active saved rule.</div>
                <div className="mt-1">
                  Overlaps {selectedBlockingOverlap.roadName || 'another saved road section'} at {formatSpeedLimit(selectedBlockingOverlap.limitKmh, units)}.
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedBlockingOverlap.section && (
                    <button
                      type="button"
                      onClick={() => selectMapSection(selectedBlockingOverlap.section)}
                      className="rounded-lg border border-red-200 bg-background px-2.5 py-1.5 font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/50 dark:bg-background/80 dark:text-red-300"
                    >
                      Edit existing rule
                    </button>
                  )}
                  {selectedSection?.saved && (
                    <button
                      type="button"
                      onClick={splitMapSection}
                      disabled={(selectedSection.sectionPoints || []).length < 2}
                      className="rounded-lg border border-red-200 bg-background px-2.5 py-1.5 font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-900/50 dark:bg-background/80 dark:text-red-300"
                    >
                      Split selected section
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setMapDraft((current) => ({
                        ...current,
                        directionMode: current.directionMode === 'both' ? 'forward' : current.directionMode,
                      }));
                      setStatus('Set this rule to a specific direction or time window, then review the overlap warning again before saving.');
                    }}
                    className="rounded-lg border border-red-200 bg-background px-2.5 py-1.5 font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/50 dark:bg-background/80 dark:text-red-300"
                  >
                    Make direction/time distinct
                  </button>
                </div>
              </div>
            )}
            <details className="mt-3 rounded-xl border border-border bg-secondary/30 p-3">
              <summary className="cursor-pointer text-xs font-semibold text-foreground">Advanced options</summary>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <label className="grid gap-1 text-xs font-semibold">
                  Note
                  <input
                    type="text"
                    value={mapDraft.note}
                    onChange={(event) => setMapDraft((current) => ({ ...current, note: event.target.value }))}
                    placeholder="School zone, construction, sign changed..."
                    className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                </label>
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
                  Rule type
                  <select
                    value={qualifierStatusForDraft(mapDraft)}
                    onChange={(event) => setMapDraft((current) => ({
                      ...current,
                      ...qualifierDraftPatch(event.target.value, current),
                    }))}
                    className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  >
                    {SPEED_RULE_QUALIFIER_OPTIONS.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
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
                    <option value="custom">Choose days</option>
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
              </div>
              <div className="mt-3 grid gap-3 md:max-w-2xl md:grid-cols-2">
                <label className="grid gap-1 text-xs font-semibold">
                  Effective from
                  <input
                    type="date"
                    value={mapDraft.validFromDate}
                    onChange={(event) => setMapDraft((current) => ({ ...current, validFromDate: event.target.value }))}
                    className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <span className="font-normal text-muted-foreground">Blank applies to all recorded history. Changing a speed with a new date preserves the older rule for earlier trips.</span>
                </label>
                <label className="grid content-start gap-1 text-xs font-semibold">
                  Active until
                  <input
                    type="date"
                    value={mapDraft.expiresAtDate}
                    onChange={(event) => setMapDraft((current) => ({ ...current, expiresAtDate: event.target.value }))}
                    className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <span className="font-normal text-muted-foreground">Blank means no expiry. Daily schedules use the UTC offset recorded with each trip point.</span>
                </label>
              </div>
              {mapDraft.timeRuleMode === 'custom' && (
                <fieldset className="mt-3 rounded-xl border border-border bg-background p-3">
                  <legend className="px-1 text-xs font-semibold">Active weekdays</legend>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {TIME_RULE_DAY_OPTIONS.map(([day, label]) => (
                      <label key={day} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold">
                        <input
                          type="checkbox"
                          checked={normalizedDraftDays(mapDraft).includes(day)}
                          onChange={(event) => setMapDraft((current) => ({
                            ...current,
                            customDays: event.target.checked
                              ? [...new Set([...(current.customDays || []), day])]
                              : (current.customDays || []).filter((item) => Number(item) !== day),
                          }))}
                          className="accent-primary"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              {qualifierDraftError(mapDraft) && (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                  {qualifierDraftError(mapDraft)}
                </div>
              )}
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <div className="rounded-xl border border-border bg-background p-3 text-xs">
                  <div className="font-semibold text-foreground">Rule intelligence</div>
                  <div className="mt-1 text-muted-foreground">
                    {selectedRecommendation?.text || 'Enter a speed limit to calculate a recommendation.'}
                  </div>
                  {selectedImpactPreview && (
                    <div className="mt-2">
                      {selectedImpactPreview.affectedTripCount} affected trip{selectedImpactPreview.affectedTripCount === 1 ? '' : 's'} · {selectedImpactPreview.matchedPointCount} matched points · {selectedImpactPreview.estimatedEventCount} likely events
                    </div>
                  )}
                </div>
                <div className="rounded-xl border border-border bg-background p-3 text-xs">
                  <div className="font-semibold text-foreground">Validation</div>
                  {editorWarnings.length > 0 ? (
                    <div className="mt-2 space-y-1 text-muted-foreground">
                      {editorWarnings.map((warning) => <div key={warning}>- {warning}</div>)}
                    </div>
                  ) : (
                    <div className="mt-2 text-emerald-700 dark:text-emerald-300">Geometry, evidence, and trip coverage checks passed.</div>
                  )}
                </div>
              </div>
              {selectedSection.saved && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={snapSelectedSectionToTrips}
                    disabled={busyGeohash === correctionKey(selectedSection) || (selectedSection.sectionPoints || []).length < 2}
                    title="Match this saved geometry to one ordered recorded route segment within 80 metres. No online routing service is used."
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-60"
                  >
                    <Magnet className="h-3.5 w-3.5" />
                    Snap to route
                  </button>
                  <button
                    type="button"
                    onClick={splitMapSection}
                    disabled={busyGeohash === correctionKey(selectedSection) || (selectedSection.sectionPoints || []).length < 2}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-60"
                  >
                    Split at midpoint
                  </button>
                  {mergeCandidate && (
                    <button
                      type="button"
                      onClick={prepareMergeWithNearbySection}
                      disabled={busyGeohash === correctionKey(selectedSection)}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-60"
                    >
                      <GitMerge className="h-3.5 w-3.5" />
                      Merge nearby ({Math.round(mergeCandidate.distanceM)} m)
                    </button>
                  )}
                </div>
              )}
            </details>
            {selectedSection.conflict && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                <span>
                  Conflict: saved {formatSpeedLimit(selectedSection.conflict.savedLimitKmh, units)}, trip data suggests {formatSpeedLimit(selectedSection.conflict.observedLimitKmh, units)}
                </span>
                {!hasTracedRoadGeometry(selectedSection) && (
                  <span className="w-full font-medium">
                    Trace at least two distinct road points before choosing a value. Point-only rules stay blocked from scores and alerts.
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => resolveSavedSpeedConflict(selectedSection, selectedSection.conflict, 'use_observed', mapDraft)}
                  disabled={busyGeohash === correctionKey(selectedSection) || !hasTracedRoadGeometry(selectedSection)}
                  className="rounded-lg bg-red-600 px-2.5 py-1.5 text-white hover:bg-red-700 disabled:opacity-60"
                >
                  Use observed {formatSpeedLimit(selectedSection.conflict.observedLimitKmh, units)}
                </button>
                <button
                  type="button"
                  onClick={() => resolveSavedSpeedConflict(selectedSection, selectedSection.conflict, 'keep_saved', mapDraft)}
                  disabled={busyGeohash === correctionKey(selectedSection) || !hasTracedRoadGeometry(selectedSection)}
                  className="rounded-lg border border-red-200 bg-background px-2.5 py-1.5 text-red-700 hover:bg-red-100 disabled:opacity-60 dark:border-red-900/50 dark:bg-background/80 dark:text-red-300"
                >
                  Keep saved {formatSpeedLimit(selectedSection.conflict.savedLimitKmh, units)}
                </button>
              </div>
            )}
          </div>
        )}
      </section>
  );
}
