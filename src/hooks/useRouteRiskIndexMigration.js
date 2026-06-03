import { useEffect, useMemo, useRef, useState } from 'react';
import { ensureRouteRiskIndexMigration, loadRouteRiskIndex } from '@/lib/routeRiskIndex';

const fingerprintString = (hash, value) => {
  const text = value == null ? '' : String(value);
  let next = hash;
  for (let index = 0; index < text.length; index += 1) {
    next = Math.imul(next ^ text.charCodeAt(index), 16777619) >>> 0;
  }
  return next;
};

const fingerprintNumber = (hash, value, precision = 1) => {
  const number = Number(value);
  return fingerprintString(hash, Number.isFinite(number) ? Math.round(number * precision) : '');
};

const buildTripsKey = (completedTrips = []) => {
  const trips = completedTrips || [];
  let hash = 2166136261;
  for (const trip of trips) {
    hash = fingerprintString(hash, trip?.id);
    hash = fingerprintString(hash, trip?.updated_at);
    hash = fingerprintNumber(hash, trip?.score_overall, 100);
    hash = fingerprintNumber(hash, trip?.route_risk_cells?.length || 0);
  }
  const latestTrip = trips[0];
  return `${trips.length}:${latestTrip?.id ?? ''}:${latestTrip?.score_overall ?? ''}:${hash}`;
};

const buildPrivacyZonesKey = (privacyZones = []) => {
  const zones = privacyZones || [];
  let hash = 2166136261;
  for (const zone of zones) {
    hash = fingerprintString(hash, zone?.id);
    hash = fingerprintNumber(hash, zone?.lat, 1_000_000);
    hash = fingerprintNumber(hash, zone?.lng, 1_000_000);
    hash = fingerprintNumber(hash, zone?.radius_m);
  }
  return `${zones.length}:${hash}`;
};

export function useRouteRiskIndexMigration(completedTrips = [], privacyZones = []) {
  const [status, setStatus] = useState({ status: 'idle', completed: 0, total: 0 });
  const [routeRiskIndex, setRouteRiskIndex] = useState(new Map());
  const tripsFingerprint = useRef('');
  const privacyZonesFingerprint = useRef('');
  const tripsKey = useMemo(() => {
    const fingerprint = buildTripsKey(completedTrips);
    if (fingerprint === tripsFingerprint.current) return tripsFingerprint.current;
    tripsFingerprint.current = fingerprint;
    return fingerprint;
  }, [completedTrips]);
  const privacyZonesKey = useMemo(() => {
    const fingerprint = buildPrivacyZonesKey(privacyZones);
    if (fingerprint === privacyZonesFingerprint.current) return privacyZonesFingerprint.current;
    privacyZonesFingerprint.current = fingerprint;
    return fingerprint;
  }, [privacyZones]);

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
