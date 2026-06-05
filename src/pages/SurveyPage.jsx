import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { calibrationLabelService } from '@/api/calibrationLabels';
import { tripService } from '@/api/trips';
import PostTripCalibrationSurvey from '@/components/PostTripCalibrationSurvey';
import { localSettings } from '@/lib/trackingStore';
import { notifyUserError, notifyUserSuccess } from '@/lib/userFeedback';

export default function SurveyPage() {
  const { tripId } = useParams();
  const navigate = useNavigate();
  const settings = localSettings.get();
  const [surveyStatus, setSurveyStatus] = useState(null);
  const [labelCount, setLabelCount] = useState(null);

  const { data: trip, isLoading, error } = useQuery({
    queryKey: ['trip', tripId],
    queryFn: () => tripService.getById(tripId),
    enabled: Boolean(tripId),
    meta: {
      errorTitle: 'Survey trip unavailable',
      errorDescription: 'Road Sage could not load the trip for this survey.',
    },
  });

  useEffect(() => {
    let cancelled = false;
    if (!tripId) return undefined;
    Promise.all([
      calibrationLabelService.getTripSurveyStatus(tripId),
      calibrationLabelService.countLocalLabels(),
    ]).then(([marker, count]) => {
      if (cancelled) return;
      setSurveyStatus(marker);
      setLabelCount(count);
    }).catch((error) => {
      if (cancelled) return;
      notifyUserError('survey_status_load', error, {
        title: 'Survey status unavailable',
        description: 'You can still answer the survey, but Road Sage could not load previous rating status.',
      });
    });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  const submitMutation = useMutation({
    mutationFn: (surveyInput) => calibrationLabelService.submitTripSurveyLabel(trip, surveyInput),
    onSuccess: () => {
      notifyUserSuccess('survey_submit', {
        title: 'Trip rating saved',
        description: 'This rating will help calibration improve over time.',
      });
      navigate('/trips');
    },
    meta: {
      name: 'survey_submit',
      errorTitle: 'Survey not saved',
      errorDescription: 'Road Sage could not save this rating. Try again so the calibration label is not lost.',
    },
  });

  const skipMutation = useMutation({
    mutationFn: () => calibrationLabelService.skipTripSurvey(tripId),
    onSuccess: () => {
      notifyUserSuccess('survey_skip', {
        title: 'Rating skipped',
        description: 'Road Sage will not ask for a rating on this trip again.',
      });
      navigate('/trips');
    },
    meta: {
      name: 'survey_skip',
      errorTitle: 'Survey skip not saved',
      errorDescription: 'Road Sage could not mark this survey as skipped.',
    },
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-xl py-8">
        <div className="h-64 rounded-3xl bg-secondary/50 animate-pulse" />
      </div>
    );
  }

  if (error || !trip) {
    return (
      <div className="mx-auto max-w-xl py-8">
        <div className="rounded-3xl border border-border bg-card p-5">
          <h1 className="font-semibold">Survey unavailable</h1>
          <p className="mt-1 text-sm text-muted-foreground">This trip could not be loaded.</p>
          <button
            type="button"
            onClick={() => navigate('/trips')}
            className="mt-4 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
          >
            Back to trips
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-8">
      <PostTripCalibrationSurvey
        trip={trip}
        status={surveyStatus}
        labelCount={labelCount}
        sharingEnabled={settings.calibration_sharing_enabled === true}
        isPending={submitMutation.isPending}
        isSkipping={skipMutation.isPending}
        error={submitMutation.error || skipMutation.error}
        onSubmit={(surveyInput) => submitMutation.mutate(surveyInput)}
        onSkip={() => skipMutation.mutate()}
        variant="quick"
      />
    </div>
  );
}
