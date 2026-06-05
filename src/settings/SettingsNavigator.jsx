import { lazy, Suspense, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { PageSkeleton } from '@/components/PageSkeleton';
import { SECTION_GROUPS, SettingsNav } from '@/features/settings/components/SettingsNav';

const TrackingSettings = lazy(() => import('./sections/TrackingSettings').then((module) => ({ default: module.TrackingSettings })));
const ScoringSettings = lazy(() => import('./sections/ScoringSettings').then((module) => ({ default: module.ScoringSettings })));
const PrivacySettings = lazy(() => import('./sections/PrivacySettings').then((module) => ({ default: module.PrivacySettings })));
const PrivacyZonesSettings = lazy(() => import('./PrivacyZonesSettings'));
const VehicleSettings = lazy(() => import('./sections/VehicleSettings').then((module) => ({ default: module.VehicleSettings })));
const UBISettings = lazy(() => import('./sections/UBISettings').then((module) => ({ default: module.UBISettings })));
const AdvancedSettings = lazy(() => import('./sections/AdvancedSettings').then((module) => ({ default: module.AdvancedSettings })));

const SECTION_RENDERERS = [
  {
    id: 'tracking',
    legacyIds: ['settings-tracking', 'settings-android-permissions', 'settings-feature-permissions'],
    Component: TrackingSettings,
  },
  {
    id: 'scoring',
    legacyIds: ['settings-driving-goals', 'settings-night-window', 'settings-detection-thresholds', 'settings-speed-warning'],
    Component: ScoringSettings,
  },
  {
    id: 'privacy',
    legacyIds: ['settings-privacy-data'],
    Component: PrivacySettings,
  },
  {
    id: 'privacy-zones',
    legacyIds: ['settings-privacy-zones'],
    Component: PrivacyZonesSettings,
  },
  {
    id: 'vehicle',
    legacyIds: ['settings-appearance', 'settings-economics'],
    Component: VehicleSettings,
  },
  {
    id: 'ubi',
    legacyIds: ['settings-ubi'],
    Component: UBISettings,
  },
  {
    id: 'advanced',
    legacyIds: ['settings-advanced-models', 'settings-phone-use'],
    Component: AdvancedSettings,
  },
];

function groupForSectionId(sectionId) {
  return SECTION_GROUPS.find((group) => group.ids.includes(sectionId)) || SECTION_GROUPS[0];
}

export function SettingsNavigator({ ctx, settingsSearch, setSettingsSearch, settingSearchResults }) {
  const [activeGroupId, setActiveGroupId] = useState(SECTION_GROUPS[0].id);
  const activeGroup = useMemo(
    () => SECTION_GROUPS.find((group) => group.id === activeGroupId) || SECTION_GROUPS[0],
    [activeGroupId]
  );
  const activeIds = activeGroup.ids;
  const activeRenderers = SECTION_RENDERERS.filter((section) => (
    section.legacyIds.some((sectionId) => activeIds.includes(sectionId))
  ));

  return (
    <div className="settings-home space-y-4">
      <div className="rounded-2xl border border-border bg-card p-3 shadow-sm">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={settingsSearch}
            onChange={(event) => setSettingsSearch(event.target.value)}
            placeholder="Search settings, permissions, auto start, map, feedback..."
            className="w-full rounded-xl border border-border bg-background py-2.5 pl-9 pr-10 text-sm outline-none focus:border-primary"
          />
          {settingsSearch && (
            <button
              type="button"
              onClick={() => setSettingsSearch('')}
              aria-label="Clear settings search"
              className="absolute right-2 top-1/2 rounded-lg p-1 text-muted-foreground hover:bg-secondary hover:text-foreground -translate-y-1/2"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {settingsSearch.trim() && (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {settingSearchResults.length > 0 ? settingSearchResults.map((item) => {
              const group = groupForSectionId(item.sectionId);
              return (
                <button
                  key={`${item.section}-${item.label}`}
                  type="button"
                  onClick={() => {
                    setActiveGroupId(group.id);
                    setSettingsSearch('');
                  }}
                  className="rounded-xl border border-border bg-secondary/60 px-3 py-2 text-left text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
                >
                  <span className="font-semibold text-foreground">{item.label}</span>
                  <span className="ml-1">in {group.label}</span>
                  <span className="mt-1 block">{item.detail}</span>
                </button>
              );
            }) : (
              <span className="text-xs text-muted-foreground">No matching settings found.</span>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <SettingsNav activeGroupId={activeGroup.id} onChange={setActiveGroupId} />
        <div className="min-w-0 flex-1 rounded-3xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-2">
            <h2 className="text-xl font-grotesk font-bold">{activeGroup.label}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{activeGroup.description}</p>
          </div>
          <Suspense fallback={<PageSkeleton />}>
            {activeRenderers.map(({ id, Component }) => (
              <Component key={id} ctx={ctx} visibleSectionIds={activeIds} />
            ))}
          </Suspense>
        </div>
      </div>
    </div>
  );
}
