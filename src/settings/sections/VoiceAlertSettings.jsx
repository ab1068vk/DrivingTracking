import { Clock, Volume2 } from 'lucide-react';
import { SectionTitle, SettingRow, Toggle } from '../settingsComponents';

const speechRateOptions = [
  { value: 0.7, label: 'Slow' },
  { value: 1.0, label: 'Normal' },
  { value: 1.2, label: 'Fast' },
];

const volumeOptions = [
  { value: 0.3, label: 'Low' },
  { value: 0.6, label: 'Medium' },
  { value: 0.9, label: 'Loud' },
  { value: 1.0, label: 'Full' },
];

const severityOptions = [
  { value: 0, label: 'All alerts' },
  { value: 1, label: 'Warnings and above' },
  { value: 2, label: 'Danger and above' },
  { value: 3, label: 'Critical only' },
];

function SelectSetting({ value, options, onChange, disabled = false }) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
      className="max-w-full rounded-lg border border-border bg-card px-2 py-1 text-xs disabled:opacity-60"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function VoiceAlertSettings({ ctx, visibleSectionIds = null }) {
  const { cfg, runVoiceTest, updateCfg, voiceTestStatus } = ctx;
  const sectionVisible = (id) => !visibleSectionIds || visibleSectionIds.includes(id);
  if (!sectionVisible('settings-voice-alerts')) return null;

  const voiceEnabled = cfg.voice_alerts_enabled !== false;

  return (
    <>
      <SectionTitle id="settings-voice-alerts">Voice Alerts</SectionTitle>
      <div className="rounded-2xl bg-secondary/40 p-3">
        <SettingRow
          icon={Volume2}
          label="Voice alerts"
          sublabel="Spoken safety alerts during active trips"
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                runVoiceTest();
              }}
              className="rounded-lg bg-secondary px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60"
              disabled={!voiceEnabled}
            >
              Test
            </button>
            <Toggle
              value={voiceEnabled}
              onChange={(value) => updateCfg({ voice_alerts_enabled: value })}
            />
          </div>
        </SettingRow>
        {voiceTestStatus && (
          <div className="px-1 pb-3 text-xs text-muted-foreground">
            {voiceTestStatus}
          </div>
        )}
        <div className={`${voiceEnabled ? '' : 'pointer-events-none opacity-50'}`}>
          <SettingRow label="Alert speech rate" sublabel="Adjust the pace of spoken warnings">
            <SelectSetting
              value={cfg.voice_alert_rate ?? 1.0}
              options={speechRateOptions}
              onChange={(value) => updateCfg({ voice_alert_rate: value })}
              disabled={!voiceEnabled}
            />
          </SettingRow>
          <SettingRow label="Alert volume" sublabel="Set spoken alert loudness">
            <SelectSetting
              value={cfg.voice_alert_volume ?? 0.9}
              options={volumeOptions}
              onChange={(value) => updateCfg({ voice_alert_volume: value })}
              disabled={!voiceEnabled}
            />
          </SettingRow>
          <SettingRow label="Minimum alert level" sublabel="Only play alerts at or above this severity">
            <SelectSetting
              value={cfg.voice_alerts_min_severity ?? 1}
              options={severityOptions}
              onChange={(value) => updateCfg({ voice_alerts_min_severity: value })}
              disabled={!voiceEnabled}
            />
          </SettingRow>
          <SettingRow label="Alert tone" sublabel="Brief audio cue before each spoken alert">
            <Toggle
              value={cfg.voice_earcon_enabled !== false}
              onChange={(value) => updateCfg({ voice_earcon_enabled: value })}
              disabled={!voiceEnabled}
            />
          </SettingRow>
          <SettingRow
            icon={Clock}
            label="Quiet hours"
            sublabel="Suppress non-critical spoken alerts during this window"
          >
            <Toggle
              value={cfg.voice_quiet_hours_enabled === true}
              onChange={(value) => updateCfg({ voice_quiet_hours_enabled: value })}
              disabled={!voiceEnabled}
            />
          </SettingRow>
          {cfg.voice_quiet_hours_enabled === true && (
            <div className="grid grid-cols-2 gap-3 px-1 pt-3">
              <label className="text-xs font-medium">
                Start
                <input
                  type="time"
                  value={cfg.voice_quiet_hours_start || '22:00'}
                  disabled={!voiceEnabled}
                  onChange={(event) => updateCfg({ voice_quiet_hours_start: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
                />
              </label>
              <label className="text-xs font-medium">
                End
                <input
                  type="time"
                  value={cfg.voice_quiet_hours_end || '06:00'}
                  disabled={!voiceEnabled}
                  onChange={(event) => updateCfg({ voice_quiet_hours_end: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
                />
              </label>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
