// @ts-check
import { CheckCircle2, EyeOff, MapPin, Route, Shield } from 'lucide-react';
import useLocalSettings from '@/hooks/useLocalSettings';
import { formatDistanceMeters } from '@/lib/unitFormatting';

const validPoint = (point) => {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
};

const distanceBetweenM = (a, b) => {
  const toRadians = (value) => value * Math.PI / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
};

const routeLengthM = (points = []) => points.reduce((sum, point, index) => (
  index === 0 ? sum : sum + distanceBetweenM(points[index - 1], point)
), 0);

const durationLabel = (durationDays) => {
  if (durationDays === 'permanent' || durationDays == null || durationDays === '') return 'Permanent until deleted';
  const days = Number(durationDays);
  if (!Number.isFinite(days) || days <= 0) return 'Permanent until deleted';
  if (days === 1) return '24 hours, then the zone expires';
  return `${days} days, then the zone expires`;
};

const svgPathForPoints = (points = []) => points
  .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
  .join(' ');

const schematicPoints = (points = []) => {
  if (!points.length) return [];
  const minLat = Math.min(...points.map((point) => point.lat));
  const maxLat = Math.max(...points.map((point) => point.lat));
  const minLng = Math.min(...points.map((point) => point.lng));
  const maxLng = Math.max(...points.map((point) => point.lng));
  const latSpan = Math.max(0.00001, maxLat - minLat);
  const lngSpan = Math.max(0.00001, maxLng - minLng);
  return points.map((point) => ({
    x: 12 + ((point.lng - minLng) / lngSpan) * 76,
    y: 88 - ((point.lat - minLat) / latSpan) * 76,
  }));
};

function ProtectionDiagram({ type, hasLocation, waypoints, distanceM, units = 'metric' }) {
  const routePoints = schematicPoints(waypoints);
  const routePath = svgPathForPoints(routePoints);
  const bufferWidth = Math.min(24, Math.max(10, distanceM / 14));

  return (
    <div className="rounded-xl border border-border bg-slate-100 p-3 dark:bg-slate-950">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold">
        <span className="inline-flex items-center gap-1.5 text-foreground">
          {type === 'corridor' ? <Route className="h-3.5 w-3.5" /> : <MapPin className="h-3.5 w-3.5" />}
          Local geometry diagram
        </span>
        <span className="rounded-full bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
          No street map
        </span>
      </div>
      <svg
        viewBox="0 0 100 100"
        className="h-44 w-full rounded-lg bg-background/60 sm:h-52"
        role="img"
        aria-label={type === 'corridor' ? 'Protected route corridor diagram' : 'Protected privacy circle diagram'}
      >
        <defs>
          <pattern id="privacy-protection-grid" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(100,116,139,0.34)" strokeWidth="0.35" />
          </pattern>
        </defs>
        <rect x="3" y="3" width="94" height="94" rx="4" fill="url(#privacy-protection-grid)" opacity="0.72" />
        {type === 'corridor' && routePoints.length >= 2 ? (
          <>
            <path d={routePath} fill="none" stroke="#60a5fa" strokeWidth={bufferWidth} strokeLinecap="round" strokeLinejoin="round" opacity="0.34" />
            <path d={routePath} fill="none" stroke="#1d4ed8" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="5 4" />
            {routePoints.map((point, index) => (
              <circle
                key={`${point.x}-${point.y}-${index}`}
                cx={point.x}
                cy={point.y}
                r={index === 0 || index === routePoints.length - 1 ? 3.2 : 2.4}
                fill="#1d4ed8"
                stroke="white"
                strokeWidth="1.2"
              />
            ))}
            <text x="50" y="10" textAnchor="middle" className="fill-slate-700 text-[4px] font-bold dark:fill-slate-100">
              {formatDistanceMeters(distanceM, units)} protected on each side
            </text>
          </>
        ) : hasLocation ? (
          <>
            <circle cx="50" cy="50" r="28" fill="#3b82f6" opacity="0.18" />
            <circle cx="50" cy="50" r="28" fill="none" stroke="#1d4ed8" strokeWidth="2.5" />
            <circle cx="50" cy="50" r="4" fill="#1d4ed8" stroke="white" strokeWidth="1.5" />
            <line x1="50" y1="50" x2="78" y2="50" stroke="#1d4ed8" strokeWidth="1.4" strokeDasharray="3 2" />
            <text x="64" y="47" textAnchor="middle" className="fill-slate-700 text-[4px] font-bold dark:fill-slate-100">
              {formatDistanceMeters(distanceM, units)}
            </text>
            <text x="50" y="59" textAnchor="middle" className="fill-slate-700 text-[3.5px] font-semibold dark:fill-slate-100">
              center
            </text>
          </>
        ) : (
          <text x="50" y="50" textAnchor="middle" className="fill-slate-700 text-[4px] font-bold dark:fill-slate-100">
            Waiting for local GPS point
          </text>
        )}
      </svg>
    </div>
  );
}

function EvidenceRow({ label, children }) {
  return (
    <div className="rounded-lg border border-border bg-background/70 px-3 py-2">
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm text-foreground">{children}</div>
    </div>
  );
}

export default function PrivacyZoneProtectionCheck({
  type = 'circle',
  location = null,
  waypoints = [],
  distanceM = 150,
  sensitivity = 'high',
  durationDays = 'permanent',
}) {
  const normalizedLocation = validPoint(location);
  const settings = useLocalSettings();
  const units = settings.units || 'metric';
  const normalizedWaypoints = Array.isArray(waypoints) ? waypoints.map(validPoint).filter(Boolean) : [];
  const safeDistanceM = Math.round(Math.max(1, Number(distanceM) || 150));
  const isCorridor = type === 'corridor';
  const geometryReady = isCorridor ? normalizedWaypoints.length >= 2 : Boolean(normalizedLocation);
  const routeMeters = isCorridor ? routeLengthM(normalizedWaypoints) : 0;

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
        <div className="flex items-start gap-2">
          <Shield className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">Protection check</div>
            <div className="mt-1 opacity-85">
              This is a local geometry and safety check. It does not load street-map tiles, run a geocoder, or send coordinates away from the app.
            </div>
          </div>
        </div>
      </div>

      <ProtectionDiagram
        type={type}
        hasLocation={Boolean(normalizedLocation)}
        waypoints={normalizedWaypoints}
        distanceM={safeDistanceM}
        units={units}
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <EvidenceRow label={isCorridor ? 'Corridor buffer' : 'Circle radius'}>
          {isCorridor
            ? `${formatDistanceMeters(safeDistanceM, units)} protected on each side, about ${formatDistanceMeters(safeDistanceM * 2, units)} total width with rounded ends.`
            : `${formatDistanceMeters(safeDistanceM, units)} protected in every direction from the center point.`}
        </EvidenceRow>
        <EvidenceRow label={isCorridor ? 'Local route evidence' : 'Local point evidence'}>
          {isCorridor
            ? `${normalizedWaypoints.length} local route point${normalizedWaypoints.length === 1 ? '' : 's'} checked${routeMeters > 0 ? ` across about ${formatDistanceMeters(routeMeters, units)}` : ''}. Exact corridor waypoints are discarded after save.`
            : geometryReady ? 'A local GPS point is available. The exact coordinate is not shown in this check.' : 'No local GPS point is available yet.'}
        </EvidenceRow>
        <EvidenceRow label="Saved data">
          Raw route points and driving-event coordinates inside the protected area are erased or replaced with privacy gaps before local trip storage. Existing saved GPS inside this area is purged when the zone is saved.
        </EvidenceRow>
        <EvidenceRow label="Outbound requests">
          {sensitivity === 'high'
            ? 'High sensitivity blocks OSRM route sharing whenever a route touches this zone. Weather and road-data requests exclude protected coordinates.'
            : 'Protected coordinates and boundary points are excluded from OSRM, weather, and road-data requests.'}
        </EvidenceRow>
        <EvidenceRow label="Exports">
          Privacy-protected exports mask trip coordinates in this area. Portability exports use privacy-zone placeholders instead of exact zone geometry.
        </EvidenceRow>
        <EvidenceRow label="Duration">
          {durationLabel(durationDays)}
        </EvidenceRow>
      </div>

      <div className="rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-start gap-2">
          <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            The diagram is not a map. It only checks shape, radius, corridor buffer, and the privacy actions that will run when protection is saved.
          </div>
        </div>
      </div>

      {!geometryReady && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100">
          Add a valid local {isCorridor ? 'route corridor' : 'GPS point'} before saving this protection.
        </div>
      )}

      {geometryReady && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-background/70 px-3 py-2 text-sm font-semibold">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          Ready to save protection.
        </div>
      )}
    </div>
  );
}
