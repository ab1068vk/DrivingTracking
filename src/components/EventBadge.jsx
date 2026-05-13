import { Zap, TrendingDown, CornerUpRight, Gauge, Clock, AlertTriangle } from 'lucide-react';

const EVENT_CONFIG = {
  harsh_brake: {
    label: 'Harsh Brake',
    icon: TrendingDown,
    colors: {
      low: 'bg-orange-50 text-orange-600 border-orange-200 dark:bg-orange-950/30 dark:border-orange-800/50 dark:text-orange-400',
      medium: 'bg-orange-100 text-orange-700 border-orange-300 dark:bg-orange-950/50 dark:border-orange-800 dark:text-orange-300',
      high: 'bg-red-50 text-red-600 border-red-200 dark:bg-red-950/30 dark:border-red-800/50 dark:text-red-400',
    },
  },
  rapid_acceleration: {
    label: 'Rapid Accel',
    icon: Zap,
    colors: {
      low: 'bg-yellow-50 text-yellow-600 border-yellow-200 dark:bg-yellow-950/30 dark:border-yellow-800/50 dark:text-yellow-400',
      medium: 'bg-yellow-100 text-yellow-700 border-yellow-300 dark:bg-yellow-950/50 dark:text-yellow-300',
      high: 'bg-orange-50 text-orange-600 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400',
    },
  },
  sharp_turn: {
    label: 'Sharp Turn',
    icon: CornerUpRight,
    colors: {
      low: 'bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800/50 dark:text-blue-400',
      medium: 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-950/50 dark:text-blue-300',
      high: 'bg-purple-50 text-purple-600 border-purple-200 dark:bg-purple-950/30 dark:text-purple-400',
    },
  },
  speeding: {
    label: 'Speeding',
    icon: Gauge,
    colors: {
      low: 'bg-red-50 text-red-500 border-red-200 dark:bg-red-950/30 dark:text-red-400',
      medium: 'bg-red-100 text-red-600 border-red-300 dark:bg-red-950/50 dark:text-red-300',
      high: 'bg-red-200 text-red-700 border-red-400 dark:bg-red-900/50 dark:text-red-300',
    },
  },
  idle: {
    label: 'Idle',
    icon: Clock,
    colors: {
      low: 'bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-800/30 dark:text-slate-400',
      medium: 'bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-800/50 dark:text-slate-300',
      high: 'bg-slate-200 text-slate-700 border-slate-400 dark:bg-slate-700/50 dark:text-slate-200',
    },
  },
};

export default function EventBadge({ type, severity = 'low', count, compact = false }) {
  const config = EVENT_CONFIG[type];
  if (!config) return null;

  const Icon = config.icon;
  const colorClass = config.colors[severity] || config.colors.low;

  if (compact) {
    return (
      <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${colorClass}`}>
        <Icon className="w-3 h-3" />
        {count != null ? count : config.label}
      </div>
    );
  }

  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium ${colorClass}`}>
      <Icon className="w-3.5 h-3.5" />
      <span>{config.label}</span>
      {count != null && <span className="font-bold">×{count}</span>}
      <span className="opacity-70 capitalize">({severity})</span>
    </div>
  );
}

export { EVENT_CONFIG };