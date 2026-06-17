import { useEffect, useState } from 'react';
import { localSettings, SETTINGS_CHANGED_EVENT } from '@/lib/trackingStore';

export default function useLocalSettings() {
  const [settings, setSettings] = useState(() => localSettings.get());

  useEffect(() => {
    const refresh = (event) => {
      const next = event?.detail?.settings || localSettings.get();
      setSettings((current) => (
        JSON.stringify(current) === JSON.stringify(next) ? current : next
      ));
    };

    window.addEventListener(SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return settings;
}
