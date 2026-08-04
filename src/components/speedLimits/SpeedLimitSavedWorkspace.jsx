// @ts-check
// The "Saved roads" workspace of src/pages/SpeedLimits.jsx.
//
// Kept under src/components/speedLimits/ on purpose:
//   - the SpeedLimit* basename is what keeps numericDisplayConsistency's
//     configuration-surface exemption applying to it, and
//   - the directory is what src/lib/__tests__/helpers/pageSourceBundle.js
//     bundles with the page, so the banned-wording and privacy scans keep
//     reading this text instead of silently passing on nothing.
import { Link } from 'react-router-dom';
import { CheckSquare2, Gauge, MapPin, Pencil, Search, ShieldCheck, SlidersHorizontal, Trash2 } from 'lucide-react';
import RoadSectionPreview from '@/components/RoadSectionPreview';
import WhyThisSpeed from '@/components/WhyThisSpeed';
import {
  SPEED_RULE_QUALIFIER_OPTIONS,
  TIME_RULE_DAY_OPTIONS,
  invalidCustomDayRule,
  invalidValidityWindow,
  normalizedDraftDays,
  qualifierDraftError,
  qualifierDraftPatch,
  qualifierStatusForDraft,
  qualifierStatusLabel,
  timeRuleLabel,
} from '@/components/speedLimits/speedRuleDrafts';
import {
  coordinateLabel,
  directionLabel,
  expiryLabel,
  formatCoordinate,
  formatDate,
  formatSpeedLimit,
  sourceLabel,
  validFromLabel,
} from '@/components/speedLimits/speedRuleFormatting';
import { hasTracedRoadGeometry } from '@/components/speedLimits/speedRuleGeometry';
import { correctionKey } from '@/components/speedLimits/speedRuleSections';
import { MAX_SAVED_SPEED_LIMIT_KMH } from '@/lib/speedKnowledgeCellPolicy';
import { speedLimitConfidenceLabel } from '@/lib/speedLimitConfidence';
import { speedLimitScorePreview, speedLimitSourceBadgeClass } from '@/lib/speedLimitDisplay';
import { convertDisplaySpeedToKmh, convertSpeedKmh, speedInputValueFromKmh } from '@/lib/unitFormatting';

const ROW_FILTERS = [
  ['all', 'All'],
  ['conflicts', 'Conflicts'],
  ['posted', 'Posted'],
  ['estimates', 'Estimates'],
  ['timeRules', 'Timed'],
  ['expiring', 'Expiring'],
  ['historical', 'Historical'],
];
/** @type {Array<[string, string]>} */
const ROW_SORTS = [
  ['updated', 'Recently updated'],
  ['impact', 'Conflict impact'],
  ['road', 'Road name'],
  ['limit', 'Speed limit'],
];

/**
 * The "Saved roads" workspace. Props-threaded out of the page body so the
 * block can be reviewed and moved on its own; it owns no state and runs no
 * hooks, so every value it renders arrives as a prop.
 */
export default function SpeedLimitSavedWorkspace({
  busyGeohash,
  confirmSelectedAsPosted,
  deleteSelectedRows,
  filteredRows,
  geometryIndexState,
  health,
  linkedTrip,
  removeRow,
  resolveSavedSpeedConflict,
  rowCardModels,
  rowFilter,
  rowQueryInput,
  rowSort,
  rows,
  saveRow,
  savedRowsListRef,
  savedRowsVirtualizer,
  selectVisibleRows,
  selectedRows,
  speedQuickPicks,
  speedUnit,
  toggleSelectedRow,
  units,
  updateDraft,
  updateRowFilter,
  updateRowQuery,
  updateRowSort,
  virtualRowItems,
  visibleRowImpactByKey,
  visibleRows,
}) {
  return (
    <>
      <section className="space-y-3">
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-primary" />
              <h2 className="font-grotesk text-lg font-bold">Saved speed rules</h2>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                {filteredRows.length} shown
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Search, triage, and edit local speed rules without hunting through every saved road area.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_11rem] lg:w-[34rem]">
            <label className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={rowQueryInput}
                onChange={(event) => updateRowQuery(event.target.value)}
                placeholder="Search saved speeds..."
                className="w-full rounded-xl border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:border-primary"
              />
            </label>
            <select
              value={rowSort}
              onChange={(event) => updateRowSort(event.target.value)}
              className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              aria-label="Sort saved speeds"
            >
              {ROW_SORTS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {ROW_FILTERS.map(([value, label]) => {
            const active = rowFilter === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => updateRowFilter(value)}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-foreground hover:bg-secondary'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        {rows.length > 0 && (
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-2 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={selectVisibleRows}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold hover:bg-secondary"
            >
              <CheckSquare2 className="h-3.5 w-3.5" />
              {visibleRows.some((row) => row.historicalVersion !== true) && visibleRows
                .filter((row) => row.historicalVersion !== true)
                .every((row) => selectedRows.has(correctionKey(row)))
                ? 'Clear visible'
                : 'Select visible'}
            </button>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">{selectedRows.size} selected</span>
              <button
                type="button"
                onClick={confirmSelectedAsPosted}
                disabled={selectedRows.size === 0 || busyGeohash === 'bulk'}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Confirm posted
              </button>
              <button
                type="button"
                onClick={deleteSelectedRows}
                disabled={selectedRows.size === 0 || busyGeohash === 'bulk'}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-40 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </div>
          </div>
        )}
      </section>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
              <Gauge className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">No manually saved rules</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Road Memory can still learn automatically from repeated drives. Use a trip review when you want to confirm a posted sign or correct an estimate.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4">
                <span className="rounded-lg bg-background/80 px-2 py-1.5">
                  <strong>{health?.geometryCount || 0}/{health?.geometryTotal || 0}</strong> with full lines
                </span>
                <span className="rounded-lg bg-background/80 px-2 py-1.5">
                  <strong>{health?.operationalRoadMemoryCount || 0}</strong> active memory
                </span>
                <span className="rounded-lg bg-background/80 px-2 py-1.5">
                  <strong>{health?.learningRoadMemoryCount || 0}</strong> learning
                </span>
                <span className="rounded-lg bg-background/80 px-2 py-1.5">
                  <strong>{geometryIndexState.indexedTripCount || 0}/{geometryIndexState.totalAvailable || 0}</strong> trip routes indexed
                </span>
              </div>
            </div>
          </div>
          <Link
            to="/trips"
            className="mt-4 inline-flex items-center justify-center rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
          >
            Open trips
          </Link>
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          No saved speeds match the current filters.
        </div>
      ) : (
        <div
          ref={savedRowsListRef}
          className="max-h-[78vh] overflow-y-auto pr-1 thin-scrollbar"
          aria-label="Virtualized saved road speeds list"
        >
          <div
            className="relative w-full"
            style={{ height: `${savedRowsVirtualizer.getTotalSize()}px` }}
          >
          {virtualRowItems.map((virtualItem) => {
            const model = rowCardModels[virtualItem.index];
            if (!model) return null;
            const {
              key,
              row,
              draft,
              disabled,
              identity,
              conflict,
              evidence: rowEvidence,
              recommendation: rowRecommendation,
            } = model;
            const rowImpact = visibleRowImpactByKey.get(key);
            return (
              <article
                key={key}
                ref={savedRowsVirtualizer.measureElement}
                data-index={virtualItem.index}
                className="absolute left-0 top-0 w-full rounded-xl border border-border bg-card p-3 shadow-sm"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                <div className="grid gap-3 lg:grid-cols-[1fr_16rem_13rem] lg:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-background">
                        <input
                          type="checkbox"
                          checked={selectedRows.has(key)}
                          onChange={() => toggleSelectedRow(key)}
                          disabled={row.historicalVersion === true}
                          className="h-4 w-4 accent-primary"
                          aria-label={`Select ${identity.title}`}
                        />
                      </label>
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
                        <div className="font-semibold">{formatSpeedLimit(row.limitKmh, units)}</div>
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
                      <span className="rounded-full bg-secondary px-2 py-1">{qualifierStatusLabel(row.qualifierStatus)}</span>
                      <span className="rounded-full bg-secondary px-2 py-1">{timeRuleLabel(row.timeRule)}</span>
                      <span className="rounded-full bg-secondary px-2 py-1">{validFromLabel(row.validFrom)}</span>
                      <span className="rounded-full bg-secondary px-2 py-1">{expiryLabel(row.expiresAt)}</span>
                      {row.historicalVersion === true && (
                        <span className="rounded-full bg-violet-100 px-2 py-1 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200" title="Retained so trips recorded before the replacement date continue to use the rule that was active then.">
                          Historical version
                        </span>
                      )}
                      <span className={`rounded-full px-2 py-1 ${
                        rowEvidence.level === 'high'
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                          : rowEvidence.level === 'medium'
                            ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
                            : 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100'
                      }`}>
                        {speedLimitConfidenceLabel(rowEvidence)} {rowEvidence.confidencePercent}%
                      </span>
                      {rowImpact ? (
                        <span className="rounded-full bg-secondary px-2 py-1">
                          {rowImpact.affectedTripCount} affected trip{rowImpact.affectedTripCount === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span className="rounded-full bg-secondary px-2 py-1">
                          Impact loads only for visible roads after the map is opened
                        </span>
                      )}
                      <span className="rounded-full bg-secondary px-2 py-1">
                        {speedLimitScorePreview(row.limitKmh, draft.limitKmh)}
                      </span>
                      {conflict && (
                        <span className="rounded-full bg-red-100 px-2 py-1 text-red-700 dark:bg-red-950/40 dark:text-red-300">
                          Conflict: trip data suggests {formatSpeedLimit(conflict.observedLimitKmh, units)}
                        </span>
                      )}
                      {Array.isArray(row.editHistory) && row.editHistory.length > 0 && (
                        <span className="rounded-full bg-secondary px-2 py-1">{row.editHistory.length} previous edit{row.editHistory.length === 1 ? '' : 's'}</span>
                      )}
                    </div>
                    <div className="mt-2 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs">
                      <div className="font-semibold text-foreground">{rowRecommendation.action}</div>
                      <div className="mt-1 text-muted-foreground">{rowRecommendation.text}</div>
                    </div>
                    <WhyThisSpeed record={{ ...row, conflict }} className="mt-2" />
                    <details className="mt-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer font-medium">Saved location reference</summary>
                      <div className="mt-1">
                        {coordinateLabel(row.coordinateSource)}: {formatCoordinate(row.lat)}, {formatCoordinate(row.lng)}; cell {row.geohash}
                      </div>
                    </details>
                    {Array.isArray(row.auditTrail) && row.auditTrail.length > 0 && (
                      <details className="mt-2 text-xs text-muted-foreground">
                        <summary className="cursor-pointer font-medium">Audit history ({row.auditTrail.length})</summary>
                        <div className="mt-2 space-y-1">
                          {[...row.auditTrail].reverse().slice(0, 5).map((entry, index) => (
                            <div key={`${entry.changedAt}-${index}`}>
                              {formatDate(entry.changedAt)}: {String(entry.action || 'updated').replace(/_/g, ' ')}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {row.historicalVersion === true && (
                      <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-100">
                        Read-only historical rule. It is retained only so trips before {row.expiresAt ? formatDate(row.expiresAt) : 'the replacement boundary'} keep the speed rule that applied then.
                      </div>
                    )}
                  </div>

                  <details className="rounded-xl border border-border bg-secondary/25 p-2 lg:contents">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-1 py-1 text-xs font-semibold lg:hidden [&::-webkit-details-marker]:hidden">
                      <span>{row.historicalVersion === true ? 'View historical rule details' : 'Edit speed, direction, schedule, or notes'}</span>
                      <span className="rounded-lg bg-background px-2 py-1 text-[11px] text-primary">Open</span>
                    </summary>
                    <div className="mt-2 grid gap-3 lg:contents">
                  <fieldset disabled={row.historicalVersion === true} className="grid gap-2 disabled:opacity-70">
                    <label className="flex items-center gap-2 text-xs font-semibold text-foreground">
                      <Gauge className="h-4 w-4 text-muted-foreground" />
                      <input
                        type="number"
                        min={units === 'imperial' ? 3 : 5}
                        max={Math.floor(convertSpeedKmh(MAX_SAVED_SPEED_LIMIT_KMH, units) || MAX_SAVED_SPEED_LIMIT_KMH)}
                        step="5"
                        value={speedInputValueFromKmh(draft.limitKmh, units)}
                        onChange={(event) => {
                          const canonical = convertDisplaySpeedToKmh(event.target.value, units);
                          updateDraft(key, { limitKmh: canonical == null ? '' : String(canonical) });
                        }}
                        className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                      <span className="text-xs text-muted-foreground">{speedUnit}</span>
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {speedQuickPicks.map((limit) => (
                        <button
                          key={limit}
                          type="button"
                          onClick={() => updateDraft(key, {
                            limitKmh: String(convertDisplaySpeedToKmh(limit, units) ?? limit),
                          })}
                          className={`rounded-lg border px-2 py-1 text-[11px] font-semibold ${
                            Math.round(convertSpeedKmh(draft.limitKmh, units) || 0) === limit
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border bg-secondary/80 text-foreground hover:bg-secondary'
                          }`}
                        >
                          {limit}
                        </button>
                      ))}
                    </div>
                    <select
                      value={draft.source || 'user_entered_estimate'}
                      onChange={(event) => updateDraft(key, { source: event.target.value })}
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    >
                      <option value="user_confirmed_posted_sign">Posted sign</option>
                      <option value="user_entered_estimate">Estimate</option>
                    </select>
                    <select
                      value={qualifierStatusForDraft(draft)}
                      onChange={(event) => updateDraft(key, qualifierDraftPatch(event.target.value, draft))}
                      aria-label="Rule type"
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    >
                      {SPEED_RULE_QUALIFIER_OPTIONS.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={draft.roadName ?? ''}
                      onChange={(event) => updateDraft(key, { roadName: event.target.value })}
                      placeholder="Road name (optional)"
                      aria-label={`Road name for ${identity.title}`}
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                    <input
                      type="text"
                      value={draft.note ?? ''}
                      onChange={(event) => updateDraft(key, { note: event.target.value })}
                      placeholder="Note"
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                    <select
                      value={draft.directionMode || 'both'}
                      onChange={(event) => updateDraft(key, { directionMode: event.target.value })}
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    >
                      <option value="both">Both directions</option>
                      <option value="forward">Drawn direction only</option>
                      <option value="reverse">Opposite direction only</option>
                    </select>
                    <div
                      className={`grid gap-2 ${
                        (draft.timeRuleMode || 'always') === 'always'
                          ? 'grid-cols-1'
                          : 'grid-cols-2 sm:grid-cols-3'
                      }`}
                    >
                      <select
                        value={draft.timeRuleMode || 'always'}
                        onChange={(event) => updateDraft(key, { timeRuleMode: event.target.value })}
                        className={`min-w-0 rounded-xl border border-border bg-background px-2 py-2 text-xs outline-none focus:border-primary ${
                          (draft.timeRuleMode || 'always') === 'always' ? '' : 'col-span-2 sm:col-span-1'
                        }`}
                        aria-label="Active days"
                      >
                        <option value="always">Always</option>
                        <option value="daily">Daily</option>
                        <option value="weekdays">Weekdays</option>
                        <option value="weekends">Weekends</option>
                        <option value="custom">Choose days</option>
                      </select>
                      {(draft.timeRuleMode || 'always') !== 'always' && (
                        <>
                          <input
                            type="time"
                            value={draft.startTime || '07:00'}
                            onChange={(event) => updateDraft(key, { startTime: event.target.value })}
                            className="min-w-0 w-full rounded-xl border border-border bg-background px-2 py-2 text-xs outline-none focus:border-primary"
                            aria-label="Start time"
                          />
                          <input
                            type="time"
                            value={draft.endTime || '17:00'}
                            onChange={(event) => updateDraft(key, { endTime: event.target.value })}
                            className="min-w-0 w-full rounded-xl border border-border bg-background px-2 py-2 text-xs outline-none focus:border-primary"
                            aria-label="End time"
                          />
                        </>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                        Effective from
                        <input
                          type="date"
                          value={draft.validFromDate || ''}
                          onChange={(event) => updateDraft(key, { validFromDate: event.target.value })}
                          className="min-w-0 rounded-xl border border-border bg-background px-2 py-2 text-xs text-foreground outline-none focus:border-primary"
                        />
                      </label>
                      <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                        Active until
                        <input
                          type="date"
                          value={draft.expiresAtDate || ''}
                          onChange={(event) => updateDraft(key, { expiresAtDate: event.target.value })}
                          className="min-w-0 rounded-xl border border-border bg-background px-2 py-2 text-xs text-foreground outline-none focus:border-primary"
                        />
                      </label>
                    </div>
                    {(draft.timeRuleMode || 'always') === 'custom' && (
                      <fieldset className="rounded-xl border border-border bg-background p-2">
                        <legend className="px-1 text-[11px] font-semibold text-muted-foreground">Active weekdays</legend>
                        <div className="flex flex-wrap gap-1.5">
                          {TIME_RULE_DAY_OPTIONS.map(([day, label]) => (
                            <label key={day} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold">
                              <input
                                type="checkbox"
                                checked={normalizedDraftDays(draft).includes(day)}
                                onChange={(event) => updateDraft(key, {
                                  customDays: event.target.checked
                                    ? [...new Set([...(draft.customDays || []), day])]
                                    : (draft.customDays || []).filter((item) => Number(item) !== day),
                                })}
                                className="accent-primary"
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    )}
                    {invalidValidityWindow(draft) && (
                      <div className="text-xs font-semibold text-red-700 dark:text-red-300">
                        Effective from must be earlier than Active until.
                      </div>
                    )}
                    {invalidCustomDayRule(draft) && (
                      <div className="text-xs font-semibold text-red-700 dark:text-red-300">
                        Choose at least one active day for this custom schedule.
                      </div>
                    )}
                    {qualifierDraftError(draft) && (
                      <div className="text-xs font-semibold text-red-700 dark:text-red-300">
                        {qualifierDraftError(draft)}
                      </div>
                    )}
                  </fieldset>

                  <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
                    {conflict && (
                      <>
                        {!hasTracedRoadGeometry(row) && (
                          <div className="col-span-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300 lg:col-span-1">
                            Open this rule on the map and trace at least two distinct road points before resolving the conflict. Point-only rules stay blocked from scores and alerts.
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => resolveSavedSpeedConflict(row, conflict, 'use_observed', draft)}
                          disabled={disabled || !hasTracedRoadGeometry(row) || invalidValidityWindow(draft) || invalidCustomDayRule(draft) || Boolean(qualifierDraftError(draft))}
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                        >
                          <Gauge className="h-3.5 w-3.5" />
                          Use observed {formatSpeedLimit(conflict.observedLimitKmh, units)}
                        </button>
                        <button
                          type="button"
                          onClick={() => resolveSavedSpeedConflict(row, conflict, 'keep_saved', draft)}
                          disabled={disabled || !hasTracedRoadGeometry(row) || invalidValidityWindow(draft) || invalidCustomDayRule(draft) || Boolean(qualifierDraftError(draft))}
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                        >
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Keep saved {formatSpeedLimit(conflict.savedLimitKmh, units)}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => saveRow(row)}
                      disabled={disabled || invalidValidityWindow(draft) || invalidCustomDayRule(draft) || Boolean(qualifierDraftError(draft))}
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
                  </details>
                </div>
              </article>
            );
          })}
          </div>
        </div>
      )}
    </>
  );
}
