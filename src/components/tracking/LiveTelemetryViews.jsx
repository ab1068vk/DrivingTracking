import { Activity, Clock3, Gauge, Navigation, Satellite, TimerReset, TrendingUp, Zap } from 'lucide-react';
import { formatLiveDuration } from '@/lib/liveTrackingTelemetry';
import {
  formatDistance as formatTripDistance,
  formatSpeed as formatTripSpeed,
} from '@/lib/tripEngine';
import { convertSpeedKmh, speedUnitLabel } from '@/lib/unitFormatting';

export const liveNumber = (value, digits = 0) => Number.isFinite(Number(value))
  ? Number(value).toFixed(digits)
  : 'Unavailable';

export const telemetryLabel = (value) => String(value || 'unavailable')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (character) => character.toUpperCase());

export const eventAgeLabel = (timestamp) => {
  const time = new Date(timestamp || 0).getTime();
  if (!Number.isFinite(time) || time <= 0) return 'Time unavailable';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)}h ago`;
};

export function LiveMetric({ label, value, icon: Icon }) {
  return (
    <div className="min-w-0 border-b border-white/10 px-3 py-4 odd:border-r sm:border-b-0 sm:border-r sm:last:border-r-0">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500"><Icon className="h-3.5 w-3.5" />{label}</div>
      <div className="mt-2 truncate font-grotesk text-lg font-bold text-slate-100">{value}</div>
    </div>
  );
}

export function SignalGroup({ icon: Icon, title, children }) {
  return (
    <section className="min-w-0 border-b border-white/10 p-4 sm:p-6 md:border-r xl:border-b-0 xl:last:border-r-0">
      <div className="flex items-center gap-2"><Icon className="h-4 w-4 text-cyan-300" /><h2 className="font-semibold">{title}</h2></div>
      <div className="mt-4 divide-y divide-white/10">{children}</div>
    </section>
  );
}

export function SignalRow({ label, value }) {
  return <div className="flex items-start justify-between gap-4 py-3 text-sm"><span className="text-slate-400">{label}</span><span className="max-w-[58%] text-right font-semibold text-slate-100">{value}</span></div>;
}

export function SpeedTrace({ points = [], units = 'metric' }) {
  const speeds = points.map((point) => Number(point?.speed_kmh)).filter(Number.isFinite).slice(-60);
  if (speeds.length < 2) return <div className="grid h-20 place-items-center rounded-lg border border-dashed border-white/10 text-xs text-slate-500">Speed trace waiting for samples</div>;
  const max = Math.max(20, ...speeds);
  const coordinates = speeds.map((speed, index) => {
    const x = speeds.length === 1 ? 0 : index / (speeds.length - 1) * 100;
    const y = 38 - Math.max(0, Math.min(1, speed / max)) * 34;
    return `${x},${y}`;
  }).join(' ');
  return (
    <div>
      <svg viewBox="0 0 100 42" preserveAspectRatio="none" className="h-20 w-full" role="img" aria-label="Recent speed trace">
        <line x1="0" y1="38" x2="100" y2="38" stroke="rgba(148,163,184,.2)" strokeWidth=".5" />
        <polyline points={coordinates} fill="none" stroke="#67e8f9" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-500"><span>Recent speed</span><span>Peak {formatTripSpeed(max, units)}</span></div>
    </div>
  );
}

export function LiveRoutePlot({ points = [], maskedCount = 0 }) {
  const segments = [];
  let segment = [];
  points.forEach((point) => {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    const gap = point?.masked_for_privacy === true || point?.tracking_gap === true || point?.route_gap === true || !Number.isFinite(lat) || !Number.isFinite(lng);
    if (gap) {
      if (segment.length) segments.push(segment);
      segment = [];
      return;
    }
    segment.push({ lat, lng });
  });
  if (segment.length) segments.push(segment);
  const coordinates = segments.flat();
  if (coordinates.length < 2) {
    return <div className="grid min-h-80 place-items-center rounded-xl border border-dashed border-white/10 bg-slate-900/60 p-6 text-center text-sm text-slate-400">Route trace is waiting for at least two public GPS samples.</div>;
  }
  const lats = coordinates.map((point) => point.lat);
  const lngs = coordinates.map((point) => point.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latRange = Math.max(0.00001, maxLat - minLat);
  const lngRange = Math.max(0.00001, maxLng - minLng);
  const project = (point) => ({
    x: 5 + ((point.lng - minLng) / lngRange) * 90,
    y: 95 - ((point.lat - minLat) / latRange) * 90,
  });
  const projected = segments.map((row) => row.map(project));
  const finalPoint = projected[projected.length - 1]?.[projected[projected.length - 1].length - 1];
  return (
    <div className="relative min-h-80 overflow-hidden rounded-xl border border-white/10 bg-slate-900/80">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" role="img" aria-label="Privacy-redacted local route trace">
        {[20, 40, 60, 80].map((position) => <g key={position}><line x1={position} y1="0" x2={position} y2="100" stroke="rgba(148,163,184,.08)" strokeWidth=".4" /><line x1="0" y1={position} x2="100" y2={position} stroke="rgba(148,163,184,.08)" strokeWidth=".4" /></g>)}
        {projected.map((row, index) => <polyline key={index} points={row.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#22d3ee" strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />)}
        {finalPoint && <circle cx={finalPoint.x} cy={finalPoint.y} r="2.2" fill="#a7f3d0" stroke="#0f172a" strokeWidth=".7" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="absolute left-3 top-3 rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-xs text-slate-300">North ↑</div>
      <div className="absolute bottom-3 left-3 right-3 flex flex-wrap justify-between gap-2 rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-xs text-slate-300"><span>{coordinates.length} preview samples</span><span>{maskedCount ? `${maskedCount} privacy-masked` : 'No masked samples in preview'}</span></div>
    </div>
  );
}

export function DriveTelemetryView({ snapshot, units = 'metric', scorePanel = null }) {
  const eventCounts = Object.entries(snapshot.eventCounts).filter(([, count]) => count > 0).slice(0, 6);
  const speedKnown = snapshot.currentSpeedKmh != null;
  const overKnownLimit = snapshot.speedDeltaKmh != null && snapshot.speedDeltaKmh > 0;
  const speedUnit = speedUnitLabel(units);
  const currentSpeed = speedKnown ? Math.round(convertSpeedKmh(snapshot.currentSpeedKmh, units)) : '—';
  return (
    <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]">
      <div className="min-w-0 border-b border-white/10 p-4 sm:p-6 lg:border-b-0 lg:border-r">
        <div className="grid gap-5 sm:grid-cols-[minmax(12rem,0.65fr)_minmax(0,1fr)] sm:items-end">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Current speed</div>
            <div className="mt-2 flex items-end gap-3">
              <span className="font-grotesk text-7xl font-bold leading-none tracking-tight sm:text-8xl">{currentSpeed}</span>
              <span className="mb-2 text-lg font-semibold text-slate-400">{speedUnit}</span>
            </div>
            <div className={`mt-3 inline-flex rounded-lg border px-3 py-2 text-sm font-semibold ${
              speedKnown ? 'border-white/10 bg-white/5 text-slate-200' : 'border-amber-300/20 bg-amber-300/10 text-amber-100'
            }`}>
              {speedKnown ? snapshot.currentSpeedKmh < 1 ? 'Reliable fix · stationary' : snapshot.gps.label : 'Speed unavailable · GPS settling'}
            </div>
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Local speed context</div>
                <div className="mt-1 font-grotesk text-3xl font-bold">
                  {snapshot.speedLimitKmh == null ? 'Limit unavailable' : formatTripSpeed(snapshot.speedLimitKmh, units)}
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {snapshot.speedLimitSource ? `Source: ${telemetryLabel(snapshot.speedLimitSource)}` : 'No saved local road limit matched this position.'}
                </div>
              </div>
              {snapshot.speedDeltaKmh != null && (
                <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                  overKnownLimit ? 'border-red-300/30 bg-red-300/10 text-red-200' : 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200'
                }`}>
                  {overKnownLimit ? `+${formatTripSpeed(snapshot.speedDeltaKmh, units)} threshold` : `${formatTripSpeed(Math.abs(snapshot.speedDeltaKmh), units)} below`}
                </span>
              )}
            </div>
            <div className="mt-5"><SpeedTrace points={snapshot.routePreview} units={units} /></div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 border-y border-white/10 sm:grid-cols-5">
          <LiveMetric label="Elapsed" value={formatLiveDuration(snapshot.durationSeconds)} icon={Clock3} />
          <LiveMetric label="Distance" value={formatTripDistance(snapshot.distanceKm, units)} icon={Navigation} />
          <LiveMetric label="Average" value={snapshot.averageSpeedKmh == null ? '—' : formatTripSpeed(snapshot.averageSpeedKmh, units)} icon={TrendingUp} />
          <LiveMetric label="Maximum" value={snapshot.maxSpeedKmh == null ? '—' : formatTripSpeed(snapshot.maxSpeedKmh, units)} icon={Gauge} />
          <LiveMetric label="Stopped" value={formatLiveDuration(snapshot.stoppedSeconds)} icon={TimerReset} />
        </div>

        {scorePanel}
      </div>

      <aside className="min-w-0 p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div><div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Live observations</div><h2 className="mt-1 text-lg font-bold">Event timeline</h2></div>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300">{snapshot.events.length} recent</span>
        </div>
        {snapshot.possibleIncidentActive && (
          <div className="mt-4 rounded-xl border border-red-300/30 bg-red-400/10 p-3 text-sm text-red-100">
            <div className="font-bold">Possible incident signal active</div>
            <div className="mt-1 text-xs text-red-100/80">Review the emergency check-in when it is safe.</div>
          </div>
        )}
        {snapshot.latestEvent ? (
          <div className="mt-4 border-l-2 border-cyan-300 pl-3">
            <div className="text-sm font-semibold">{snapshot.latestEvent.title}</div>
            <div className="mt-1 text-xs text-slate-400">{eventAgeLabel(snapshot.latestEvent.timestamp)}{snapshot.latestEvent.speedKmh != null ? ` · ${formatTripSpeed(snapshot.latestEvent.speedKmh, units)}` : ''}</div>
          </div>
        ) : (
          <div className="mt-4 border-l-2 border-slate-700 pl-3 text-sm text-slate-400">No live threshold events recorded.</div>
        )}
        <div className="mt-5 divide-y divide-white/10 border-y border-white/10">
          {eventCounts.length ? eventCounts.map(([type, count]) => (
            <div key={type} className="flex items-center justify-between gap-3 py-3 text-sm">
              <span className="text-slate-300">{telemetryLabel(type)}</span><span className="font-grotesk text-lg font-bold">{count}</span>
            </div>
          )) : <div className="py-5 text-sm text-slate-400">Counts will appear when a configured on-device threshold is exceeded.</div>}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-slate-500">Keep attention on the road. Detailed signals are intended for a passenger or parked review.</p>
      </aside>
    </div>
  );
}

export function RouteTelemetryView({ snapshot }) {
  return (
    <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 border-b border-white/10 p-4 sm:p-6 lg:border-b-0 lg:border-r">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">API-free route view</div><h2 className="mt-1 text-xl font-bold">Local route trace</h2></div>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300">{snapshot.routePointCount} points recorded</span>
        </div>
        <div className="mt-4"><LiveRoutePlot points={snapshot.routePreview} maskedCount={snapshot.routeMaskedCount} /></div>
      </div>
      <aside className="divide-y divide-white/10 p-4 sm:p-6">
        <SignalRow label="Route points retained" value={String(snapshot.routePointCount)} />
        <SignalRow label="Preview points" value={String(snapshot.routePreview.length)} />
        <SignalRow label="Route gaps" value={String(snapshot.routeGapCount)} />
        <SignalRow label="Gap time" value={formatLiveDuration(snapshot.gapSeconds)} />
        <SignalRow label="Privacy-masked samples" value={String(snapshot.routeMaskedCount)} />
        <SignalRow label="Heading" value={snapshot.headingDeg == null ? 'Unavailable' : `${Math.round(snapshot.headingDeg)}°`} />
        <SignalRow label="Altitude" value={snapshot.altitudeM == null ? 'Unavailable' : `${Math.round(snapshot.altitudeM)} m`} />
        <div className="pt-4 text-xs leading-relaxed text-slate-500">This trace is drawn from local GPS samples. It does not require map tiles, routing services, or a paid API.</div>
      </aside>
    </div>
  );
}

export function SignalTelemetryView({ snapshot }) {
  return (
    <div className="grid min-w-0 md:grid-cols-2 xl:grid-cols-3">
      <SignalGroup icon={Satellite} title="GPS evidence">
        <SignalRow label="Fix state" value={snapshot.gps.label} />
        <SignalRow label="Accuracy" value={snapshot.gps.accuracyM == null ? 'Unavailable' : `±${Math.round(snapshot.gps.accuracyM)} m`} />
        <SignalRow label="Fix age" value={snapshot.gps.fixAgeSeconds == null ? 'Unavailable' : `${Math.round(snapshot.gps.fixAgeSeconds)} s`} />
        <SignalRow label="Snapshot age" value={snapshot.updateAgeSeconds == null ? 'Unavailable' : `${Math.round(snapshot.updateAgeSeconds)} s`} />
        <SignalRow label="Permission loss" value={snapshot.gps.key === 'lost' ? 'Recorded' : 'Not recorded'} />
      </SignalGroup>
      <SignalGroup icon={Zap} title="Motion evidence">
        <SignalRow label="Longitudinal acceleration" value={snapshot.accelerationMs2 == null ? 'Unavailable' : `${liveNumber(snapshot.accelerationMs2, 2)} m/s²`} />
        <SignalRow label="Estimated lateral force" value={snapshot.lateralG == null ? 'Unavailable' : `${liveNumber(snapshot.lateralG, 3)} g`} />
        <SignalRow label="Heading rate" value={snapshot.headingRateDegS == null ? 'Unavailable' : `${liveNumber(snapshot.headingRateDegS, 1)}°/s`} />
        <SignalRow label="Linear motion" value={snapshot.linearMotionMagnitudeMs2 == null ? 'Unavailable' : `${liveNumber(snapshot.linearMotionMagnitudeMs2, 2)} m/s²`} />
        <SignalRow label="Rotation" value={snapshot.rotationMagnitudeDegS == null ? 'Unavailable' : `${liveNumber(snapshot.rotationMagnitudeDegS, 1)}°/s`} />
      </SignalGroup>
      <SignalGroup icon={Activity} title="Recorder state">
        <SignalRow label="Activity" value={`${telemetryLabel(snapshot.activityType)}${snapshot.activityConfidence == null ? '' : ` · ${Math.round(snapshot.activityConfidence)}%`}`} />
        <SignalRow label="Motion samples" value={String(snapshot.motionSampleCount)} />
        <SignalRow label="Linear sensor" value={snapshot.linearAccelerationSensorReady ? 'Available' : 'Unavailable'} />
        <SignalRow label="Gyroscope" value={snapshot.gyroscopeSensorReady ? 'Available' : 'Unavailable'} />
        <SignalRow label="Stopped drift" value={`${liveNumber(snapshot.maxDriftSinceStopM, 1)} m`} />
      </SignalGroup>
    </div>
  );
}
