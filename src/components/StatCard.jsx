// @ts-check
import { TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function StatCard({ icon: Icon, label, value, sub = '', gradient, index: _index = 0, onClick = null, className = '' }) {
  const IconComponent = Icon || TrendingUp;
  return (
    <div
      onClick={onClick}
      className={cn(
        'relative overflow-hidden rounded-2xl p-4 text-white shadow-lg',
        gradient,
        onClick ? 'cursor-pointer transition-opacity hover:opacity-95' : '',
        className,
      )}
    >
      {/* Background decoration */}
      <div className="stat-orb stat-orb-top absolute -top-4 -right-4 w-20 h-20 bg-white/10 rounded-full" />
      <div className="stat-orb stat-orb-bottom absolute -bottom-6 -left-6 w-24 h-24 bg-white/5 rounded-full" />
      <IconComponent className="pointer-events-none absolute right-4 top-4 h-16 w-16 opacity-0" />

      <div className="relative">
        <div className="flex items-start justify-between mb-3">
          <div className="p-2 bg-white/20 rounded-xl">
            <IconComponent className="w-5 h-5" />
          </div>
        </div>
        <div className="font-grotesk font-bold text-2xl leading-none mb-1">{value}</div>
        <div className="text-white/80 text-sm font-medium">{label}</div>
        {sub && <div className="text-white/60 text-xs mt-1">{sub}</div>}
      </div>
    </div>
  );
}
