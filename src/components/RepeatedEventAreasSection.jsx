// @ts-check
import { AlertTriangle } from 'lucide-react';
import PremiumEventAreasCard from '@/components/PremiumEventAreasCard';

const STANDARD_CARD = 'min-w-0 overflow-hidden rounded-3xl border border-border bg-card p-5 shadow-sm';

const eventTypeLabel = (value) => ({
  harsh_brake: 'harsh braking',
  sharp_turn: 'sharp turns',
  rapid_acceleration: 'rapid acceleration',
  speeding: 'speeding',
}[value] || String(value || 'mixed events').replaceAll('_', ' '));

function StandardSectionHeading({ dangerZoneCount }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="mb-2 flex min-w-0 items-center gap-2 text-xs font-bold uppercase tracking-wide text-primary">
          <AlertTriangle className="h-4 w-4" />
          Repeated event areas
        </div>
        <h2 className="font-grotesk text-xl font-bold">
          {dangerZoneCount ? `${dangerZoneCount} local areas need attention` : 'No repeated event area has enough evidence yet'}
        </h2>
        <p className="mt-1 max-w-2xl break-words text-sm text-muted-foreground">
          Coordinates stay in the existing private map workflow; this summary only explains the pattern.
        </p>
      </div>
    </div>
  );
}

/**
 * Keeps the standard Coaching card byte-for-byte equivalent in structure while
 * switching only the premium branch through the persisted appearance setting.
 * @param {{
 *  canToggleAll: boolean,
 *  completedTripCount: number,
 *  dangerZones: Array<Record<string, any>>,
 *  dangerZonesReady: boolean,
 *  displayedDangerZones: Array<Record<string, any>>,
 *  hiddenDangerZoneCount: number,
 *  loading: boolean,
 *  onShowAll: () => void,
 *  onShowOnMap: () => void,
 *  premium: boolean,
 *  relativeTimeFormatter: (value: any) => string,
 *  showAllDangerZones: boolean,
 *  units: string,
 * }} props
 */
export default function RepeatedEventAreasSection({
  canToggleAll,
  completedTripCount,
  dangerZones,
  dangerZonesReady,
  displayedDangerZones,
  hiddenDangerZoneCount,
  loading,
  onShowAll,
  onShowOnMap,
  premium,
  relativeTimeFormatter,
  showAllDangerZones,
  units,
}) {
  if (premium) {
    return (
      <PremiumEventAreasCard
        canToggleAll={canToggleAll}
        completedTripCount={completedTripCount}
        dangerZones={dangerZones}
        dangerZonesReady={dangerZonesReady}
        displayedDangerZones={displayedDangerZones}
        hiddenAreaCount={0}
        hiddenDangerZoneCount={hiddenDangerZoneCount}
        loading={loading}
        onShowAll={onShowAll}
        onShowOnMap={onShowOnMap}
        relativeTimeFormatter={relativeTimeFormatter}
        showAllDangerZones={showAllDangerZones}
        units={units}
        variant="coach"
        visibleDangerZoneCount={dangerZones.length}
      />
    );
  }

  return (
    <section className={STANDARD_CARD}>
      <StandardSectionHeading dangerZoneCount={dangerZones.length} />
      {dangerZones.length > 0 && (
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {dangerZones.slice(0, 6).map((zone) => (
            <div key={zone.id} className="rounded-2xl border border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold capitalize">{eventTypeLabel(zone.dominantType)}</span>
                <span className={`rounded-full px-2 py-1 text-xs font-bold uppercase ${zone.riskLevel === 'critical' || zone.riskLevel === 'high' ? 'bg-red-500/10 text-red-600 dark:text-red-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>{zone.riskLevel}</span>
              </div>
              <div className="mt-2 text-sm text-muted-foreground">
                {zone.kind === 'speeding_stretch'
                  ? `Over the limit on ${zone.tripCount} of ${zone.passes} passes along an approximately ${Math.round(zone.lengthM)} m stretch.`
                  : `${zone.eventCount} events across ${zone.tripCount} separate drives, in an approximately ${Math.round(zone.radiusM)} m area.`}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
