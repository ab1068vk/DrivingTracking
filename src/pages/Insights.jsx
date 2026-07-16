// @ts-check
import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { BrainCircuit } from 'lucide-react';
import {
  limitedTripSummaryQueryOptions, tripDetailQueryOptions, tripSummaryQueryOptions,
} from '@/api/trips';
import useLocalSettings from '@/hooks/useLocalSettings';
import { buildAdvancedInsights } from '@/lib/advancedInsights';
import {
  buildAdvancedInsightIntelligence,
  buildComparableExperimentProgress,
  createComparableExperiment,
} from '@/lib/advancedInsightIntelligence';
import InlineRefreshBadge from '@/components/InlineRefreshBadge';
import { PageEmptyState, PageHeader } from '@/components/PageChrome';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  EventMovementPanel, PriorityFinding, ScoreMovementPanel,
} from '@/components/insights/InsightOverviewPanels';
import { ContextExplorer } from '@/components/insights/InsightExplorePanels';
import {
  DataConfidence, DriverSignaturePanel, ExperimentPanel, SupportingFindings,
} from '@/components/insights/InsightProgressPanels';
import {
  AttributionLedgerPanel, ChangeForecastPanel, MatchedComparisonPanel,
} from '@/components/insights/InsightDiagnosticPanels';
import {
  AskYourDrivesPanel, GeographicInvestigationWorkspace,
} from '@/components/insights/InsightInvestigationPanels';
import { InsightHistoryPanels } from '@/components/insights/InsightHistoryPanels';

const EXPERIMENT_STORAGE_KEY = 'roadsage_active_insight_experiment_v1';
const periodOptions = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
];

const readExperiment = () => {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(EXPERIMENT_STORAGE_KEY) || 'null');
    return value?.startedAt ? value : null;
  } catch {
    return null;
  }
};

const combineTripDetails = (results) => ({
  trips: results.map((result) => result.data).filter(Boolean),
  isFetching: results.some((result) => result.isFetching),
});

export default function Insights() {
  const navigate = useNavigate();
  const settings = useLocalSettings();
  const units = settings.units || 'metric';
  const [periodDays, setPeriodDays] = useState(30);
  const [contextType, setContextType] = useState('time');
  const [activeExperiment, setActiveExperiment] = useState(readExperiment);
  const [activeView, setActiveView] = useState('summary');

  const {
    data: recentCompleted = [],
    isLoading,
    isFetching: recentFetching,
    isSuccess: recentLoaded,
  } = useQuery({
    ...limitedTripSummaryQueryOptions(50),
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });
  const {
    data: historyCompleted = [],
    isFetching: historyFetching,
  } = useQuery({
    ...tripSummaryQueryOptions(),
    enabled: recentLoaded,
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });
  const completed = historyCompleted.length ? historyCompleted : recentCompleted;
  const baseAnalysis = useMemo(
    () => buildAdvancedInsights(completed, settings, { periodDays }),
    [completed, settings, periodDays]
  );
  const detailTripIds = useMemo(
    () => baseAnalysis.currentTrips.map((trip) => trip.id).filter(Boolean).slice(0, 12),
    [baseAnalysis.currentTrips]
  );
  const detailResults = useQueries({
    queries: detailTripIds.map((id) => tripDetailQueryOptions(id)),
    combine: combineTripDetails,
  });
  const completedWithDetails = useMemo(() => {
    if (!detailResults.trips.length) return completed;
    const byId = new Map(detailResults.trips.map((trip) => [String(trip.id), trip]));
    return completed.map((trip) => (
      byId.has(String(trip.id)) ? { ...trip, ...byId.get(String(trip.id)) } : trip
    ));
  }, [completed, detailResults.trips]);
  const analysis = useMemo(
    () => buildAdvancedInsights(completedWithDetails, settings, { periodDays }),
    [completedWithDetails, settings, periodDays]
  );
  const intelligence = useMemo(
    () => buildAdvancedInsightIntelligence(analysis, settings, { allTrips: completedWithDetails }),
    [analysis, completedWithDetails, settings]
  );
  const experimentProgress = useMemo(
    () => buildComparableExperimentProgress(activeExperiment, completedWithDetails),
    [activeExperiment, completedWithDetails]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (activeExperiment) {
      window.localStorage.setItem(EXPERIMENT_STORAGE_KEY, JSON.stringify(activeExperiment));
    } else {
      window.localStorage.removeItem(EXPERIMENT_STORAGE_KEY);
    }
  }, [activeExperiment]);

  useEffect(() => {
    if (!analysis.privacySafeSnapshot) return;
    if (analysis.contexts.some((row) => row.type === contextType)) return;
    const nextType = analysis.contexts.some((row) => row.type === 'road') ? 'road' : 'vehicle';
    setContextType(nextType);
  }, [analysis.contexts, analysis.privacySafeSnapshot, contextType]);

  useEffect(() => {
    if (!activeExperiment || activeExperiment.baseline != null || !analysis.currentTrips.length) return;
    if (analysis.experimentCandidate?.baseline == null) return;
    setActiveExperiment(createComparableExperiment(
      analysis.experimentCandidate,
      analysis.currentTrips
    ));
  }, [activeExperiment, analysis.currentTrips, analysis.experimentCandidate]);

  const startExperiment = () => {
    setActiveExperiment(createComparableExperiment(analysis.experimentCandidate, analysis.currentTrips));
  };
  const openTrip = (id) => navigate(`/trips/${id}`);
  const scrollToEvidence = () => {
    setActiveView('explore');
    window.setTimeout(() => document.getElementById('event-investigation')?.scrollIntoView({
      behavior: 'smooth', block: 'start',
    }), 0);
  };

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Driving Intelligence"
        description="What changed, why it changed, and what to try next"
        icon={BrainCircuit}
        status={(
          <InlineRefreshBadge
            visible={(recentFetching || historyFetching || detailResults.isFetching) && !isLoading}
            label="Refreshing analysis"
          />
        )}
        actions={(
          <div className="flex rounded-full border border-border bg-card p-1 shadow-sm" role="group" aria-label="Analysis period">
            {periodOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setPeriodDays(option.value)}
                aria-pressed={periodDays === option.value}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                  periodDays === option.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      />

      {isLoading ? (
        <div className="space-y-3">
          <div className="h-64 animate-pulse rounded-3xl bg-secondary/50" />
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="h-80 animate-pulse rounded-3xl bg-secondary/50" />
            <div className="h-80 animate-pulse rounded-3xl bg-secondary/50" />
          </div>
        </div>
      ) : completed.length === 0 ? (
        <PageEmptyState
          icon={BrainCircuit}
          title="Your personal baseline starts with a few trips"
          description="Road Sage needs completed drives before it can explain changes, compare contexts, or validate a coaching experiment."
        >
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            Return to dashboard
          </button>
        </PageEmptyState>
      ) : (
        <>
          <InsightsTabs
            activeView={activeView}
            setActiveView={setActiveView}
            analysis={analysis}
            intelligence={intelligence}
            units={units}
            activeExperiment={activeExperiment}
            experimentProgress={experimentProgress}
            startExperiment={startExperiment}
            cancelExperiment={() => setActiveExperiment(null)}
            scrollToEvidence={scrollToEvidence}
            openTrip={openTrip}
            openMap={() => navigate('/map')}
            contextType={contextType}
            setContextType={setContextType}
            completedTrips={completedWithDetails}
            settings={settings}
          />


        </>
      )}
    </div>
  );
}

function InsightsTabs(props) {
  const { activeView, setActiveView, completedTrips, settings, units, openTrip } = props;
  return <Tabs value={activeView} onValueChange={setActiveView} className='space-y-5'>
    <div className='overflow-x-auto pb-1'>
      <TabsList className='min-w-max rounded-full border border-border bg-card p-1'>
        <TabsTrigger value='summary' className='rounded-full px-4'>Summary</TabsTrigger>
        <TabsTrigger value='explore' className='rounded-full px-4'>Explore evidence</TabsTrigger>
        <TabsTrigger value='history' className='rounded-full px-4'>History &amp; tools</TabsTrigger>
      </TabsList>
    </div>
    <TabsContent value='summary' className='mt-0 space-y-5'>
      <InsightSummaryView {...props} />
    </TabsContent>
    <TabsContent value='explore' className='mt-0 space-y-5'>
      <InsightExploreView {...props} />
    </TabsContent>
    <TabsContent value='history' className='mt-0'>
      <InsightHistoryPanels trips={completedTrips} settings={settings} units={units} onOpenTrip={openTrip} />
    </TabsContent>
  </Tabs>;
}

function InsightSummaryView({
  analysis, units, activeExperiment, experimentProgress,
  startExperiment, cancelExperiment, scrollToEvidence, openTrip,
}) {
  return <>
    <PriorityFinding
      analysis={analysis}
      units={units}
      hasExperiment={Boolean(activeExperiment)}
      onInspect={scrollToEvidence}
      onStartExperiment={startExperiment}
      onOpenTrip={openTrip}
    />
    {analysis.periodEmpty && <div className='rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200'>No eligible drives were recorded in the selected {analysis.periodDays}-day window. Choose a longer range or open History to review older trips.</div>}
    <section className='grid gap-5 xl:grid-cols-[1.12fr_0.88fr]'>
      <ScoreMovementPanel analysis={analysis} />
      <EventMovementPanel analysis={analysis} onOpenTrip={openTrip} units={units} />
    </section>
    <section className={`grid gap-5 ${analysis.signature ? 'xl:grid-cols-[1.08fr_0.92fr]' : ''}`}>
      <ExperimentPanel candidate={analysis.experimentCandidate} experiment={activeExperiment} progress={experimentProgress} onStart={startExperiment} onCancel={cancelExperiment} onOpenTrip={openTrip} />
      {analysis.signature && <DriverSignaturePanel signature={analysis.signature} />}
    </section>
    <section className={`grid gap-5 ${analysis.supportingFindings.length ? 'xl:grid-cols-[1fr_0.9fr]' : ''}`}>
      {analysis.supportingFindings.length > 0 && <SupportingFindings findings={analysis.supportingFindings} onOpenTrip={openTrip} />}
      <DataConfidence quality={analysis.dataQuality} />
    </section>
  </>;
}

function InsightExploreView({
  analysis, intelligence, units, openTrip, openMap, contextType, setContextType,
}) {
  return <>
    <section className={`grid gap-5 ${analysis.privacySafeSnapshot ? '' : 'xl:grid-cols-2'}`}>
      {!analysis.privacySafeSnapshot && <MatchedComparisonPanel matched={intelligence.matched} onOpenTrip={openTrip} units={units} />}
      <AttributionLedgerPanel attribution={intelligence.attribution} onOpenTrip={openTrip} />
    </section>
    <GeographicInvestigationWorkspace intelligence={intelligence} hotspots={analysis.hotspots} trips={analysis.currentTrips} onOpenTrip={openTrip} onOpenFullMap={openMap} units={units} />
    <ContextExplorer analysis={analysis} type={contextType} onTypeChange={setContextType} units={units} onOpenTrip={openTrip} />
    {(!analysis.privacySafeSnapshot || intelligence.changePoint || intelligence.forecast.readinessScore != null) && <ChangeForecastPanel changePoint={intelligence.changePoint} forecast={intelligence.forecast} onOpenTrip={openTrip} />}
    <AskYourDrivesPanel analysis={analysis} intelligence={intelligence} onOpenTrip={openTrip} />
  </>;
}
