import { useEffect, useState } from 'react';
import {
  getPrivacyZonesRevision,
  PRIVACY_ZONES_CHANGED_EVENT,
} from '@/lib/privacyZones';

export default function usePrivacyZonesRevision() {
  const [revision, setRevision] = useState(() => getPrivacyZonesRevision());

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handlePrivacyZonesChanged = (event) => {
      setRevision(Number(event?.detail?.revision) || getPrivacyZonesRevision());
    };
    window.addEventListener(PRIVACY_ZONES_CHANGED_EVENT, handlePrivacyZonesChanged);
    return () => window.removeEventListener(PRIVACY_ZONES_CHANGED_EVENT, handlePrivacyZonesChanged);
  }, []);

  return revision;
}
