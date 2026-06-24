import { useEffect, useMemo, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import { ChevronDown, ChevronUp, Clock3, Compass, Map, Route } from 'lucide-react';
import { isPublicPoint } from '@/lib/roadSectionIdentity';
import { isHeightenedPrivacyMode } from '@/lib/privacyMode';
import useLocalSettings from '@/hooks/useLocalSettings';

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors';

const validPoint = (point = {}) => (
  isPublicPoint(point)
);

function SectionMap({ routePoints = [], sectionPoints = [], fallbackPoint = null }) {
  const settings = useLocalSettings();
  const remoteTilesAllowed = !isHeightenedPrivacyMode(settings);
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef([]);
  const leafletRef = useRef(null);
  const [ready, setReady] = useState(false);

  const fullRoute = useMemo(
    () => routePoints.filter(validPoint).map((point) => [Number(point.lat), Number(point.lng)]),
    [routePoints]
  );
  const section = useMemo(
    () => sectionPoints.filter(validPoint).map((point) => [Number(point.lat), Number(point.lng)]),
    [sectionPoints]
  );
  const fallback = validPoint(fallbackPoint)
    ? [Number(fallbackPoint.lat), Number(fallbackPoint.lng)]
    : null;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    let cancelled = false;
    import('leaflet').then(({ default: leaflet }) => {
      if (cancelled || !containerRef.current || mapRef.current) return;
      leafletRef.current = leaflet;
      const map = leaflet.map(containerRef.current, {
        zoomControl: true,
        attributionControl: true,
        dragging: true,
        scrollWheelZoom: false,
      });
      if (remoteTilesAllowed) {
        leaflet.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);
      }
      mapRef.current = map;
      setReady(true);
    });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      leafletRef.current = null;
    };
  }, [remoteTilesAllowed]);

  useEffect(() => {
    const map = mapRef.current;
    const leaflet = leafletRef.current;
    if (!map || !leaflet) return;
    layersRef.current.forEach((layer) => layer.remove());
    layersRef.current = [];

    if (fullRoute.length > 1) {
      layersRef.current.push(leaflet.polyline(fullRoute, {
        color: '#64748b',
        opacity: 0.28,
        weight: 5,
      }).addTo(map));
    }
    if (section.length > 1) {
      const outline = leaflet.polyline(section, { color: '#ffffff', opacity: 0.95, weight: 10 }).addTo(map);
      const highlight = leaflet.polyline(section, { color: '#f97316', opacity: 1, weight: 6 }).addTo(map);
      const start = leaflet.circleMarker(section[0], {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: '#16a34a',
        fillOpacity: 1,
      }).bindTooltip('Section start', { direction: 'top' }).addTo(map);
      const end = leaflet.circleMarker(section.at(-1), {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: '#dc2626',
        fillOpacity: 1,
      }).bindTooltip('Section end', { direction: 'top' }).addTo(map);
      layersRef.current.push(outline, highlight, start, end);
      map.fitBounds(leaflet.latLngBounds(section), { padding: [28, 28], maxZoom: 17 });
    } else if (fallback) {
      const marker = leaflet.circleMarker(fallback, {
        radius: 8,
        color: '#ffffff',
        weight: 3,
        fillColor: '#f97316',
        fillOpacity: 1,
      }).bindTooltip('Saved road area', { direction: 'top' }).addTo(map);
      layersRef.current.push(marker);
      map.setView(fallback, 16);
    }
    setTimeout(() => map.invalidateSize(), 0);
  }, [fallback?.[0], fallback?.[1], fullRoute, ready, section]);

  return (
    <div className="relative">
      <div ref={containerRef} className="h-56 w-full bg-secondary sm:h-64" />
      {!remoteTilesAllowed && (
        <div className="pointer-events-none absolute bottom-3 left-3 right-3 z-[500] rounded-lg border border-amber-200 bg-amber-50/95 px-3 py-2 text-xs font-semibold text-amber-950 shadow dark:border-amber-900/60 dark:bg-amber-950/90 dark:text-amber-100">
          Heightened privacy hides street-map tiles. The saved road section is drawn from local trip geometry.
        </div>
      )}
    </div>
  );
}

export default function RoadSectionPreview({
  identity,
  routePoints = [],
  defaultOpen = false,
  legacyApproximate = false,
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!identity) return null;
  const hasSection = identity.sectionPoints?.length > 1;
  const distanceText = identity.distanceM > 0
    ? identity.distanceM >= 1000
      ? `${(identity.distanceM / 1000).toFixed(1)} km shown`
      : `${identity.distanceM} m shown`
    : null;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-secondary/60"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Route className="h-4 w-4 flex-none text-orange-600" />
            <span className="truncate text-sm font-semibold text-foreground">{identity.title}</span>
          </div>
          <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {identity.directionLabel}; {identity.contextLabel}
          </div>
        </div>
        <span className="flex flex-none items-center gap-1 text-xs font-semibold text-primary">
          <Map className="h-4 w-4" />
          {open ? 'Hide' : 'Show section'}
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </span>
      </button>

      {open && (
        <div className="border-t border-border">
          <SectionMap
            routePoints={routePoints}
            sectionPoints={identity.sectionPoints || []}
            fallbackPoint={{ lat: identity.sampleLat, lng: identity.sampleLng }}
          />
          <div className="grid gap-2 border-t border-border px-3 py-3 text-xs text-muted-foreground sm:grid-cols-3">
            <div className="flex items-center gap-1.5">
              <Compass className="h-3.5 w-3.5" />
              <span className="capitalize">{identity.directionLabel}</span>
            </div>
            {identity.timeLabel && (
              <div className="flex items-center gap-1.5">
                <Clock3 className="h-3.5 w-3.5" />
                <span>Passed at {identity.timeLabel}</span>
              </div>
            )}
            {distanceText && (
              <div className="flex items-center gap-1.5">
                <Route className="h-3.5 w-3.5" />
                <span>{distanceText}</span>
              </div>
            )}
          </div>
          {!hasSection && (
            <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
              {legacyApproximate
                ? 'This older saved speed has only an approximate area. Open a matching trip review to replace it with an exact driven section.'
                : 'Only one recorded point is available here, so the app cannot draw the full road section.'}
            </div>
          )}
          <details className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium">Technical location details</summary>
            <div className="mt-1">
              {Number(identity.sampleLat).toFixed(5)}, {Number(identity.sampleLng).toFixed(5)}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
