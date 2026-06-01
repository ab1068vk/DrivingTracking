import { useCallback, useMemo } from 'react';

export const SETTINGS_SECTIONS = [
  { label: 'Tracking mode', section: 'Tracking', sectionId: 'settings-tracking', detail: 'Manual, foreground auto-detect, background auto, and pause controls.', keywords: 'manual auto detect background pause delayed start not starting drive signal gps movement' },
  { label: 'Android permissions', section: 'Android Permissions', sectionId: 'settings-android-permissions', detail: 'Location, background location, activity, battery, and native auto service setup.', keywords: 'location activity notification battery unrestricted native service usage bluetooth permission granted denied prompt' },
  { label: 'Feature permissions', section: 'Feature Permissions', sectionId: 'settings-feature-permissions', detail: 'See which features are blocked by missing permissions.', keywords: 'blocked unavailable permission feature status' },
  { label: 'Economics', section: 'Economics', sectionId: 'settings-economics', detail: 'Currency, fuel, EV grid emissions, CO2 baseline, and tree-year equivalents used in savings estimates.', keywords: 'currency symbol money cost price co2 carbon emissions average vehicle baseline electric ev grid intensity kwh tree fuel savings economics' },
  { label: 'Notifications', section: 'Notifications', sectionId: 'settings-notifications', detail: 'Quiet hours, trip summaries, coaching, maintenance, and safety alerts.', keywords: 'quiet hours trip summary coaching maintenance nudges alert' },
  { label: 'Driving goals', section: 'Driving Goals', sectionId: 'settings-driving-goals', detail: 'Weekly score and behavior targets used by dashboard goals.', keywords: 'weekly score harsh brake speeding night goals target' },
  { label: 'Detection features', section: 'Detection Features', sectionId: 'settings-detection-thresholds', detail: 'Detection toggles, sensitivity, calibration, re-score, and event feedback behavior.', keywords: 'harsh braking rapid acceleration speeding idle lane changing brake turn heading drift calibration rescore feedback accurate wrong false positive' },
  { label: 'Calibration completion', section: 'Advanced Models', sectionId: 'settings-calibration', detail: 'Trip survey completion rate and recent unrated trip queue.', keywords: 'calibration labels survey completion rate rated unlabeled recent trips feedback' },
  { label: 'Advanced models', section: 'Advanced Models', sectionId: 'settings-advanced-models', detail: 'Weather, OSRM, historical context risk, voice alerts, OBD, sensor fusion, and crash signals.', keywords: 'weather osrm route risk voice alerts obd bluetooth sensor fusion crash map line event marker cornering heatmap' },
  { label: 'Phone use detection', section: 'Phone Use Detection', sectionId: 'settings-phone-use', detail: 'Phone distraction detection, map display, and scoring impact.', keywords: 'distraction usage access phone score map foreground app' },
  { label: 'Speed warning', section: 'Speed Warning', sectionId: 'settings-speed-warning', detail: 'Live speed warnings and OpenStreetMap limit margin.', keywords: 'speed limits overpass osm warning margin over limit' },
  { label: 'Privacy zones', section: 'Privacy Zones', sectionId: 'settings-privacy-zones', detail: 'Add, edit, and delete parked-location privacy zones for Android widget privacy.', keywords: 'privacy zones home work gym parked location widget external map gps coordinates' },
  { label: 'Privacy, legal, and backup', section: 'Privacy & Data', sectionId: 'settings-privacy-data', detail: 'Legal disclaimers, safety notices, backup, import, export, saved filters, and feedback data.', keywords: 'privacy legal disclaimer safety personal use insurance navigation emergency maintenance compliance export import backup retention delete data saved filters event feedback' },
];

export function getSettingsSearchResults(query, sections = SETTINGS_SECTIONS) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  return sections
    .map((item) => {
      const label = item.label.toLowerCase();
      const section = item.section.toLowerCase();
      const haystack = `${item.label} ${item.section} ${item.detail} ${item.keywords}`.toLowerCase();
      const score = terms.reduce((sum, term) => (
        sum + (label.includes(term) ? 6 : 0)
        + (section.includes(term) ? 4 : 0)
        + (haystack.includes(term) ? 1 : 0)
      ), 0);
      return { ...item, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

export function useSettingsSections(settingsSearch, setSettingsSearch) {
  const settingsSearchQuery = settingsSearch.trim().toLowerCase();
  const settingSearchResults = useMemo(
    () => getSettingsSearchResults(settingsSearch),
    [settingsSearch]
  );

  const scrollSettingSection = useCallback((sectionId) => {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setSettingsSearch('');
  }, [setSettingsSearch]);

  return {
    settingsSearchQuery,
    settingSearchResults,
    scrollSettingSection,
  };
}
