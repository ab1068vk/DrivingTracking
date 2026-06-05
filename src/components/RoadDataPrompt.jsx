import { useEffect, useState } from 'react';
import { Route } from 'lucide-react';
import { getJson, setJson } from '@/lib/mobileStorage';

export const ROAD_DATA_PROMPT_DISMISSED_KEY = 'road_sage_road_data_prompt_dismissed';

export function RoadDataPrompt({ settings, onEnable, className = '' }) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getJson(ROAD_DATA_PROMPT_DISMISSED_KEY, false).then((value) => {
      if (!cancelled) setDismissed(Boolean(value));
    }).catch(() => {
      if (!cancelled) setDismissed(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed || settings?.external_context_auto_fetch_enabled !== false) return null;

  const dismiss = () => {
    setDismissed(true);
    setJson(ROAD_DATA_PROMPT_DISMISSED_KEY, true).catch(() => {
      // Intentionally silent - local prompt dismissal should not interrupt the dashboard.
    });
  };

  return (
    <div className={`rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100 ${className}`}>
      <div className="flex items-start gap-3">
        <Route className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Speed limits are estimated</p>
          <p className="mt-0.5 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
            Enable automatic road data to use posted limits from OpenStreetMap. Route-area boxes are sent; raw GPS coordinates are not sent for OSM speed-limit lookup.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onEnable}
              className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800"
            >
              Enable auto road data
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/30"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
