// @ts-check
// The Dashboard pre-trip readiness panel. Moved out of src/pages/Dashboard.jsx
// unchanged — it was already fully props-threaded there.
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, Clock, Gauge, MapPin, X } from 'lucide-react';
import CalibrationStatusTag from '@/components/CalibrationStatusTag';
import PremiumPreTripPlanner from '@/components/PremiumPreTripPlanner';
import {
  eventTypeLabel,
  formatWatchDistance,
  readinessPlannerTone,
  watchZoneSortDistance,
} from '@/components/dashboard/dashboardHelpers';
import {
  buildFallbackPlannerActions,
  normalizeLocalSpeedPlanner,
} from '@/components/dashboard/dashboardSpeedPlanner';
import { checkDangerZoneProximity } from '@/lib/dangerZoneEngine';
import { computePreTripRisk } from '@/lib/preTripRisk';
import { estimatePredictiveRouteRisk } from '@/lib/predictiveRouteRisk';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import { hasProvisionalCalibration } from '@/lib/scoringConstants';
import { resolveCachedWeatherContextForTrip } from '@/lib/weatherContext';

const ROUTE_RISK_IS_APPROXIMATE = hasProvisionalCalibration(['route_risk_score']);
const READINESS_SCORE_IS_APPROXIMATE = hasProvisionalCalibration(['pre_trip_readiness_score']);
const DANGER_ZONE_WATCH_LIMIT = 3;

export default function DashboardRiskPanel({
  completedTrips,
  currentLocation,
  dailyFatigue,
  dangerZones,
  habitProfile,
  localSpeedPlanner,
  onDismiss,
  settings,
}) {
  const [cachedWeatherRiskScore, setCachedWeatherRiskScore] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!currentLocation) {
      setCachedWeatherRiskScore(null);
      return () => {
        cancelled = true;
      };
    }
    const now = new Date().toISOString();
    resolveCachedWeatherContextForTrip([
      { lat: Number(currentLocation.lat), lng: Number(currentLocation.lng), timestamp: now },
    ], now, now, settings).then((context) => {
      if (cancelled) return;
      setCachedWeatherRiskScore(
        context?.source === 'open_meteo' && Number.isFinite(Number(context.riskScore))
          ? Number(context.riskScore)
          : null
      );
    }).catch(() => {
      if (!cancelled) setCachedWeatherRiskScore(null);
    });
    return () => {
      cancelled = true;
    };
  }, [currentLocation, settings]);

  const predictiveRouteRisk = useMemo(() => estimatePredictiveRouteRisk({
    trips: completedTrips,
    dangerZones,
    weatherRiskScore: cachedWeatherRiskScore,
    currentLocation,
    habitProfile,
  }), [cachedWeatherRiskScore, completedTrips, currentLocation, dangerZones, habitProfile]);
  const historicalContextEnabled = settings.predictive_route_risk_enabled !== false;

  const preTripRisk = useMemo(() => computePreTripRisk(completedTrips, settings, dailyFatigue, {
    nearbyDangerZoneCount: historicalContextEnabled ? predictiveRouteRisk.nearbyDangerZoneCount : null,
    predictiveRouteRisk: historicalContextEnabled ? predictiveRouteRisk : null,
  }, habitProfile), [completedTrips, dailyFatigue, habitProfile, historicalContextEnabled, predictiveRouteRisk, settings]);
  const readinessEvidence = preTripRisk.dataQuality?.readinessEvidence || 'unavailable';
  const showReadinessNumber = preTripRisk.readinessScore != null;
  const plannerTone = readinessPlannerTone(preTripRisk.riskLevel);
  const units = settings.units || 'metric';
  const nearbyWatchZones = currentLocation
    ? checkDangerZoneProximity(currentLocation.lat, currentLocation.lng, dangerZones, 750)
    : [];
  const watchZones = (nearbyWatchZones.length ? nearbyWatchZones : [...(dangerZones || [])])
    .sort((a, b) => (
      watchZoneSortDistance(a) - watchZoneSortDistance(b) ||
      (Number(b.severityScore) || 0) - (Number(a.severityScore) || 0)
    ))
    .slice(0, DANGER_ZONE_WATCH_LIMIT);
  const fallbackActions = buildFallbackPlannerActions(preTripRisk);
  const topPlannerActions = [
    ...(preTripRisk.topSignals || []).map((signal) => signal.tip),
    ...fallbackActions,
  ].filter(Boolean).slice(0, 3);
  const scoreText = showReadinessNumber
    ? `${formatEstimatedScore(preTripRisk.readinessScore)}/100`
    : 'Learning';
  const historyStatus = predictiveRouteRisk.insufficientHistory
    ? predictiveRouteRisk.primaryFactor
    : `${predictiveRouteRisk.riskLevel} context - ${predictiveRouteRisk.primaryFactor}`;
  const saferWindow = historicalContextEnabled && predictiveRouteRisk.safestWindow
    ? predictiveRouteRisk.safestWindow
    : historicalContextEnabled
      ? 'Complete more scored trips before Road Sage can compare departure windows.'
      : 'Historical context is disabled in Settings.';
  const localSpeed = normalizeLocalSpeedPlanner(localSpeedPlanner);
  const localSpeedSummary = localSpeed.summary || {};
  const localSpeedEmptyText = localSpeedSummary.savedRuleCount || localSpeedSummary.learnedCellCount
    ? localSpeed.hasLocation
      ? 'No local speed warnings near your current position.'
      : 'No local speed warnings need attention right now.'
    : 'No saved local speed rules yet. Saved road speeds will appear here before a drive.';

  const readinessRangeText = preTripRisk.readinessRange
    ? `${preTripRisk.readinessRange.low}-${preTripRisk.readinessRange.high}`
    : 'withheld';

  if (settings.premium_visual_experience === true) {
    const watchZoneItems = watchZones.map((zone) => {
      const distance = formatWatchDistance(zone.distanceM, units);
      return {
        key: zone.id || `${zone.lat}:${zone.lng}`,
        title: eventTypeLabel(zone.dominantType),
        detail: [
          distance ? `${distance} away` : '',
          zone.eventCount ? `${zone.eventCount} past events` : '',
        ].filter(Boolean).join(' - '),
      };
    });

    return (
      <PremiumPreTripPlanner
        actions={topPlannerActions}
        historicalContextEnabled={historicalContextEnabled}
        historyStatus={historyStatus}
        localSpeedEmptyText={localSpeedEmptyText}
        localSpeedItems={localSpeed.items}
        onDismiss={onDismiss}
        plannerTone={plannerTone}
        predictiveRouteRisk={predictiveRouteRisk}
        preTripRisk={preTripRisk}
        readinessApproximate={READINESS_SCORE_IS_APPROXIMATE}
        readinessEvidence={readinessEvidence}
        routeRiskApproximate={ROUTE_RISK_IS_APPROXIMATE}
        saferWindow={saferWindow}
        scoreText={scoreText}
        watchZoneEmptyText={currentLocation
          ? 'No repeated-event areas are near your current position.'
          : 'Turn on location to check nearby repeated-event areas before starting.'}
        watchZoneItems={watchZoneItems}
      />
    );
  }
  return (
    <div className="rounded-2xl border border-border bg-card p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div
          className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-xl text-center text-[11px] font-bold text-white"
          style={{
            background: plannerTone.color,
          }}
        >
          <span className="leading-tight">{scoreText}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="min-w-0 break-words font-semibold">Pre-trip readiness planner</h2>
              {READINESS_SCORE_IS_APPROXIMATE && <CalibrationStatusTag />}
            </span>
            <button
              onClick={onDismiss}
              className="flex-shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-secondary"
              aria-label="Dismiss readiness card"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-1 grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px]">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${plannerTone.className}`}>
                  {plannerTone.status}
                </span>
                <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold capitalize text-muted-foreground">
                  {readinessEvidence} evidence
                </span>
              </div>
              <div className="mt-1 break-words text-base font-grotesk font-bold">{plannerTone.headline}</div>
              <p className="mt-0.5 line-clamp-1 break-words text-xs text-muted-foreground">{plannerTone.guidance}</p>
              {preTripRisk.primaryConcern !== 'Insufficient readiness evidence' && (
                <p className="mt-1 break-words text-xs font-medium text-muted-foreground">
                  Main reason: {preTripRisk.primaryConcern}
                </p>
              )}
            </div>
            <div className="rounded-xl bg-secondary/50 p-2.5">
              <div className="text-[11px] font-semibold text-muted-foreground">Likely range</div>
              <div className="font-grotesk text-lg font-bold capitalize">{readinessRangeText}</div>
              <div className="text-[11px] capitalize text-muted-foreground">
                {preTripRisk.riskLevel === 'unavailable'
                  ? 'core evidence needed'
                  : `${preTripRisk.dataQuality.confidenceScore}% confidence - ${preTripRisk.riskLevel} risk`}
              </div>
            </div>
          </div>

          <details className="group mt-3 border-t border-border pt-2">
            <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-semibold text-primary marker:content-none">
              Advanced readiness details
              <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-3">
          <div className="grid gap-3 lg:grid-cols-4">
            <div className="rounded-2xl border border-border bg-secondary/35 p-3 text-xs">
              <div className="flex items-center gap-2 font-semibold">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                Before you start
              </div>
              <div className="mt-2 space-y-2 text-muted-foreground">
                {topPlannerActions.map((action) => (
                  <div key={action} className="break-words leading-snug">{action}</div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-secondary/35 p-3 text-xs">
              <div className="flex items-center gap-2 font-semibold">
                <Clock className="h-4 w-4 text-primary" />
                Better window
              </div>
              <div className="mt-2 break-words leading-snug text-muted-foreground">{saferWindow}</div>
            </div>

            <div className="rounded-2xl border border-border bg-secondary/35 p-3 text-xs">
              <div className="flex items-center gap-2 font-semibold">
                <Gauge className="h-4 w-4 text-primary" />
                Saved speed checks
              </div>
              <div className="mt-2 space-y-2 text-muted-foreground">
                {localSpeed.items.length ? localSpeed.items.map((item) => (
                  <div key={item.key} className="break-words leading-snug">
                    <span className={item.tone === 'warn' ? 'font-medium text-orange-600 dark:text-orange-300' : 'font-medium text-foreground'}>
                      {item.title}
                    </span>
                    {item.detail ? ` - ${item.detail}` : ''}
                  </div>
                )) : (
                  <div className="break-words leading-snug">{localSpeedEmptyText}</div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-secondary/35 p-3 text-xs">
              <div className="flex items-center gap-2 font-semibold">
                <MapPin className="h-4 w-4 text-primary" />
                Watch road areas
              </div>
              <div className="mt-2 space-y-2 text-muted-foreground">
                {watchZones.length ? watchZones.map((zone) => {
                  const distance = formatWatchDistance(zone.distanceM, units);
                  return (
                    <div key={zone.id || `${zone.lat}:${zone.lng}`} className="break-words leading-snug">
                      <span className="font-medium text-foreground capitalize">{eventTypeLabel(zone.dominantType)}</span>
                      {distance ? ` - ${distance} away` : ''}
                      {zone.eventCount ? ` - ${zone.eventCount} past events` : ''}
                    </div>
                  );
                }) : (
                  <div className="break-words leading-snug">
                    {currentLocation
                      ? 'No repeated-event areas are near your current position.'
                      : 'Turn on location to check nearby repeated-event areas before starting.'}
                  </div>
                )}
              </div>
            </div>
          </div>

          {preTripRisk.topSignals?.length > 0 && (
            <div className="mt-4 rounded-2xl border border-border bg-background/50 p-3 text-xs">
              <div className="mb-2 font-semibold text-muted-foreground">Risk factors ranked</div>
              <div className="space-y-2">
                {preTripRisk.topSignals.map((signal) => (
                  <div key={signal.key} className="grid grid-cols-[minmax(0,1fr)_48px] items-start gap-3">
                    <div className="min-w-0">
                      <div className="break-words font-medium">{signal.label}</div>
                      <div className="break-words text-muted-foreground">{signal.tip}</div>
                    </div>
                    <span className="text-right font-semibold">{signal.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {historicalContextEnabled && (
            predictiveRouteRisk.insufficientHistory ? (
              <div className="mt-3 rounded-xl bg-secondary/50 p-3 text-xs">
                <div className="font-semibold">Historical context</div>
                <div className="mt-1 font-medium text-muted-foreground">Not enough driving history</div>
                <p className="mt-1 text-muted-foreground">
                  Complete a scored trip with recorded distance before a historical-context estimate is shown.
                </p>
              </div>
            ) : (
              <div className="mt-3 rounded-xl bg-secondary/50 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 flex-wrap items-center gap-2 break-words font-semibold">
                    Estimated historical context
                    {ROUTE_RISK_IS_APPROXIMATE && <CalibrationStatusTag />}
                  </span>
                  <span className={`flex-shrink-0 font-bold capitalize ${
                    predictiveRouteRisk.riskLevel === 'high' ? 'text-red-500' : predictiveRouteRisk.riskLevel === 'moderate' ? 'text-orange-500' : 'text-emerald-500'
                  }`}>
                    {predictiveRouteRisk.riskScore}/100
                  </span>
                </div>
                <div className="mt-1 break-words font-medium text-muted-foreground">{historyStatus}</div>
                <div className="mt-1 break-words text-muted-foreground">{predictiveRouteRisk.primaryFactor}</div>
                <div className="mt-1 break-words text-muted-foreground">{predictiveRouteRisk.safestWindow}</div>
                {predictiveRouteRisk.nearbyDangerZoneCount > 0 && (
                  <div className="mt-1 font-semibold text-orange-600 dark:text-orange-300">
                    {predictiveRouteRisk.nearbyDangerZoneCount} repeated event area{predictiveRouteRisk.nearbyDangerZoneCount === 1 ? '' : 's'} from your history nearby
                  </div>
                )}
                <div className="mt-3 border-t border-border pt-2" aria-label="Estimated historical context component breakdown">
                  <div className="mb-2 font-semibold text-muted-foreground">Signal contributions</div>
                  {predictiveRouteRisk.componentBreakdown.map((component) => (
                    <div key={component.key} className="mb-1.5 flex items-start justify-between gap-3 last:mb-0">
                      <div className="min-w-0">
                        <div className="break-words font-medium">{component.label}</div>
                        <div className="break-words text-muted-foreground">{component.detail}</div>
                      </div>
                      <span className="flex-shrink-0 font-semibold">+{component.contribution}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 border-t border-border pt-2 text-muted-foreground">
                  Internal historical-context estimate only. No planned route is known, and signal thresholds are not validated against collision or casualty outcomes.
                </p>
              </div>
            )
          )}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
