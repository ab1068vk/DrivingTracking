// @ts-check
import {
  AlertTriangle,
  Magnet,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Undo2,
  X,
} from 'lucide-react';
import premiumSavedRoadsCityHero from '@/assets/premium-saved-roads-city-hero.webp';
import premiumSavedRoadsHero from '@/assets/premium-saved-roads-map-hero.webp';
import premiumSavedRoadsMap from '@/assets/premium-saved-roads-map.webp';
import premiumSavedRoadsReview from '@/assets/premium-saved-roads-review.webp';
import premiumSavedRoadsSaved from '@/assets/premium-saved-roads-saved.webp';
import { speedLimitColor } from '@/lib/speedLimitMapSections';

const WORKSPACES = Object.freeze([
  {
    value: 'map',
    label: 'Map',
    description: 'Explore every mapped section',
    artwork: premiumSavedRoadsMap,
    tone: 'map',
  },
  {
    value: 'review',
    label: 'Needs review',
    description: 'Resolve evidence and conflicts',
    artwork: premiumSavedRoadsReview,
    tone: 'review',
  },
  {
    value: 'saved',
    label: 'Saved roads',
    description: 'Manage trusted local rules',
    artwork: premiumSavedRoadsSaved,
    tone: 'saved',
  },
]);

const safeCount = (value) => Math.max(0, Math.floor(Number(value) || 0));

/**
 * Keeps premium workspace counts attached to the same live collections used
 * by the standard tabs.
 */
export function buildPremiumSpeedWorkspaceItems({
  mapCount = 0,
  reviewCount = 0,
  savedCount = 0,
} = {}) {
  const counts = {
    map: safeCount(mapCount),
    review: safeCount(reviewCount),
    saved: safeCount(savedCount),
  };
  return WORKSPACES.map((workspace) => ({
    ...workspace,
    count: counts[workspace.value],
  }));
}

/** @param {Record<string, any>} settings */
export const shouldRenderPremiumSavedRoadSpeeds = (settings = {}) => (
  settings?.premium_visual_experience === true
);

export const premiumSavedRuleArtwork = (source = '', hasConflict = false) => {
  if (hasConflict) return premiumSavedRoadsReview;
  return source === 'user_confirmed_posted_sign'
    ? premiumSavedRoadsSaved
    : premiumSavedRoadsMap;
};

/**
 * @param {{
 *  activeWorkspace: string,
 *  mapCount: number,
 *  onChange: (workspace: string) => void,
 *  reviewCount: number,
 *  savedCount: number,
 * }} props
 */
export function PremiumSpeedWorkspaceTabs({
  activeWorkspace,
  mapCount,
  onChange,
  reviewCount,
  savedCount,
}) {
  const workspaces = buildPremiumSpeedWorkspaceItems({ mapCount, reviewCount, savedCount });

  return (
    <nav className="premium-speed-workspaces" aria-label="Saved road speed workspace">
      {workspaces.map(({ value, label, description, artwork, tone, count }) => {
        const active = activeWorkspace === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            aria-pressed={active}
            className="premium-speed-workspace"
            data-tone={tone}
          >
            <img src={artwork} alt="" aria-hidden="true" />
            <span className="premium-speed-workspace-copy">
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
            <span className="premium-speed-workspace-count" aria-label={`${count} ${label.toLowerCase()}`}>
              {count}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Premium control panel for the Saved roads workspace. All copy, counts, query
 * state, and sort state remain live; only the visual presentation changes.
 * @param {{
 *  count: number,
 *  onQueryChange: (value: string) => void,
 *  onSortChange: (value: string) => void,
 *  query: string,
 *  sort: string,
 *  sortOptions: Array<string[]>,
 * }} props
 */
export function PremiumSavedRulesHeader({
  count,
  onQueryChange,
  onSortChange,
  query,
  sort,
  sortOptions,
}) {
  return (
    <section className="premium-saved-rules-header" aria-labelledby="premium-saved-rules-title">
      <div className="premium-saved-rules-art" aria-hidden="true">
        <img src={premiumSavedRoadsCityHero} alt="" />
        <span>
          <img src={premiumSavedRoadsSaved} alt="" />
        </span>
      </div>

      <div className="premium-saved-rules-panel">
        <div className="premium-saved-rules-heading">
          <span className="premium-saved-rules-icon" aria-hidden="true">
            <SlidersHorizontal />
          </span>
          <div>
            <div className="premium-saved-rules-title-row">
              <h2 id="premium-saved-rules-title">Saved speed rules</h2>
              <span aria-label={`${safeCount(count)} rules shown`}>
                <strong>{safeCount(count)}</strong> shown
              </span>
            </div>
            <p>Search, triage, and edit local speed rules without hunting through every saved road area.</p>
          </div>
        </div>

        <div className="premium-saved-rules-controls">
          <label>
            <Search aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search saved speeds..."
              aria-label="Search saved speeds"
            />
          </label>
          <select
            value={sort}
            onChange={(event) => onSortChange(event.target.value)}
            aria-label="Sort saved speeds"
          >
            {sortOptions.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
      </div>
    </section>
  );
}

const SPEED_LEGEND = [30, 40, 50, 60, 80, 100];

/**
 * @param {{
 *  addMode: boolean,
 *  autoSnapTrace: boolean,
 *  excludedSpeedSectionCount: number,
 *  firstConflictSection: any,
 *  hiddenUnsetSectionCount: number,
 *  mapQuery: string,
 *  onMapQueryChange: (value: string) => void,
 *  onReviewConflict: () => void,
 *  onRestoreExcluded: () => void,
 *  onRestoreHidden: () => void,
 *  onToggleAdd: () => void,
 *  onToggleAutoSnap: () => void,
 * }} props
 */
export function PremiumRoadSpeedMapHero({
  addMode,
  autoSnapTrace,
  excludedSpeedSectionCount,
  firstConflictSection,
  hiddenUnsetSectionCount,
  mapQuery,
  onMapQueryChange,
  onReviewConflict,
  onRestoreExcluded,
  onRestoreHidden,
  onToggleAdd,
  onToggleAutoSnap,
}) {
  return (
    <div className="premium-speed-map-hero">
      <img className="premium-speed-map-hero-image" src={premiumSavedRoadsHero} alt="" aria-hidden="true" />
      <div className="premium-speed-map-hero-shade" aria-hidden="true" />

      <div className="premium-speed-map-heading">
        <span className="premium-speed-map-mark" aria-hidden="true">
          <img src={premiumSavedRoadsMap} alt="" />
        </span>
        <div>
          <div className="premium-speed-map-kicker"><ShieldCheck /> Local road intelligence</div>
          <h2 id="premium-road-speed-map-title">Road speed map</h2>
          <p>
            Speed badges stay visible on each section. Solid sections are saved, dashed sections are trip observations,
            and red sections disagree with saved data.
          </p>
        </div>
      </div>

      <div className="premium-speed-map-actions">
        {firstConflictSection && (
          <button type="button" onClick={onReviewConflict} className="premium-speed-action" data-tone="conflict">
            <AlertTriangle />
            <span>Review conflict</span>
          </button>
        )}
        <button type="button" onClick={onToggleAdd} className="premium-speed-action" data-tone={addMode ? 'neutral' : 'primary'}>
          {addMode ? <X /> : <Plus />}
          <span>{addMode ? 'Cancel adding' : 'Add road speed'}</span>
        </button>
        {hiddenUnsetSectionCount > 0 && (
          <button type="button" onClick={onRestoreHidden} className="premium-speed-action" data-tone="neutral">
            <Undo2 />
            <span>Restore hidden unset {hiddenUnsetSectionCount}</span>
          </button>
        )}
        {excludedSpeedSectionCount > 0 && (
          <button type="button" onClick={onRestoreExcluded} className="premium-speed-action" data-tone="neutral">
            <Undo2 />
            <span>Restore parking/private {excludedSpeedSectionCount}</span>
          </button>
        )}
        {addMode && (
          <button
            type="button"
            onClick={onToggleAutoSnap}
            className="premium-speed-action"
            data-tone={autoSnapTrace ? 'success' : 'neutral'}
            aria-pressed={autoSnapTrace}
          >
            <Magnet />
            <span>Auto snap</span>
          </button>
        )}
      </div>

      <div className="premium-speed-map-search">
        <label>
          <Search aria-hidden="true" />
          <input
            type="search"
            value={mapQuery}
            onChange={(event) => onMapQueryChange(event.target.value)}
            placeholder="Search map by road, source, speed..."
            aria-label="Search map by road, source, or speed"
          />
        </label>
      </div>

      <div className="premium-speed-map-legend" aria-label="Road speed map legend">
        <span><i data-legend="unset" />Not set</span>
        <span><i data-legend="observed" />Observed</span>
        <span><i data-legend="conflict" />Conflict</span>
        {SPEED_LEGEND.map((limit) => (
          <span key={limit}>
            <i style={{ backgroundColor: speedLimitColor(limit) }} />
            {limit}
          </span>
        ))}
        <span className="premium-speed-map-unit">km/h</span>
      </div>
    </div>
  );
}
