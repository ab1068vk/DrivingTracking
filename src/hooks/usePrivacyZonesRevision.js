import { useEffect, useState } from 'react';
import {
  ensurePrivacyZonesLoaded,
  getPrivacyZonesRevision,
  PRIVACY_ZONES_CHANGED_EVENT,
} from '@/lib/privacyZones';
import { logSystemFailure } from '@/lib/systemLog';

export default function usePrivacyZonesRevision() {
  const [revision, setRevision] = useState(() => getPrivacyZonesRevision());

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    ensurePrivacyZonesLoaded().catch((error) => {
      logSystemFailure('privacy_zones_revision_hydrate', error);
    });
    const handlePrivacyZonesChanged = (event) => {
      setRevision(Number(event?.detail?.revision) || getPrivacyZonesRevision());
    };
    window.addEventListener(PRIVACY_ZONES_CHANGED_EVENT, handlePrivacyZonesChanged);
    return () => window.removeEventListener(PRIVACY_ZONES_CHANGED_EVENT, handlePrivacyZonesChanged);
  }, []);

  return revision;
}
