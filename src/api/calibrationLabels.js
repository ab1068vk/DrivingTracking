import { API_BASE_URL, apiClient } from '@/api/client';
import {
  CALIBRATION_LABEL_COLLECTION,
  buildCalibrationUploadPayload,
  buildLocalSurveyRecord,
} from '@/lib/calibrationLabeling';
import { localCalibrationLabelRepository } from '@/lib/localCalibrationLabelRepository';
import { isNativePlatform } from '@/lib/nativePlatform';
import { localSettings } from '@/lib/trackingStore';

const shouldUseRemoteLabelStore = () => Boolean(API_BASE_URL) && !isNativePlatform();

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
        const saved = await apiClient.post(`/${CALIBRATION_LABEL_COLLECTION}`, payload);
        await localCalibrationLabelRepository.markTripSubmitted(tripId, {
          label_id: saved?.labelId || saved?.id || payload.labelId,
          rating: payload.surveyLabel.overallDriveRating,
          wasDriver: payload.surveyLabel.wasDriver,
          submitted_at: payload.createdAt,
          eligible_for_calibration: payload.eligibleForCalibration,
          upload_status: 'uploaded',
        });
        return saved || payload;
      } catch (error) {
        return localCalibrationLabelRepository.create({
          ...localRecord,
          upload_error: error?.message || 'Upload failed',
        }, {
          tripId,
          uploadStatus: 'pending_upload',
        });
      }
    }

    return localCalibrationLabelRepository.create(localRecord, {
      tripId,
      uploadStatus: sharingEnabled && !payload.eligibleForCalibration ? 'excluded_quality' : 'local_only',
    });
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
};
