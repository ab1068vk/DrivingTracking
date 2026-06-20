// @ts-nocheck
import { useEffect, useMemo } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { buildSpeedMapSections, speedLimitColor } from '@/lib/speedLimitMapSections';

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const DEFAULT_CENTER = [43.6532, -79.3832];

function FitSections({ sections }) {
  const map = useMap();

  useEffect(() => {
    const points = sections.flatMap((section) => (
      section.sectionPoints?.length
        ? section.sectionPoints.map((point) => [point.lat, point.lng])
        : [[section.lat, section.lng]]
    )).filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    if (!points.length) return;
    if (points.length === 1) {
      map.setView(points[0], 15);
      return;
    }
    map.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 16 });
  }, [map, sections]);

  return null;
}

function MapAddHandler({ enabled, onAddPoint }) {
  useMapEvents({
    click(event) {
      if (enabled) onAddPoint?.({ lat: event.latlng.lat, lng: event.latlng.lng });
    },
  });
  return null;
}

export default function SpeedLimitEditorMap({
  trips = [],
  corrections = [],
  selectedGeohash = '',
  addMode = false,
  addPath = [],
  onSelect,
  onAddPoint,
}) {
  const sections = useMemo(() => buildSpeedMapSections(trips, corrections), [trips, corrections]);
  const center = sections.length
    ? [sections[0].lat, sections[0].lng]
    : DEFAULT_CENTER;

  return (
    <div className="relative z-0 isolate overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="relative h-[28rem] min-h-[22rem] w-full">
        <MapContainer center={center} zoom={13} className="h-full w-full" scrollWheelZoom>
          <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} />
          <FitSections sections={sections} />
          <MapAddHandler enabled={addMode} onAddPoint={onAddPoint} />
          {sections.map((section) => {
            const displayLimitKmh = section.effectiveLimitKmh ?? section.limitKmh;
            const color = speedLimitColor(displayLimitKmh);
            const selected = section.geohash === selectedGeohash;
            const conflict = Boolean(section.conflict);
            const hasDisplayLimit = Number(displayLimitKmh) > 0;
            const positions = section.sectionPoints?.map((point) => [point.lat, point.lng]) || [];
            const pathOptions = {
              color: conflict ? '#dc2626' : color,
              weight: selected ? 11 : section.saved ? 8 : hasDisplayLimit ? 7 : 6,
              opacity: selected ? 1 : section.saved ? 0.92 : hasDisplayLimit ? 0.84 : 0.72,
              dashArray: conflict ? '2 8' : section.saved ? undefined : hasDisplayLimit ? '4 7' : '8 9',
              lineCap: 'round',
            };
            const tooltip = section.saved
              ? `${Math.round(Number(section.limitKmh))} km/h · ${section.roadName || 'Saved road section'}`
              : `Speed not set · ${section.roadName || 'Recorded road section'}`;

            const displayTooltip = hasDisplayLimit
              ? `${Math.round(Number(displayLimitKmh))} km/h - ${section.roadName || (section.saved ? 'Saved road section' : 'Labeled road section')}`
              : tooltip;

            if (positions.length >= 2) {
              return (
                <Polyline
                  key={section.geohash}
                  positions={positions}
                  pathOptions={pathOptions}
                  eventHandlers={{ click: () => !addMode && onSelect?.(section) }}
                >
                  <Tooltip sticky>{displayTooltip}</Tooltip>
                </Polyline>
              );
            }

            return (
              <CircleMarker
                key={section.geohash}
                center={[section.lat, section.lng]}
                radius={selected ? 10 : 8}
                pathOptions={{
                  color: '#ffffff',
                  weight: conflict ? 4 : 2,
                  fillColor: color,
                  fillOpacity: section.saved ? 0.95 : hasDisplayLimit ? 0.82 : 0.65,
                  dashArray: conflict ? '2 4' : section.saved ? undefined : hasDisplayLimit ? '3 4' : '4 4',
                }}
                eventHandlers={{ click: () => !addMode && onSelect?.(section) }}
              >
                <Tooltip>{displayTooltip}</Tooltip>
              </CircleMarker>
            );
          })}
          {addPath.length >= 2 && (
            <Polyline
              positions={addPath.map((point) => [point.lat, point.lng])}
              pathOptions={{ color: '#2563eb', weight: 8, opacity: 0.95, lineCap: 'round' }}
            />
          )}
          {addPath.map((point, index) => (
            <CircleMarker
              key={`${point.lat}-${point.lng}-${index}`}
              center={[point.lat, point.lng]}
              radius={index === addPath.length - 1 ? 8 : 5}
              pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 }}
            >
              {index === addPath.length - 1 && <Tooltip permanent>Continue tracing</Tooltip>}
            </CircleMarker>
          ))}
        </MapContainer>
        {sections.length === 0 && !addMode && (
          <div className="pointer-events-none absolute left-14 right-4 top-4 z-[500] rounded-xl border border-border bg-background/95 px-4 py-3 text-sm shadow-lg">
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
