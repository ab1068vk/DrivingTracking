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

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const DEFAULT_CENTER = [43.6532, -79.3832];
const MAX_PERMANENT_LABELS = 80;

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
  positions[Math.floor(positions.length / 2)] || positions[0] || null
);

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

const stopLeafletMap = (map) => {
  safeLeafletCall(() => map?.stop?.());
  safeLeafletCall(() => map?.closePopup?.());
  safeLeafletCall(() => map?.closeTooltip?.());
};

const safeMapSetView = (map, center, zoom, options = {}) => safeLeafletCall(() => (
  map?.setView?.(center, zoom, { animate: false, ...options })
));

const safeMapFitBounds = (map, bounds, options = {}) => {
  if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) return null;
  return safeLeafletCall(() => map?.fitBounds?.(bounds, { animate: false, ...options }));
};

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
    ? `${Math.round(Number(displayLimitKmh))} km/h - ${section.roadName || (section.saved ? 'Saved road section' : 'Labeled road section')}`
    : tooltip;
  const labelClassName = labelClassForSection({
    selected,
    conflict,
    saved: section.saved,
    hasDisplayLimit,
    source: section.source,
  });
  const labelText = conflict
    ? `! ${formatLimitLabel(displayLimitKmh)}`
    : formatLimitLabel(displayLimitKmh);
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
    .bindTooltip(display.displayTooltip, { sticky: true })
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

export default function SpeedLimitEditorMap({
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
  const online = useOnlineStatus();
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const sectionLayersRef = useRef(null);
  const selectedLayerRef = useRef(null);
  const editLayerRef = useRef(null);
  const tileLayerRef = useRef(null);
  const addModeRef = useRef(addMode);
  const onSelectRef = useRef(onSelect);
  const onAddPointRef = useRef(onAddPoint);
  const onMoveAddPointRef = useRef(onMoveAddPoint);
  const onMoveSectionPointRef = useRef(onMoveSectionPoint);
  const [mapReady, setMapReady] = useState(false);
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
    return new Set(prioritized.slice(0, MAX_PERMANENT_LABELS).map(sectionKey));
  }, [sections]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
      fadeAnimation: false,
      markerZoomAnimation: false,
      preferCanvas: true,
      zoomAnimation: false,
    });
    mapRef.current = map;
    safeMapSetView(map, center, 13);
    sectionLayersRef.current = L.layerGroup().addTo(map);
    selectedLayerRef.current = L.layerGroup().addTo(map);
    editLayerRef.current = L.layerGroup().addTo(map);
    setMapReady(true);

    const timer = window.setTimeout(() => {
      if (mapRef.current === map) safeLeafletCall(() => map.invalidateSize({ animate: false }));
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
    if (!mapReady || !map) return;

    safeLeafletCall(() => {
      if (tileLayerRef.current) {
        map.removeLayer(tileLayerRef.current);
        tileLayerRef.current = null;
      }
    });
    if (!online) return;

    tileLayerRef.current = L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 19,
    }).addTo(map);
  }, [mapReady, online]);

  useEffect(() => {
    const map = mapRef.current;
    const layers = sectionLayersRef.current;
    if (!mapReady || !map || !layers) return;

    stopLeafletMap(map);
    safeLeafletCall(() => layers.clearLayers());

    sections.forEach((section) => {
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
  }, [mapReady, permanentLabelKeys, sections]);

  useEffect(() => {
    const layers = editLayerRef.current;
    if (!mapReady || !layers) return;

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
    if (!mapReady || !selectedLayers) return;

    safeLeafletCall(() => selectedLayers.clearLayers());
    const selectedSection = (
      selectedSectionOverride &&
      (selectedSectionOverride.sectionKey || selectedSectionOverride.geohash) === selectedGeohash
        ? selectedSectionOverride
        : sections.find((section) => (
      (section.sectionKey || section.geohash) === selectedGeohash
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
      [
        { index: 0, label: 'Start' },
        { index: selectedPoints.length - 1, label: 'End' },
      ].forEach(({ index, label }) => {
        const marker = L.marker([selectedPoints[index][0], selectedPoints[index][1]], {
          draggable: true,
          keyboard: true,
          title: `${label} of selected road section`,
          icon: L.divIcon({
            html: `<div class="speed-limit-endpoint-handle">${label === 'Start' ? 'S' : 'E'}</div>`,
            className: '',
            iconSize: [26, 26],
            iconAnchor: [13, 13],
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
    if (!mapReady || !map) return;
    const points = sections.flatMap(sectionPositions);
    if (!points.length) {
      safeMapSetView(map, center, 13);
      return;
    }
    if (points.length === 1) {
      safeMapSetView(map, points[0], 15);
      return;
    }
    safeMapFitBounds(map, L.latLngBounds(points), { padding: [28, 28], maxZoom: 16 });
  }, [center, mapReady, sections]);

  return (
    <div className="relative z-0 isolate overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className={`relative w-full ${heightClassName}`}>
        <div ref={containerRef} className="h-full w-full" />
        {onLayerChange && (
          <div className="absolute right-3 top-3 z-[500] w-[min(21rem,calc(100%-1.5rem))] rounded-xl border border-border bg-background p-2 shadow-lg">
            <div className="flex items-center justify-between gap-2 px-1 text-[11px] font-semibold text-muted-foreground">
              <span>{visibleStats.total} of {stats.total} sections visible</span>
              <span>{stats.savedRules} saved rules</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
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
        )}
        {!online && (
          <div className="pointer-events-none absolute bottom-20 left-4 z-[500] max-w-[14rem] rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950 shadow-lg dark:border-amber-800 dark:bg-amber-950/90 dark:text-amber-100">
            Offline: saved roads, trip geometry, editing, and speed labels remain available. Background map tiles require internet.
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
