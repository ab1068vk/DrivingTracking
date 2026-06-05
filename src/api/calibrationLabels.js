import { API_ENDPOINT_CONFIGURED, apiClient } from '@/api/client';
import {
  CALIBRATION_LABEL_COLLECTION,
  buildCalibrationUploadPayload,
  buildLocalSurveyRecord,
  readinessSurveySyntheticScore,
  shouldAskReadinessSurvey,
} from '@/lib/calibrationLabeling';
import { pairOutcome } from '@/lib/calibration/readinessSignalCorrelation';
import { computeAndStoreReadinessThresholdFit } from '@/lib/calibration/readinessThresholdFit';
import { localCalibrationLabelRepository } from '@/lib/localCalibrationLabelRepository';
import { localTripRepository } from '@/lib/localTripRepository';
import { isNativePlatform } from '@/lib/nativePlatform';
import { assertServerVerifiedPlayIntegrity, requestPlayIntegrityAttestation } from '@/lib/nativePlayIntegrity';
import { localSettings } from '@/lib/trackingStore';

const shouldUseRemoteLabelStore = () => API_ENDPOINT_CONFIGURED;

const readinessRecordIdForTrip = (trip = {}) => (
  trip.readiness_signal_record_id ??
  trip.pre_trip_readiness_context?.recordId ??
  trip.pre_trip_readiness_context?.signalHistoryRecordId ??
  null
);

async function applyReadinessSurveyResponse(trip, responseValue) {
  if (!responseValue || !shouldAskReadinessSurvey(trip, trip?.pre_trip_readiness_context)) return null;
  const syntheticScore = readinessSurveySyntheticScore(responseValue, trip.pre_trip_readiness_context, trip);
  const recordId = readinessRecordIdForTrip(trip);
  if (!recordId || syntheticScore == null) return null;

  await pairOutcome(recordId, syntheticScore);
  const thresholdFit = await computeAndStoreReadinessThresholdFit();
  const answeredAt = new Date().toISOString();
  const patch = {
    readiness_survey_answered: true,
    readiness_survey_answered_at: answeredAt,
    readiness_survey_response: responseValue,
    readiness_survey_synthetic_score: syntheticScore,
    ...(thresholdFit ? {
      readiness_threshold_fit: {
        storageKey: thresholdFit.storageKey,
        highRiskFloor: thresholdFit.highRiskFloor,
        moderateRiskFloor: thresholdFit.moderateRiskFloor,
        f1: thresholdFit.f1,
        n: thresholdFit.n,
        fittedAt: thresholdFit.fittedAt,
      },
    } : {}),
  };

  try {
    await localTripRepository.update(trip.id, patch);
  } catch {
    if (shouldUseRemoteLabelStore()) {
      await apiClient.patch(`/trips/${encodeURIComponent(trip.id)}`, patch).catch(() => null);
    }
  }

  return patch;
}

export const calibrationLabelService = {
  async submitTripSurveyLabel(trip, surveyInput) {
    const payload = await buildCalibrationUploadPayload(trip, surveyInput);
    const localRecord = buildLocalSurveyRecord(payload, {
      freeTextNote: surveyInput?.freeTextNote,
      includeFreeTextInUpload: false,
    });
    const tripId = trip?.id ?? null;
    const sharingEnabled = localSettings.get().calibration_sharing_enabled === true;

    if (sharingEnabled && payload.eligibleForCalibration && shouldUseRemoteLabelStore()) {
      try {
        const attestation = isNativePlatform()
          ? await requestPlayIntegrityAttestation('calibration-upload')
          : null;
        if (isNativePlatform() && !attestation?.token) {
          throw new Error('Play Integrity attestation is required before calibration upload.');
        }
        const saved = await apiClient.post(`/${CALIBRATION_LABEL_COLLECTION}`, {
          ...payload,
          ...(attestation ? { playIntegrity: attestation } : {}),
        });
        assertServerVerifiedPlayIntegrity(saved, 'calibration-upload');
        await localCalibrationLabelRepository.markTripSubmitted(tripId, {
          label_id: saved?.labelId || saved?.id || payload.labelId,
          rating: payload.surveyLabel.overallDriveRating,
          wasDriver: payload.surveyLabel.wasDriver,
          submitted_at: payload.createdAt,
          eligible_for_calibration: payload.eligibleForCalibration,
          upload_status: 'uploaded',
        });
        await applyReadinessSurveyResponse(trip, surveyInput?.readiness_accuracy ?? surveyInput?.readinessAccuracy);
        return saved || payload;
      } catch (error) {
        const fallback = await localCalibrationLabelRepository.create({
          ...localRecord,
          upload_error: error?.message || 'Upload failed',
        }, {
          tripId,
          uploadStatus: 'pending_upload',
        });
        await applyReadinessSurveyResponse(trip, surveyInput?.readiness_accuracy ?? surveyInput?.readinessAccuracy);
        return fallback;
      }
    }

    const record = await localCalibrationLabelRepository.create(localRecord, {
      tripId,
      uploadStatus: sharingEnabled && !payload.eligibleForCalibration ? 'excluded_quality' : 'local_only',
    });
    await applyReadinessSurveyResponse(trip, surveyInput?.readiness_accuracy ?? surveyInput?.readinessAccuracy);
    return record;
  },

  skipTripSurvey(tripId) {
    return localCalibrationLabelRepository.markTripSkipped(tripId);
  },

  getTripSurveyStatus(tripId) {
    return localCalibrationLabelRepository.getTripSurveyStatus(tripId);
  },

  countLocalLabels() {
    return localCalibrationLabelRepository.count();
  },

  listLocalLabels() {
    return localCalibrationLabelRepository.list();
  },

  listTripSurveyMarkers() {
    return localCalibrationLabelRepository.listSurveyMarkers();
  },
};
