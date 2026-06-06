import { API_BASE_URL, apiClient } from '@/api/client';
import {
  CALIBRATION_LABEL_COLLECTION,
  buildCalibrationUploadPayload,
  buildLocalSurveyRecord,
} from '@/lib/calibrationLabeling';
import { localCalibrationLabelRepository } from '@/lib/localCalibrationLabelRepository';
import { isNativePlatform } from '@/lib/nativePlatform';
import { localSettings } from '@/lib/trackingStore';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

export const canUploadCalibrationLabels = () => Boolean(API_BASE_URL) && !isNativePlatform();

const uploadPayloadFromRecord = (record = {}) => {
  const {
    id: _id,
    stored_at: _storedAt,
    updated_at: _updatedAt,
    upload_status: _uploadStatus,
    upload_error: _uploadError,
    local_only_note: _localOnlyNote,
    include_free_text_in_upload: _includeFreeTextInUpload,
    trip_id: _tripId,
    ...payload
  } = record;
  return payload;
};

export const calibrationLabelService = {
  async submitTripSurveyLabel(trip, surveyInput, { replaceExisting = false } = {}) {
    const tripId = trip?.id ?? null;
    recordSystemEvent('calibration_survey_submit_started', {
      trip_id_present: tripId != null,
      replace_existing: replaceExisting === true,
      sharing_enabled: localSettings.get().calibration_sharing_enabled === true,
      upload_available: canUploadCalibrationLabels(),
    }, { category: 'calibration', title: 'Survey feedback save started' });

    if (replaceExisting && trip?.id != null) {
      try {
        await localCalibrationLabelRepository.deleteTripLabel(trip.id);
      } catch (error) {
        logSystemFailure('calibration_survey_replace_clear_failed', error, {
          trip_id_present: true,
        });
        throw error;
      }
    }
    let payload;
    try {
      payload = await buildCalibrationUploadPayload(trip, surveyInput);
    } catch (error) {
      logSystemFailure('calibration_survey_payload_build_failed', error, {
        trip_id_present: tripId != null,
      });
      throw error;
    }
    const localRecord = buildLocalSurveyRecord(payload, {
      freeTextNote: surveyInput?.freeTextNote,
      includeFreeTextInUpload: false,
    });
    const sharingEnabled = localSettings.get().calibration_sharing_enabled === true;

    if (sharingEnabled && payload.eligibleForCalibration && canUploadCalibrationLabels()) {
      try {
        const saved = await apiClient.post(`/${CALIBRATION_LABEL_COLLECTION}`, payload);
        const record = await localCalibrationLabelRepository.create({
          ...localRecord,
          remote_label_id: saved?.labelId || saved?.id || payload.labelId,
          uploaded_at: new Date().toISOString(),
        }, {
          tripId,
          uploadStatus: 'uploaded',
        });
        recordSystemEvent('calibration_survey_uploaded', {
          label_id_present: Boolean(record?.id),
          rating: payload.surveyLabel?.overallDriveRating ?? null,
          eligible_for_calibration: payload.eligibleForCalibration,
          replace_existing: replaceExisting === true,
        }, { category: 'calibration', title: 'Survey feedback uploaded' });
        return record;
      } catch (error) {
        logSystemFailure('calibration_survey_upload_failed', error, {
          eligible_for_calibration: payload.eligibleForCalibration,
          upload_status: 'pending_upload',
        });
        const record = await localCalibrationLabelRepository.create({
          ...localRecord,
          upload_error: error?.message || 'Upload failed',
        }, {
          tripId,
          uploadStatus: 'pending_upload',
        });
        recordSystemEvent('calibration_survey_saved_pending_upload', {
          label_id_present: Boolean(record?.id),
          rating: payload.surveyLabel?.overallDriveRating ?? null,
        }, { category: 'calibration', severity: 'warn', title: 'Survey feedback saved for retry' });
        return record;
      }
    }

    const record = await localCalibrationLabelRepository.create(localRecord, {
      tripId,
      uploadStatus: sharingEnabled && !payload.eligibleForCalibration ? 'excluded_quality' : 'local_only',
    });
    recordSystemEvent('calibration_survey_saved_local', {
      label_id_present: Boolean(record?.id),
      rating: payload.surveyLabel?.overallDriveRating ?? null,
      eligible_for_calibration: payload.eligibleForCalibration,
      upload_status: record?.upload_status || 'local_only',
      replace_existing: replaceExisting === true,
    }, { category: 'calibration', title: 'Survey feedback saved locally' });
    return record;
  },

  async skipTripSurvey(tripId) {
    try {
      const marker = await localCalibrationLabelRepository.markTripSkipped(tripId);
      recordSystemEvent('calibration_survey_skipped', {
        trip_id_present: tripId != null,
      }, { category: 'calibration', title: 'Survey skipped' });
      return marker;
    } catch (error) {
      logSystemFailure('calibration_survey_skip_failed', error, {
        trip_id_present: tripId != null,
      });
      throw error;
    }
  },

  async clearTripSurvey(tripId) {
    try {
      const deleted = await localCalibrationLabelRepository.deleteTripLabel(tripId);
      recordSystemEvent('calibration_trip_survey_cleared', {
        trip_id_present: tripId != null,
        deleted_label_count: deleted,
      }, { category: 'calibration', title: 'Trip survey cleared' });
      return deleted;
    } catch (error) {
      logSystemFailure('calibration_trip_survey_clear_failed', error, {
        trip_id_present: tripId != null,
      });
      throw error;
    }
  },

  async deleteLocalLabel(labelId) {
    try {
      const deleted = await localCalibrationLabelRepository.delete(labelId);
      recordSystemEvent('calibration_label_deleted', {
        label_id_present: Boolean(labelId),
        deleted,
      }, { category: 'calibration', title: 'Survey label deleted' });
      return deleted;
    } catch (error) {
      logSystemFailure('calibration_label_delete_failed', error, {
        label_id_present: Boolean(labelId),
      });
      throw error;
    }
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

  async replaceLocalLabels(labels) {
    try {
      const next = await localCalibrationLabelRepository.replaceAll(labels);
      recordSystemEvent('calibration_labels_replaced', {
        label_count: Array.isArray(next) ? next.length : 0,
      }, { category: 'calibration', title: 'Survey labels replaced' });
      return next;
    } catch (error) {
      logSystemFailure('calibration_labels_replace_failed', error, {
        input_count: Array.isArray(labels) ? labels.length : 0,
      });
      throw error;
    }
  },

  listTripSurveyMarkers() {
    return localCalibrationLabelRepository.listTripSurveyMarkers();
  },

  async replaceTripSurveyMarkers(markers) {
    try {
      const next = await localCalibrationLabelRepository.replaceTripSurveyMarkers(markers);
      recordSystemEvent('calibration_survey_markers_replaced', {
        marker_count: next && typeof next === 'object' ? Object.keys(next).length : 0,
      }, { category: 'calibration', title: 'Survey markers replaced' });
      return next;
    } catch (error) {
      logSystemFailure('calibration_survey_markers_replace_failed', error, {
        input_count: markers && typeof markers === 'object' ? Object.keys(markers).length : 0,
      });
      throw error;
    }
  },

  async retryPendingUploads() {
    const sharingEnabled = localSettings.get().calibration_sharing_enabled === true;
    if (!sharingEnabled || !canUploadCalibrationLabels()) {
      recordSystemEvent('calibration_upload_retry_unavailable', {
        sharing_enabled: sharingEnabled,
        upload_available: canUploadCalibrationLabels(),
      }, { category: 'calibration', severity: 'warn', title: 'Calibration upload retry unavailable' });
      return { attempted: 0, uploaded: 0, failed: 0, unavailable: true };
    }

    const labels = await localCalibrationLabelRepository.list();
    const pending = labels.filter((label) => (
      label?.upload_status === 'pending_upload' &&
      (label.eligibleForCalibration ?? label.eligible_for_calibration) !== false
    ));
    let uploaded = 0;
    let failed = 0;

    for (const label of pending) {
      try {
        const saved = await apiClient.post(`/${CALIBRATION_LABEL_COLLECTION}`, uploadPayloadFromRecord(label));
        const savedId = saved?.labelId || saved?.id || label.labelId;
        await localCalibrationLabelRepository.update(label.id, {
          upload_status: 'uploaded',
          upload_error: null,
          uploaded_at: new Date().toISOString(),
          remote_label_id: savedId,
        });
        if (label.trip_id != null) {
          await localCalibrationLabelRepository.markTripSubmitted(label.trip_id, {
            label_id: label.id,
            remote_label_id: savedId,
            rating: label.surveyLabel?.overallDriveRating ?? null,
            wasDriver: label.surveyLabel?.wasDriver ?? null,
            submitted_at: label.createdAt ?? label.stored_at,
            eligible_for_calibration: true,
            upload_status: 'uploaded',
          });
        }
        uploaded += 1;
      } catch (error) {
        failed += 1;
        logSystemFailure('calibration_pending_upload_retry_failed', error, {
          label_id_present: Boolean(label.id),
        });
        await localCalibrationLabelRepository.update(label.id, {
          upload_error: error?.message || 'Upload failed',
        });
      }
    }

    recordSystemEvent('calibration_upload_retry_completed', {
      attempted: pending.length,
      uploaded,
      failed,
    }, {
      category: 'calibration',
      severity: failed > 0 ? 'warn' : 'info',
      title: 'Calibration upload retry completed',
    });
    return { attempted: pending.length, uploaded, failed, unavailable: false };
  },
};
