// @ts-check
import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { Award, CheckCircle2, Lock, Target, Trophy } from 'lucide-react';
import { limitedTripSummaryQueryOptions, tripSummaryQueryOptions } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import useLocalSettings from '@/hooks/useLocalSettings';
import {
  achievementNextStepLabel,
  achievementProgressLabel,
  achievementProgressValue,
  calculateAchievementBadges,
  summarizeAchievementBadges,
} from '@/lib/tripInsights';
import { syncAchievementNotifications } from '@/lib/notificationService';
import InlineRefreshBadge from '@/components/InlineRefreshBadge';
import { PageEmptyState, PageHeader } from '@/components/PageChrome';

const filterLabel = (filter) => {
  if (filter === 'all') return 'All';
  if (filter === 'unlocked') return 'Unlocked';
  if (filter === 'locked') return 'In progress';
  return filter;
};

function MilestoneCard({ badge, index, featured = false }) {
  const progress = achievementProgressValue(badge);
  const nextStep = achievementNextStepLabel(badge);

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.025, 0.2) }}
      className={`rounded-2xl border p-4 ${
        badge.earned
          ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-800/50 dark:bg-emerald-950/20'
          : featured
            ? 'border-primary/40 bg-primary/5'
            : 'border-border bg-card'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${
          badge.earned ? 'bg-emerald-500 text-white' : featured ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
        }`}>
          {badge.earned ? <Award className="h-5 w-5" /> : featured ? <Target className="h-5 w-5" /> : <Lock className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">{badge.label}</h2>
              {badge.category && (
                <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-primary">
                  {badge.category}
                </div>
              )}
            </div>
            <span className={`whitespace-nowrap text-xs font-semibold ${
              badge.earned ? 'text-emerald-600 dark:text-emerald-300' : 'text-muted-foreground'
            }`}>
              {achievementProgressLabel(badge)}
            </span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{badge.description}</p>
          {nextStep && (
            <div className="mt-3 rounded-lg bg-secondary/60 px-2 py-1 text-[11px] font-semibold text-muted-foreground">
              Next: {nextStep}
            </div>
          )}
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className={`h-full rounded-full ${badge.earned ? 'bg-emerald-500' : 'bg-primary'}`}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export default function Achievements() {
  const [activeFilter, setActiveFilter] = useState('all');
  const settings = useLocalSettings();
  const {
    data: recentCompleted = [],
    isLoading,
    isFetching: recentFetching,
    isSuccess: recentTripsLoaded,
  } = useQuery({
    ...limitedTripSummaryQueryOptions(50),
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });
  const {
    data: fullHistoryCompleted = [],
    isFetching: fullHistoryFetching,
  } = useQuery({
    ...tripSummaryQueryOptions(),
    enabled: recentTripsLoaded,
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });
  const completed = fullHistoryCompleted.length > 0 ? fullHistoryCompleted : recentCompleted;
  const isFetching = recentFetching || fullHistoryFetching;
  const { data: vehicles = [] } = useQuery({
    queryKey: ['achievement-vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 100 }),
  });

  const badges = useMemo(
    () => calculateAchievementBadges(completed, settings, vehicles),
    [completed, settings, vehicles]
  );
  const summary = useMemo(() => summarizeAchievementBadges(badges), [badges]);
  const categories = useMemo(
    () => [...new Set(badges.map((badge) => badge.category).filter(Boolean))],
    [badges]
  );
  const filters = useMemo(
    () => ['all', 'unlocked', 'locked', ...categories],
    [categories]
  );
  const visibleBadges = useMemo(() => {
    const filtered = badges.filter((badge) => {
      if (activeFilter === 'unlocked') return badge.earned;
      if (activeFilter === 'locked') return !badge.earned;
      if (activeFilter === 'all') return true;
      return badge.category === activeFilter;
    });
    return [...filtered].sort((a, b) => {
      if (a.id === summary.next?.id) return -1;
      if (b.id === summary.next?.id) return 1;
      if (a.earned !== b.earned) return a.earned ? 1 : -1;
      return achievementProgressValue(b) - achievementProgressValue(a);
    });
  }, [activeFilter, badges, summary.next?.id]);

  useEffect(() => {
    syncAchievementNotifications(badges, { requestPermission: false }).catch(() => {});
  }, [badges]);

  return (
    <div className="space-y-6 pb-4">
      <PageHeader
        title="Milestones"
        description="Useful progress markers from your completed trip history"
        icon={Trophy}
        backTo="/"
        backLabel="Back to dashboard"
        status={<InlineRefreshBadge visible={isFetching && !isLoading} label="Refreshing milestones" />}
      />

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-border bg-card p-4">
          <Award className="mb-2 h-5 w-5 text-primary" />
          <div className="font-grotesk text-2xl font-bold">{summary.unlockedCount}/{summary.totalCount}</div>
          <div className="text-xs text-muted-foreground">unlocked milestones</div>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <CheckCircle2 className="mb-2 h-5 w-5 text-emerald-500" />
          <div className="font-grotesk text-2xl font-bold">{completed.length}</div>
          <div className="text-xs text-muted-foreground">completed trips counted</div>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <Target className="mb-2 h-5 w-5 text-primary" />
          <div className="font-grotesk text-2xl font-bold">{summary.completionPercent}%</div>
          <div className="text-xs text-muted-foreground">overall milestone completion</div>
        </div>
      </div>

      {!isLoading && summary.next && (
        <div className="rounded-3xl border border-primary/30 bg-primary/5 p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-primary">Next best target</div>
              <h2 className="mt-1 font-semibold">{summary.next.label}</h2>
            </div>
            <span className="rounded-full bg-background/70 px-3 py-1 text-xs font-semibold text-primary">
              {achievementProgressLabel(summary.next)}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{summary.next.description}</p>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${achievementProgressValue(summary.next)}%` }}
            />
          </div>
          <div className="mt-2 text-xs font-semibold text-muted-foreground">
            {achievementNextStepLabel(summary.next)}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          {[1, 2, 3, 4].map((item) => (
            <div key={item} className="h-28 rounded-2xl bg-secondary/60 animate-pulse" />
          ))}
        </div>
      ) : completed.length === 0 ? (
        <PageEmptyState
          icon={Trophy}
          title="No milestones yet"
          description="Finish your first tracked trip and Road Sage will start showing progress on the dashboard."
        />
      ) : (
        <>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {filters.map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setActiveFilter(filter)}
                className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  activeFilter === filter
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-secondary'
                }`}
              >
                {filterLabel(filter)}
              </button>
            ))}
          </div>
          {visibleBadges.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
              No milestones match this filter.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {visibleBadges.map((badge, index) => (
                <MilestoneCard
                  key={badge.id}
                  badge={badge}
                  index={index}
                  featured={badge.id === summary.next?.id}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
