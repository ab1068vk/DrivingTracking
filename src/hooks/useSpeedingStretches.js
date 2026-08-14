/**
 * Habitual-speeding stretches for a page that does not already hold the
 * route-risk index.
 *
 * Stretches are derived from that index rather than from trips, because it is
 * the only place passes are counted once per drive — and a rate needs a
 * denominator. The index is stored and rebuilt in the background, so a page can
 * legitimately find it empty; `ready` separates "still learning" from "you have
 * none", which matters here because being told you have no speeding habit when
 * nothing has been measured yet is exactly the failure this work is fixing.
 */
import { useEffect, useMemo, useState } from 'react';
import { loadRouteRiskIndex } from '@/lib/routeRiskIndex';
import { buildSpeedingStretches } from '@/lib/dangerZone/speedingStretches';
import { logError } from '@/lib/errorReporting';

export function useSpeedingStretches(privacyZones = []) {
  const [index, setIndex] = useState(null);

  const privacyZonesKey = useMemo(
    () => JSON.stringify((privacyZones || []).map((zone) => [zone?.lat, zone?.lng, zone?.radius_m])),
    [privacyZones]
  );

  useEffect(() => {
    let cancelled = false;
    loadRouteRiskIndex(privacyZones)
      .then((loaded) => {
        if (!cancelled) setIndex(loaded instanceof Map ? loaded : new Map());
      })
      .catch((error) => {
        logError('speeding_stretch_index_load', error);
        if (!cancelled) setIndex(new Map());
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privacyZonesKey]);

  const stretches = useMemo(() => (index ? buildSpeedingStretches(index) : []), [index]);

  return {
    stretches,
    // False while the index has not been read yet, and also when it is empty:
    // an index with no segments has measured nothing.
    ready: index != null && index.size > 0,
  };
}

export default useSpeedingStretches;
