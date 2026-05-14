import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { Award, CheckCircle2, Lock, Trophy } from 'lucide-react';
import { tripService } from '@/api/trips';
import { calculateAchievementBadges } from '@/lib/tripInsights';
import { syncAchievementNotifications } from '@/lib/notificationService';

const progressLabel = (badge) => {
  if (badge.earned) return 'Unlocked';
  if (badge.target) {
    const unit = badge.unit ? ` ${badge.unit}` : '';
    return `${badge.current || 0}/${badge.target}${unit}`;
  }
  if (badge.progress !== undefined) return `${badge.progress}%`;
  return 'In progress';
};

const progressValue = (badge) => {
  if (badge.earned) return 100;
  if (badge.target) return Math.min(100, ((badge.current || 0) / badge.target) * 100);
  if (badge.progress !== undefined) return Math.min(100, badge.progress);
  return 0;
};

export default function Achievements() {
  const { data: allTrips = [], isLoading } = useQuery({
    queryKey: ['achievement-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 1000 }),
  });

  const completed = allTrips.filter((trip) => trip.status === 'completed');
  const badges = calculateAchievementBadges(completed);
  const earned = badges.filter((badge) => badge.earned);

  useEffect(() => {
    syncAchievementNotifications(badges, { requestPermission: false }).catch(() => {});
  }, [badges]);

  return (
    <div className="space-y-6 pb-4">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-grotesk font-bold">Achievements</h1>
          <p className="text-muted-foreground text-sm mt-1">Driving milestones earned from real trip data</p>
        </div>
        <div className="w-11 h-11 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Trophy className="w-5 h-5 text-primary" />
        </div>
      </motion.div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-card border border-border rounded-2xl p-4">
          <Award className="w-5 h-5 text-primary mb-2" />
          <div className="font-grotesk font-bold text-2xl">{earned.length}/{badges.length}</div>
          <div className="text-xs text-muted-foreground">unlocked</div>
        </div>
        <div className="bg-card border border-border rounded-2xl p-4">
          <CheckCircle2 className="w-5 h-5 text-emerald-500 mb-2" />
          <div className="font-grotesk font-bold text-2xl">{completed.length}</div>
          <div className="text-xs text-muted-foreground">completed trips counted</div>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-28 rounded-2xl bg-secondary/60 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          {badges.map((badge, index) => {
            const progress = progressValue(badge);
            return (
              <motion.div
                key={badge.id}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.04 }}
                className={`border rounded-2xl p-4 ${
                  badge.earned
                    ? 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/50'
                    : 'bg-card border-border'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                    badge.earned ? 'bg-emerald-500 text-white' : 'bg-secondary text-muted-foreground'
                  }`}>
                    {badge.earned ? <Award className="w-5 h-5" /> : <Lock className="w-5 h-5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="font-semibold text-sm">{badge.label}</h2>
                      <span className={`text-xs font-semibold ${badge.earned ? 'text-emerald-600 dark:text-emerald-300' : 'text-muted-foreground'}`}>
                        {progressLabel(badge)}
                      </span>
                    </div>
                    {badge.category && (
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-primary mt-1">
                        {badge.category}
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">{badge.description}</p>
                    <div className="h-2 rounded-full bg-secondary overflow-hidden mt-3">
                      <div
                        className={`h-full rounded-full ${badge.earned ? 'bg-emerald-500' : 'bg-primary'}`}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
