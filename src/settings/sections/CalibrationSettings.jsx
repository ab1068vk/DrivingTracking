import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Target } from 'lucide-react';
import { calibrationLabelService } from '@/api/calibrationLabels';
import { tripService } from '@/api/trips';
import CalibrationStatusTag from '@/components/CalibrationStatusTag';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SectionTitle, SettingRow, Toggle } from '@/settings/settingsComponents';
import { labelBreakdownFromMarkers, ratedTripCount } from '@/settings/calibration/labelBreakdown';
import { calibrationModelStatus } from '@/settings/calibration/modelStatus';
import { calibrationProgress } from '@/settings/calibration/progress';
import { recentUnratedTripCount } from '@/settings/calibration/recentUnratedTrips';

const breakdownRows = Object.freeze([
  ['careful', 'Careful drives rated'],
  ['normal', 'Normal drives rated'],
  ['rushed', 'Rushed/stressed drives rated'],
  ['incident', 'Drives with incidents rated'],
]);

function ProgressBar({ percent }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-secondary">
      <div
        className="h-full rounded-full bg-primary transition-[width]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function ModelStatus({ onExplain }) {
  const status = calibrationModelStatus();
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        {status.provisional ? (
          <>
            <span className="text-sm font-semibold text-amber-700 dark:text-amber-300">Scoring model: Provisional</span>
            <CalibrationStatusTag />
          </>
        ) : (
          <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300">
            {status.label}
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">Current scoring hash: {status.versionHash}</div>
      <button
        type="button"
        onClick={onExplain}
        className="mt-2 text-xs font-semibold text-primary"
      >
        What does provisional mean?
      </button>
    </div>
  );
}

function LabelBreakdown({ breakdown }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {breakdownRows.map(([key, label]) => (
        <div key={key} className="rounded-xl bg-secondary/50 p-3">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-xl font-bold">{breakdown[key].toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

function Milestone({ milestone }) {
  if (!milestone) {
    return (
      <div className="rounded-xl bg-secondary/50 p-3 text-xs text-muted-foreground">
        Fully calibrated target reached.
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-secondary/50 p-3">
      <div className="text-xs font-semibold text-muted-foreground">Next milestone</div>
      <div className="mt-1 text-sm font-semibold">{milestone.count.toLocaleString()} rated trips - {milestone.label}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{milestone.benefit}</div>
    </div>
  );
}

export function CalibrationSettings({ cfg, updateCfg, visible = true }) {
  const navigate = useNavigate();
  const [explainOpen, setExplainOpen] = useState(false);
  const sharingEnabled = cfg.calibration_sharing_enabled === true;
  const { data: trips = [] } = useQuery({
    queryKey: ['calibration-settings-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 1000 }),
    enabled: visible,
  });
  const { data: markers = {} } = useQuery({
    queryKey: ['calibration-survey-markers'],
    queryFn: () => calibrationLabelService.listTripSurveyMarkers(),
    enabled: visible,
  });
  const count = ratedTripCount(markers);
  const progress = calibrationProgress(count);
  const breakdown = labelBreakdownFromMarkers(markers);
  const unratedRecentCount = recentUnratedTripCount(trips, markers);

  if (!visible) return null;

  return (
    <>
      <SectionTitle id="settings-calibration">Coaching Calibration</SectionTitle>
      <div className="space-y-3 rounded-2xl bg-secondary/40 p-3">
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="mb-2 flex items-center justify-between gap-3 text-sm font-semibold">
            <span>{progress.count.toLocaleString()} / {progress.target.toLocaleString()} trips rated</span>
            <span className="text-xs text-muted-foreground">{Math.round(progress.percent)}%</span>
          </div>
          <ProgressBar percent={progress.percent} />
          {sharingEnabled && (
            <div className="mt-2 text-xs text-muted-foreground">
              Your ratings improve coaching accuracy for everyone
            </div>
          )}
        </div>

        <ModelStatus onExplain={() => setExplainOpen(true)} />

        <SettingRow
          icon={Target}
          label="Calibration sharing"
          sublabel="Shared data is anonymous. No GPS, names, or addresses are sent."
        >
          <Toggle
            value={sharingEnabled}
            onChange={(value) => updateCfg({ calibration_sharing_enabled: value })}
          />
        </SettingRow>

        {sharingEnabled && <LabelBreakdown breakdown={breakdown} />}

        <Milestone milestone={progress.nextMilestone} />

        {unratedRecentCount > 3 && (
          <button
            type="button"
            onClick={() => navigate('/trips?filter=unlabeled')}
            className="inline-flex w-full items-center justify-center rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
          >
            Rate recent unrated trips
          </button>
        )}
      </div>

      <Dialog open={explainOpen} onOpenChange={setExplainOpen}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>What does provisional mean?</DialogTitle>
            <DialogDescription>
              Some scoring constants have not yet been calibrated against real driving data. Scores are useful coaching estimates, but they may be adjusted when enough rated trips are collected and the calibration validator approves updated constants.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}
