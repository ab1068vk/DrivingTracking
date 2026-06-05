import { useEffect, useMemo, useState } from 'react';
import { ensureRouteRiskIndexMigration, loadRouteRiskIndex } from '@/lib/routeRiskIndex';

export function useRouteRiskIndexMigration(completedTrips = [], privacyZones = []) {
  const [status, setStatus] = useState({ status: 'idle', completed: 0, total: 0 });
  const [routeRiskIndex, setRouteRiskIndex] = useState(new Map());
  const tripsKey = useMemo(() => JSON.stringify((completedTrips || []).map((trip) => [
    trip.id,
    trip.updated_at,
    trip.route_risk_cells?.length || 0,
  ])), [completedTrips]);
  const privacyZonesKey = useMemo(() => JSON.stringify((privacyZones || []).map((zone) => [
    zone.id,
    Number(zone.lat),
    Number(zone.lng),
    Number(zone.radius_m),
  ])), [privacyZones]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const onProgress = (detail) => {
        if (!cancelled) setStatus(detail);
      };
      try {
        const migration = await ensureRouteRiskIndexMigration({
          trips: completedTrips,
          privacyZones,
          onProgress,
        });
        const index = migration.index || await loadRouteRiskIndex(privacyZones);
        if (!cancelled) {
          setRouteRiskIndex(index);
          setStatus((current) => current.status === 'running'
            ? { status: 'complete', completed: completedTrips.length, total: completedTrips.length }
            : current);
        }
      } catch {
        if (!cancelled) setStatus({ status: 'error', completed: 0, total: completedTrips.length });
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [tripsKey, privacyZonesKey]);

  return { routeRiskIndex, routeRiskIndexBuildStatus: status };
}
