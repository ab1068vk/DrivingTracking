import { Info, Route } from 'lucide-react';

export const SOURCE_DETAIL = {
  osm: {
    label: null,
    description: null,
  },
  gps_inferred: {
    label: '1/2 weight',
    description:
      'Speed limits were estimated from GPS - scored at half weight. Fetch road data for a full-confidence score.',
    actionLabel: 'Fetch road data',
  },
  none: {
    label: 'No data',
    description: 'No speed-limit data was available. Compliance score is omitted.',
    actionLabel: null,
  },
};

export function normalizeComplianceSpeedLimitSource(source) {
  const value = String(source || '').toLowerCase();
  if (['osm', 'openstreetmap', 'osm_highway_default'].includes(value)) return 'osm';
  if (['gps_inferred', 'gps_inferred_speed_limit', 'inferred'].includes(value)) return 'gps_inferred';
  return 'none';
}

export function ComplianceScore({
  score,
  isProvisional = false,
  speedLimitSource,
  onFetch,
  label = 'Compliance',
  className = '',
}) {
  const source = normalizeComplianceSpeedLimitSource(speedLimitSource);
  const detail = SOURCE_DETAIL[source] || SOURCE_DETAIL.none;
  const numericScore = Number(score);
  const hasScore = score != null && Number.isFinite(numericScore);
  const displayScore = hasScore ? `${isProvisional ? '~' : ''}${Math.round(numericScore)}` : '-';

  return (
    <div className={`compliance-block ${className}`}>
      <div className="compliance-header flex items-center justify-between gap-2">
        <span className="compliance-label text-sm font-semibold">{label}</span>
        {detail.label && (
          <span className="compliance-source-badge inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
            {detail.label}
          </span>
        )}
      </div>

      <span
        className={`compliance-value font-grotesk text-2xl font-bold leading-tight ${
          isProvisional ? 'provisional' : ''
        } ${source === 'none' ? 'unavailable text-muted-foreground' : ''}`}
      >
        {displayScore}
      </span>

      {detail.description && (
        <p className="compliance-caveat mt-1 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span>{detail.description}</span>
          {detail.actionLabel && onFetch && (
            <button
              type="button"
              className="compliance-fetch-link inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold text-primary hover:bg-primary/10"
              onClick={onFetch}
            >
              <Route className="h-3 w-3" />
              {detail.actionLabel}
            </button>
          )}
        </p>
      )}
    </div>
  );
}
