import CalibrationStatusTag from '@/components/CalibrationStatusTag';
import { SectionTitle } from '../settingsComponents';

export function UBISettings({ ctx, visibleSectionIds = null }) {
  const { CALIBRATION_STATUSES, calibrationEntryForSetting, cfg, updateCfg } = ctx;
  const sectionVisible = (id) => !visibleSectionIds || visibleSectionIds.includes(id);
  const controls = [
    { key: 'ubi_optimal_annual_km', label: 'UBI optimal annual km', min: 3000, max: 30000, step: 500 },
    { key: 'ubi_mileage_score_spread_km', label: 'UBI mileage spread km', min: 2000, max: 20000, step: 500 },
  ];

  return (
    <>
      {sectionVisible('settings-ubi') && (
        <>
      <SectionTitle id="settings-ubi">UBI Coaching</SectionTitle>
      <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-100">
        UBI-style scores are coaching estimates for your own trends. They are not an insurance rating, quote, underwriting decision, or premium estimate.
      </div>
      <div className="space-y-4">
        {controls.map(({ key, label, min, max, step }) => (
          <div key={key} className="px-1">
            <div className="flex justify-between text-xs mb-1.5">
              <span className="flex items-center gap-2 font-medium">
                {label}
                {calibrationEntryForSetting(key)?.calibration_status === CALIBRATION_STATUSES.PROVISIONAL && <CalibrationStatusTag />}
              </span>
              <span className="text-primary font-semibold">{cfg[key]}</span>
            </div>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={cfg[key]}
              onChange={e => updateCfg({ [key]: Number(e.target.value) })}
              className="w-full accent-primary"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Used only for the UBI-style mileage score assumption.
            </p>
          </div>
        ))}
      </div>
        </>
      )}
    </>
  );
}
