export function TrackingHealthChip({ nativeStatus, permissions, trackingMode }) {
  if (trackingMode !== 'background_auto') return null;

  const nativeRunning = nativeStatus?.running ?? nativeStatus?.enabled;
  const batteryOptimizationIgnored =
    permissions?.batteryOptimizationIgnored ?? nativeStatus?.batteryOptimizationIgnored;

  const isHealthy =
    nativeRunning === true &&
    permissions?.backgroundLocation === 'granted' &&
    permissions?.activityRecognition === 'granted' &&
    batteryOptimizationIgnored === true;

  if (isHealthy) return null;

  const problems = [
    nativeRunning !== true && 'service not running',
    permissions?.backgroundLocation !== 'granted' && 'background location denied',
    permissions?.activityRecognition !== 'granted' && 'activity permission missing',
    batteryOptimizationIgnored !== true && 'battery restricted',
  ].filter(Boolean);

  return (
    <div className="mt-3 inline-flex flex-col gap-1">
      {problems.map((problem) => (
        <div
          key={problem}
          className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
          Tracking degraded - {problem}
        </div>
      ))}
    </div>
  );
}
