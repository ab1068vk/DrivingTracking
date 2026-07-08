// @ts-check
import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { escapeHtml } from '@/lib/htmlUtils';
import {
  SPEED_MAP_LAYER_DEFAULTS,
  buildSpeedMapSections,
  filterSpeedMapSections,
  speedLimitColor,
  summarizeSpeedMapSections,
} from '@/lib/speedLimitMapSections';
import { beginMeasure, measureSync } from '@/lib/performanceTriage';
import { Maximize2, SlidersHorizontal } from 'lucide-react';
import MapErrorBoundary from '@/components/MapErrorBoundary';
import { isHeightenedPrivacyMode } from '@/lib/privacyMode';
import useLocalSettings from '@/hooks/useLocalSettings';

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const DEFAULT_CENTER = [43.6532, -79.3832];
const MAX_PERMANENT_LABELS = 80;
const MOBILE_MAX_PERMANENT_LABELS = 30;

const sectionKey = (section = {}) => String(
  section.sectionKey ||
  section.id ||
  section.ruleId ||
  section.geohash ||
  `${section.lat},${section.lng}`
);

const formatLimitLabel = (limitKmh) => {
  const limit = Number(limitKmh);
  return Number.isFinite(limit) && limit > 0 ? `${Math.round(limit)} km/h` : 'Set speed';
};

const labelClassForSection = ({ selected, conflict, saved, hasDisplayLimit, source }) => [
  'speed-limit-map-label',
  selected ? 'speed-limit-map-label-selected' : '',
  conflict ? 'speed-limit-map-label-conflict' : '',
  saved ? 'speed-limit-map-label-saved' : '',
  saved && source === 'user_confirmed_posted_sign' ? 'speed-limit-map-label-posted' : '',
  saved && source !== 'user_confirmed_posted_sign' ? 'speed-limit-map-label-estimate' : '',
  !saved && hasDisplayLimit ? 'speed-limit-map-label-observed' : '',
  !hasDisplayLimit ? 'speed-limit-map-label-unset' : '',
].filter(Boolean).join(' ');

function useOnlineStatus() {
  const [online, setOnline] = useState(() => (
    typeof navigator === 'undefined' ? true : navigator.onLine !== false
  ));

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return online;
}

function useMobileLabelBudget() {
  const [mobile, setMobile] = useState(() => (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 640px)').matches
  ));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(max-width: 640px)');
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => {
      media.removeEventListener?.('change', update);
    };
  }, []);

  return mobile ? MOBILE_MAX_PERMANENT_LABELS : MAX_PERMANENT_LABELS;
}

const isLatLng = (position = []) => (
  Number.isFinite(position[0]) &&
  Number.isFinite(position[1]) &&
  position[0] >= -90 &&
  position[0] <= 90 &&
  position[1] >= -180 &&
  position[1] <= 180
);

const sectionPositions = (section = {}) => (
  (section.sectionPoints?.length
    ? section.sectionPoints.map((point) => [Number(point.lat), Number(point.lng)])
    : [[Number(section.lat), Number(section.lng)]]
  ).filter(isLatLng)
);

const middlePosition = (positions = []) => (
  positions.length === 0
    ? null
    : positions.length % 2 === 1
      ? positions[Math.floor(positions.length / 2)]
      : [
        (positions[(positions.length / 2) - 1][0] + positions[positions.length / 2][0]) / 2,
        (positions[(positions.length / 2) - 1][1] + positions[positions.length / 2][1]) / 2,
      ]
);

const vertexHandleLabel = (index, count) => {
  if (index === 0) return 'S';
  if (index === count - 1) return 'E';
  return String(index + 1);
};

const vertexHandleTitle = (index, count) => {
  if (index === 0) return 'Start';
  if (index === count - 1) return 'End';
  return `Point ${index + 1}`;
};

const sectionCenter = (section = {}) => (
  sectionPositions(section)[0] || null
);

const firstSectionCenter = (sectionLists = []) => {
  for (const list of sectionLists) {
    for (const section of Array.isArray(list) ? list : []) {
      const center = sectionCenter(section);
      if (center) return center;
    }
  }
  return DEFAULT_CENTER;
};

const safeLeafletCall = (callback) => {
  try {
    return callback();
  } catch {
    return null;
  }
};

const isUsableLeafletMap = (map) => Boolean(map?._container && map?._panes?.mapPane);

const isUsableLayerGroup = (layerGroup) => Boolean(
  layerGroup?._map && isUsableLeafletMap(layerGroup._map)
);

const stopLeafletMap = (map) => {
  if (!isUsableLeafletMap(map)) return;
  safeLeafletCall(() => map?.stop?.());
  safeLeafletCall(() => map?.closePopup?.());
  safeLeafletCall(() => map?.closeTooltip?.());
};

const safeMapSetView = (map, center, zoom, options = {}) => safeLeafletCall(() => (
  isUsableLeafletMap(map) ? map?.setView?.(center, zoom, { animate: false, ...options }) : null
));

const safeMapFitBounds = (map, bounds, options = {}) => measureSync('SpeedLimitEditorMap.fitBounds', () => {
  if (!isUsableLeafletMap(map)) return null;
  if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) return null;
  return safeLeafletCall(() => map?.fitBounds?.(bounds, { animate: false, ...options }));
});

const sectionDisplay = (section = {}, selected = false, showPermanentLabel = false) => {
  const displayLimitKmh = section.effectiveLimitKmh ?? section.limitKmh;
  const color = speedLimitColor(displayLimitKmh);
  const conflict = Boolean(section.conflict);
  const hasDisplayLimit = Number(displayLimitKmh) > 0;
  const positions = sectionPositions(section);
  const pathOptions = {
    color: conflict ? '#dc2626' : color,
    weight: selected ? 11 : section.saved ? 8 : hasDisplayLimit ? 7 : 6,
    opacity: selected ? 1 : section.saved ? 0.92 : hasDisplayLimit ? 0.84 : 0.72,
    dashArray: conflict ? '2 8' : section.saved ? undefined : hasDisplayLimit ? '4 7' : '8 9',
    lineCap: 'round',
  };
  const tooltip = section.saved
    ? `${Math.round(Number(section.limitKmh))} km/h - ${section.roadName || 'Saved road section'}`
    : `Speed not set - ${section.roadName || 'Recorded road section'}`;
  const displayTooltip = hasDisplayLimit
    ? `${Math.round(Number(displayLimitKmh))} km/h - ${section.roadName || (section.voiceSpeedMarker ? 'Voice marker' : section.saved ? 'Saved road section' : 'Labeled road section')}`
    : tooltip;
  const labelClassName = labelClassForSection({
    selected,
    conflict,
    saved: section.saved,
    hasDisplayLimit,
    source: section.source,
  });
  const splitPart = Number(section.splitPart);
  const splitLabel = Number.isInteger(splitPart) && splitPart > 0 ? ` ${splitPart}/2` : '';
  const labelText = conflict
    ? `! ${formatLimitLabel(displayLimitKmh)}${splitLabel}`
    : `${formatLimitLabel(displayLimitKmh)}${splitLabel}`;
  const shouldShowPermanentLabel = showPermanentLabel || selected || conflict;

  return {
    color,
    conflict,
    displayTooltip,
    labelClassName,
    labelText,
    pathOptions,
    positions,
    showPermanentLabel: shouldShowPermanentLabel,
  };
};

const addSectionToLayer = ({
  section,
  layerGroup,
  selected = false,
  showPermanentLabel = false,
  addMode = false,
  onSelect,
}) => {
  if (!isUsableLayerGroup(layerGroup)) return null;
  const display = sectionDisplay(section, selected, showPermanentLabel);
  const fallbackPosition = sectionCenter(section);
  if (display.positions.length < 2 && !fallbackPosition) return null;
  const layer = display.positions.length >= 2
    ? L.polyline(display.positions, display.pathOptions)
    : L.circleMarker(display.positions[0] || fallbackPosition, {
      radius: selected ? 10 : 8,
      color: '#ffffff',
      weight: display.conflict ? 4 : 2,
      fillColor: display.color,
      fillOpacity: selected ? 0.95 : section.saved ? 0.95 : Number(section.effectiveLimitKmh ?? section.limitKmh) > 0 ? 0.82 : 0.65,
      dashArray: display.conflict ? '2 4' : section.saved ? undefined : Number(section.effectiveLimitKmh ?? section.limitKmh) > 0 ? '3 4' : '4 4',
    });

  layer
    .bindTooltip(escapeHtml(display.displayTooltip), { sticky: true })
    .on('click', () => {
      if (!addMode) onSelect?.(section);
    })
    .on('contextmenu', (event) => {
      event.originalEvent?.preventDefault?.();
      if (!addMode) onSelect?.(section);
    })
    .addTo(layerGroup);

  if (display.showPermanentLabel) {
    const labelPosition = middlePosition(display.positions);
    if (labelPosition) {
      const labelAnchor = L.marker(labelPosition, {
        interactive: false,
        icon: L.divIcon({
          html: '',
          className: 'speed-limit-map-label-anchor',
          iconSize: [1, 1],
        }),
      }).addTo(layerGroup);
      labelAnchor.bindTooltip(escapeHtml(display.labelText), {
        permanent: true,
        direction: 'center',
        className: display.labelClassName,
      });
    }
  }

  return layer;
};

export default function SpeedLimitEditorMap(props) {
  const resetKey = [
    props.selectedGeohash || '',
    props.mapQuery || '',
    Array.isArray(props.preparedSections) ? props.preparedSections.length : 'raw',
    Array.isArray(props.corrections) ? props.corrections.length : 0,
    Array.isArray(props.trips) ? props.trips.length : 0,
  ].join(':');

  return (
    <MapErrorBoundary
      context="speed_limit_editor_map"
      title="Map unavailable"
      message="The saved road speed map could not be drawn. Row cards and editing controls are still available."
      resetKey={resetKey}
      height="22rem"
    >
      <SpeedLimitEditorMapContent {...props} />
    </MapErrorBoundary>
  );
}

function SpeedLimitEditorMapContent({
  trips = [],
  corrections = [],
  preparedSections = null,
  selectedGeohash = '',
  mapQuery = '',
  layers = SPEED_MAP_LAYER_DEFAULTS,
  addMode = false,
  addPath = [],
  selectedSectionOverride = null,
  heightClassName = 'h-[28rem] min-h-[22rem]',
  onLayerChange = null,
  onSelect = null,
  onAddPoint = null,
  onMoveAddPoint = null,
  onMoveSectionPoint = null,
}) {
  const settings = useLocalSettings();
  const remoteTilesAllowed = !isHeightenedPrivacyMode(settings);
  const online = useOnlineStatus();
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const sectionLayersRef = useRef(null);
  const selectedLayerRef = useRef(null);
  const editLayerRef = useRef(null);
  const tileLayerRef = useRef(null);
  const initialFitDoneRef = useRef(false);
  const lastFilterFitKeyRef = useRef('');
  const lastSelectedFitKeyRef = useRef('');
  const visibleBoundsRef = useRef(null);
  const addModeRef = useRef(addMode);
  const onSelectRef = useRef(onSelect);
  const onAddPointRef = useRef(onAddPoint);
  const onMoveAddPointRef = useRef(onMoveAddPoint);
  const onMoveSectionPointRef = useRef(onMoveSectionPoint);
  const [mapReady, setMapReady] = useState(false);
  const permanentLabelLimit = useMobileLabelBudget();
  addModeRef.current = addMode;
  onSelectRef.current = onSelect;
  onAddPointRef.current = onAddPoint;
  onMoveAddPointRef.current = onMoveAddPoint;
  onMoveSectionPointRef.current = onMoveSectionPoint;
  const rawSections = useMemo(
    () => Array.isArray(preparedSections) ? preparedSections : buildSpeedMapSections(trips, corrections),
    [corrections, preparedSections, trips]
  );
  const sections = useMemo(() => filterSpeedMapSections(rawSections, {
    query: mapQuery,
    layers,
  }), [layers, mapQuery, rawSections]);
  const visibleSectionsKey = useMemo(
    () => sections.map(sectionKey).join('|'),
    [sections]
  );
  const filterFitKey = useMemo(
    () => JSON.stringify({ mapQuery, layers, visibleSectionsKey }),
    [layers, mapQuery, visibleSectionsKey]
  );
  const stats = useMemo(() => summarizeSpeedMapSections(rawSections), [rawSections]);
  const visibleStats = useMemo(() => summarizeSpeedMapSections(sections), [sections]);
  const center = sections.length
    ? firstSectionCenter([sections, rawSections])
    : firstSectionCenter([rawSections]);
  const layerState = { ...SPEED_MAP_LAYER_DEFAULTS, ...(layers || {}) };
  const toggleLayer = (key) => {
    onLayerChange?.({ ...layerState, [key]: !layerState[key] });
  };
  const layerItems = [
    ['conflicts', 'Conflicts', stats.conflicts],
    ['saved', 'Saved', stats.saved],
    ['observed', 'Observed', stats.observed],
    ['unset', 'Unset', stats.unset],
  ];
  const intelligenceLayerItems = [
    ['posted', 'Posted', stats.posted],
    ['estimates', 'Estimates', stats.estimates],
    ['lowConfidence', 'Low conf.', stats.lowConfidence],
    ['stale', 'Stale', stats.stale],
    ['expiring', 'Expiring', stats.expiring],
    ['missingGeometry', 'Needs line', stats.missingGeometry],
  ];
  const permanentLabelKeys = useMemo(() => {
    if (!sections.length) return new Set();
    const prioritized = [...sections].sort((a, b) => {
      const score = (section) => (
        (section.conflict ? 4 : 0) +
        (section.saved ? 3 : 0) +
        (Number(section.effectiveLimitKmh ?? section.limitKmh ?? section.observedLimitKmh) > 0 ? 1 : 0)
      );
      return score(b) - score(a);
    });
    const keys = new Set();
    prioritized
      .filter((section) => section.saved || section.conflict)
      .slice(0, permanentLabelLimit)
      .forEach((section) => keys.add(sectionKey(section)));
    return keys;
  }, [permanentLabelLimit, sections]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const endMount = beginMeasure('SpeedLimitEditorMap.mount');

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
      fadeAnimation: false,
      markerZoomAnimation: false,
      zoomAnimation: false,
    });
    // Use Leaflet's default SVG renderer. Canvas can keep queued redraws after
    // dense speed layers are cleared, which can hit Leaflet's `_leaflet_pos`
    // path with a detached renderer container.
    mapRef.current = map;
    safeMapSetView(map, center, 13);
    sectionLayersRef.current = L.layerGroup().addTo(map);
    selectedLayerRef.current = L.layerGroup().addTo(map);
    editLayerRef.current = L.layerGroup().addTo(map);
    setMapReady(true);
    endMount({ outcome: 'success' });

    const timer = window.setTimeout(() => {
      if (mapRef.current === map && isUsableLeafletMap(map)) safeLeafletCall(() => map.invalidateSize({ animate: false }));
    }, 0);

    return () => {
      window.clearTimeout(timer);
      stopLeafletMap(map);
      safeLeafletCall(() => editLayerRef.current?.clearLayers?.());
      safeLeafletCall(() => selectedLayerRef.current?.clearLayers?.());
      safeLeafletCall(() => sectionLayersRef.current?.clearLayers?.());
      safeLeafletCall(() => tileLayerRef.current?.remove?.());
      safeLeafletCall(() => map.remove());
      mapRef.current = null;
      sectionLayersRef.current = null;
      selectedLayerRef.current = null;
      editLayerRef.current = null;
      tileLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return undefined;

    const handleClick = (event) => {
      if (!addModeRef.current) return;
      onAddPointRef.current?.({ lat: event.latlng.lat, lng: event.latlng.lng });
    };

    map.on('click', handleClick);
    return () => {
      safeLeafletCall(() => map.off('click', handleClick));
    };
  }, [mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !isUsableLeafletMap(map)) return;

    safeLeafletCall(() => {
      if (tileLayerRef.current) {
        map.removeLayer(tileLayerRef.current);
        tileLayerRef.current = null;
      }
    });
    if (!online || !remoteTilesAllowed) return;

    tileLayerRef.current = L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 19,
    }).addTo(map);
  }, [mapReady, online, remoteTilesAllowed]);

  useEffect(() => {
    const map = mapRef.current;
    const layers = sectionLayersRef.current;
    if (!mapReady || !isUsableLeafletMap(map) || !isUsableLayerGroup(layers)) return;
    const endDraw = beginMeasure('SpeedLimitEditorMap.layerDraw', { sectionCount: sections.length });

    stopLeafletMap(map);
    safeLeafletCall(() => layers.clearLayers());

    sections.forEach((section) => {
      if (selectedGeohash && sectionKey(section) === selectedGeohash) return;
      addSectionToLayer({
        section,
        layerGroup: layers,
        selected: false,
        showPermanentLabel: permanentLabelKeys.has(sectionKey(section)),
        addMode: false,
        onSelect: (section) => {
          if (!addModeRef.current) onSelectRef.current?.(section);
        },
      });
    });
    endDraw({ outcome: 'success' });
  }, [mapReady, permanentLabelKeys, sections, selectedGeohash]);

  useEffect(() => {
    const layers = editLayerRef.current;
    if (!mapReady || !isUsableLayerGroup(layers)) return;

    safeLeafletCall(() => layers.clearLayers());

    if (addPath.length >= 2) {
      L.polyline(
        addPath.map((point) => [Number(point.lat), Number(point.lng)]).filter(isLatLng),
        { color: '#2563eb', weight: 8, opacity: 0.95, lineCap: 'round' }
      ).addTo(layers);
    }

    addPath.forEach((point, index) => {
      const latLng = [Number(point.lat), Number(point.lng)];
      if (!isLatLng(latLng)) return;
      const marker = L.marker(latLng, {
        draggable: Boolean(onMoveAddPoint),
        icon: L.divIcon({
          html: `<div style="width:${index === addPath.length - 1 ? 18 : 14}px;height:${index === addPath.length - 1 ? 18 : 14}px;border-radius:999px;background:#2563eb;border:3px solid white;box-shadow:0 4px 12px rgba(37,99,235,.36);"></div>`,
          className: '',
          iconSize: [index === addPath.length - 1 ? 18 : 14, index === addPath.length - 1 ? 18 : 14],
          iconAnchor: [index === addPath.length - 1 ? 9 : 7, index === addPath.length - 1 ? 9 : 7],
        }),
      }).addTo(layers);
      marker.on('dragend', (event) => {
        const nextLatLng = event.target.getLatLng();
        onMoveAddPointRef.current?.(index, { lat: nextLatLng.lat, lng: nextLatLng.lng });
      });
      if (index === addPath.length - 1) marker.bindTooltip('Tap to continue or drag points to adjust', { permanent: true });
    });
  }, [addPath, mapReady]);

  useEffect(() => {
    const selectedLayers = selectedLayerRef.current;
    if (!mapReady || !isUsableLayerGroup(selectedLayers)) return;

    safeLeafletCall(() => selectedLayers.clearLayers());
    const selectedSection = (
      selectedSectionOverride &&
      sectionKey(selectedSectionOverride) === selectedGeohash
        ? selectedSectionOverride
        : sections.find((section) => (
      sectionKey(section) === selectedGeohash
        ))
    );
    if (!selectedSection) return;

    addSectionToLayer({
      section: selectedSection,
      layerGroup: selectedLayers,
      selected: true,
      showPermanentLabel: true,
      addMode: false,
      onSelect: (section) => {
        if (!addModeRef.current) onSelectRef.current?.(section);
      },
    });

    const selectedPoints = sectionPositions(selectedSection);
    if (onMoveSectionPointRef.current && selectedPoints.length >= 2 && !addModeRef.current) {
      selectedPoints.forEach((position, index) => {
        const label = vertexHandleTitle(index, selectedPoints.length);
        const handleText = vertexHandleLabel(index, selectedPoints.length);
        const endpoint = index === 0 || index === selectedPoints.length - 1;
        const marker = L.marker([position[0], position[1]], {
          draggable: true,
          keyboard: true,
          title: `${label} of selected road section`,
          icon: L.divIcon({
            html: `<div class="${endpoint ? 'speed-limit-endpoint-handle' : 'speed-limit-vertex-handle'}">${handleText}</div>`,
            className: '',
            iconSize: endpoint ? [26, 26] : [22, 22],
            iconAnchor: endpoint ? [13, 13] : [11, 11],
          }),
        }).addTo(selectedLayers);
        marker.bindTooltip(`Drag ${label.toLowerCase()} to adjust the road section`, {
          direction: 'top',
          offset: [0, -10],
        });
        marker.on('dragend', (event) => {
          const nextLatLng = event.target.getLatLng();
          onMoveSectionPointRef.current?.(index, {
            lat: nextLatLng.lat,
            lng: nextLatLng.lng,
          });
        });
      });
    }
  }, [mapReady, sections, selectedGeohash, selectedSectionOverride]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !isUsableLeafletMap(map)) return;
    const points = sections.flatMap(sectionPositions);
    visibleBoundsRef.current = points.length > 1 ? L.latLngBounds(points) : null;
    if (!points.length) {
      if (!initialFitDoneRef.current) safeMapSetView(map, center, 13);
      return;
    }
    if (initialFitDoneRef.current) return;
    initialFitDoneRef.current = true;
    if (points.length === 1) {
      safeMapSetView(map, points[0], 15);
      return;
    }
    safeMapFitBounds(map, L.latLngBounds(points), { padding: [28, 28], maxZoom: 16 });
  }, [center, mapReady, sections]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !isUsableLeafletMap(map)) return;
    if (!initialFitDoneRef.current) {
      lastFilterFitKeyRef.current = filterFitKey;
      return;
    }
    if (lastFilterFitKeyRef.current === filterFitKey) return;
    lastFilterFitKeyRef.current = filterFitKey;
    if (selectedGeohash) return;
    const points = sections.flatMap(sectionPositions);
    visibleBoundsRef.current = points.length > 1 ? L.latLngBounds(points) : null;
    if (points.length === 0) {
      safeMapSetView(map, center, 13);
      return;
    }
    if (points.length === 1) {
      safeMapSetView(map, points[0], 15);
      return;
    }
    safeMapFitBounds(map, L.latLngBounds(points), { padding: [28, 28], maxZoom: 16 });
  }, [center, filterFitKey, mapReady, sections, selectedGeohash]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !isUsableLeafletMap(map)) return;
    if (!selectedGeohash) {
      lastSelectedFitKeyRef.current = '';
      return;
    }
    if (lastSelectedFitKeyRef.current === selectedGeohash) return;
    const selectedSection = (
      selectedSectionOverride &&
      sectionKey(selectedSectionOverride) === selectedGeohash
        ? selectedSectionOverride
        : sections.find((section) => (
          sectionKey(section) === selectedGeohash
        ))
    );
    const points = selectedSection ? sectionPositions(selectedSection) : [];
    if (!points.length) return;
    lastSelectedFitKeyRef.current = selectedGeohash;
    if (points.length === 1) {
      safeMapSetView(map, points[0], 16);
      return;
    }
    safeMapFitBounds(map, L.latLngBounds(points), { padding: [32, 32], maxZoom: 17 });
  }, [mapReady, sections, selectedGeohash, selectedSectionOverride]);

  const handleFitVisible = () => {
    const map = mapRef.current;
    if (!mapReady || !isUsableLeafletMap(map)) return;
    const bounds = visibleBoundsRef.current;
    if (bounds) {
      safeMapFitBounds(map, bounds, { padding: [28, 28], maxZoom: 16 });
      return;
    }
    const points = sections.flatMap(sectionPositions);
    if (points.length === 1) {
      safeMapSetView(map, points[0], 15);
      return;
    }
    safeMapSetView(map, center, 13);
  };

  return (
    <div className="relative z-0 isolate overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className={`relative w-full ${heightClassName}`}>
        <div ref={containerRef} className="h-full w-full" />
        {onLayerChange && (
          <details className="absolute right-3 top-3 z-[500] w-[min(21rem,calc(100%-1.5rem))] rounded-xl border border-border bg-background/95 p-2 shadow-lg backdrop-blur [&>summary::-webkit-details-marker]:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-1 py-0.5 text-[11px] font-semibold text-muted-foreground">
              <span>{visibleStats.total} of {stats.total} visible</span>
              <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-foreground">
                <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
                Filters
              </span>
            </summary>
            <div className="mt-2 border-t border-border/70 pt-2">
              <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-muted-foreground">
                <span>{stats.savedRules} saved rules</span>
                <button
                  type="button"
                  onClick={handleFitVisible}
                  disabled={sections.length === 0}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1.5 text-[11px] font-semibold text-foreground hover:bg-secondary disabled:opacity-45"
                >
                  <Maximize2 className="h-3.5 w-3.5 text-primary" />
                  Fit visible
                </button>
              </div>
              <div className="mt-2 space-y-2">
              <div>
                <div className="px-1 text-[10px] font-semibold uppercase text-muted-foreground">Road state</div>
                <div className="mt-1 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  {layerItems.map(([key, label, count]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleLayer(key)}
                      className={`rounded-lg border px-2 py-1.5 text-[11px] font-semibold ${
                        layerState[key]
                          ? 'border-primary/50 bg-primary/10 text-foreground'
                          : 'border-border bg-secondary/80 text-muted-foreground'
                      }`}
                      aria-pressed={layerState[key]}
                    >
                      {label} {count}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="px-1 text-[10px] font-semibold uppercase text-muted-foreground">Intelligence</div>
                <div className="mt-1 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {intelligenceLayerItems.map(([key, label, count]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleLayer(key)}
                      disabled={count === 0}
                      className={`rounded-lg border px-2 py-1.5 text-[11px] font-semibold ${
                        layerState[key]
                          ? 'border-primary/50 bg-primary/10 text-foreground'
                          : 'border-border bg-secondary/80 text-muted-foreground'
                      } disabled:cursor-not-allowed disabled:opacity-45`}
                      aria-pressed={layerState[key]}
                    >
                      {label} {count}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            </div>
          </details>
        )}
        {(!online || !remoteTilesAllowed) && (
          <div className="pointer-events-none absolute bottom-20 left-4 z-[500] max-w-[14rem] rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950 shadow-lg dark:border-amber-800 dark:bg-amber-950/90 dark:text-amber-100">
            {remoteTilesAllowed
              ? 'Offline: saved roads, trip geometry, editing, and speed labels remain available. Background map tiles require internet.'
              : 'Heightened privacy: saved roads, trip geometry, editing, and speed labels stay local without background map tiles.'}
          </div>
        )}
        {rawSections.length > 0 && sections.length === 0 && !addMode && (
          <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-[500] rounded-xl border border-border bg-background/95 px-4 py-3 text-sm shadow-lg">
            No sections match the current map filters.
          </div>
        )}
        {rawSections.length === 0 && !addMode && (
          <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-[500] rounded-xl border border-border bg-background/95 px-4 py-3 text-sm shadow-lg">
            Record a trip or save a road speed to populate this map.
          </div>
        )}
        {addMode && addPath.length === 0 && (
          <div className="pointer-events-none absolute bottom-5 left-1/2 z-[500] -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-lg">
            Tap along the road to start tracing
          </div>
        )}
      </div>
    </div>
  );
}
