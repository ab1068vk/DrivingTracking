import { useCallback, useEffect, useState } from 'react';
import { getPrivacyZones, savePrivacyZones } from '@/lib/trackingStore';

export function usePrivacyZones() {
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getPrivacyZones()
      .then((loadedZones) => {
        if (active) setZones(loadedZones);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const saveAll = useCallback(async (nextZones) => {
    await savePrivacyZones(nextZones);
    setZones(nextZones);
  }, []);

  const addZone = useCallback((zone) => (
    saveAll([...zones, zone])
  ), [saveAll, zones]);

  const updateZone = useCallback((index, zone) => {
    const nextZones = zones.map((item, itemIndex) => (
      itemIndex === index ? zone : item
    ));
    return saveAll(nextZones);
  }, [saveAll, zones]);

  const deleteZone = useCallback((index) => (
    saveAll(zones.filter((_, itemIndex) => itemIndex !== index))
  ), [saveAll, zones]);

  return {
    addZone,
    deleteZone,
    loading,
    updateZone,
    zones,
  };
}
