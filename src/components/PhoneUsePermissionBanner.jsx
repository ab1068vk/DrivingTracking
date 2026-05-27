import { AlertTriangle, ExternalLink } from 'lucide-react';
import { openAndroidUsageAccessSettings } from '@/lib/activityRecognition';
import { METRIC_REGISTRY } from '@/lib/metricRegistry';

const phoneUseMetric = METRIC_REGISTRY.phone_use_score;

export default function PhoneUsePermissionBanner({ className = '' }) {
  const openNativeSettings = openAndroidUsageAccessSettings;

  return (
    <div
      role="note"
      className={`rounded-2xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800/50 dark:bg-blue-950/30 dark:text-blue-200 ${className}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600 dark:text-blue-300" />
          <div>
            <div className="font-semibold">
              Phone use could not be measured for this trip — Android Usage Access is not enabled.
            </div>
            <div className="mt-1 text-xs">
              Your Safety score does not include a phone-use signal.
              {phoneUseMetric?.permissionRequiredNote ? ` ${phoneUseMetric.permissionRequiredNote}` : ''}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={openNativeSettings}
          className="inline-flex flex-shrink-0 items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Enable Usage Access
        </button>
      </div>
    </div>
  );
}
