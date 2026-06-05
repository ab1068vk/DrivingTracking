import {
  BarChart3,
  Bell,
  Car,
  Lock,
  MapPin,
  Shield,
  SlidersHorizontal,
} from 'lucide-react';

export const SECTION_GROUPS = [
  {
    id: 'tracking',
    label: 'Tracking',
    description: 'Tracking mode and Android setup',
    icon: MapPin,
    ids: ['settings-tracking', 'settings-android-permissions', 'settings-feature-permissions'],
  },
  {
    id: 'scoring',
    label: 'Scoring',
    description: 'Thresholds, models, phone use, speed, night window',
    icon: BarChart3,
    ids: [
      'settings-detection-thresholds',
      'settings-calibration',
      'settings-advanced-models',
      'settings-phone-use',
      'settings-speed-warning',
      'settings-night-window',
    ],
  },
  {
    id: 'privacy',
    label: 'Privacy & Data',
    description: 'Export, import, retention',
    icon: Shield,
    ids: ['settings-privacy-data'],
  },
  {
    id: 'privacy-zones',
    label: 'Privacy zones',
    description: 'Parked-location privacy for maps',
    icon: Lock,
    ids: ['settings-privacy-zones'],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Notification channels, voice alerts, and driving goals',
    icon: Bell,
    ids: ['settings-notifications', 'settings-voice-alerts', 'settings-driving-goals'],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme, units, and economics',
    icon: Car,
    ids: ['settings-appearance', 'settings-economics'],
  },
  {
    id: 'ubi',
    label: 'UBI Coaching',
    description: 'Coaching estimates, not an insurance rating',
    icon: SlidersHorizontal,
    ids: ['settings-ubi'],
  },
];

export function SettingsNav({ activeGroupId, onChange }) {
  return (
    <nav className="grid grid-cols-2 gap-2 border-b border-border pb-3 min-[440px]:grid-cols-3 md:flex md:w-52 md:shrink-0 md:flex-col md:border-b-0 md:border-r md:pb-0 md:pr-3">
      {SECTION_GROUPS.map((group) => {
        const Icon = group.icon;
        const active = activeGroupId === group.id;
        return (
          <button
            key={group.id}
            type="button"
            onClick={() => onChange(group.id)}
            className={`flex min-w-0 items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
              active
                ? 'bg-primary/10 font-semibold text-primary'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="min-w-0">
              <span className="block truncate">{group.label}</span>
              <span className="mt-0.5 hidden text-[11px] font-normal leading-tight text-muted-foreground md:block">
                {group.description}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
