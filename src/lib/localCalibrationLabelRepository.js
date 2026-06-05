import { getJson, removeJson, setJson } from '@/lib/mobileStorage';

export const CALIBRATION_LABELS_KEY = 'road_sage_calibration_labels';
export const CALIBRATION_SURVEY_MARKERS_KEY = 'road_sage_calibration_survey_markers';

const makeId = () => `cal_label_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

export const localCalibrationLabelRepository = {
  async create(payload, { tripId = null, uploadStatus = 'local_only' } = {}) {
    const labels = await getJson(CALIBRATION_LABELS_KEY, []);
    const record = {
      id: payload?.id || makeId(),
      stored_at: new Date().toISOString(),
      upload_status: uploadStatus,
      ...payload,
    };
    await setJson(CALIBRATION_LABELS_KEY, [record, ...(Array.isArray(labels) ? labels : [])]);
    if (tripId != null) {
      await this.markTripSubmitted(tripId, {
        label_id: record.id,
        rating: record.surveyLabel?.overallDriveRating ?? null,
        wasDriver: record.surveyLabel?.wasDriver ?? null,
        submitted_at: record.createdAt ?? record.stored_at,
        eligible_for_calibration: record.eligibleForCalibration ?? record.eligible_for_calibration ?? false,
        upload_status: uploadStatus,
      });
    }
    return record;
  },

  async list() {
    const labels = await getJson(CALIBRATION_LABELS_KEY, []);
    return Array.isArray(labels) ? labels : [];
  },

  async count() {
    return (await this.list()).length;
  },

  async getTripSurveyStatus(tripId) {
    if (tripId == null) return null;
    const markers = await getJson(CALIBRATION_SURVEY_MARKERS_KEY, {});
    return markers?.[String(tripId)] || null;
  },

  async listSurveyMarkers() {
    const markers = await getJson(CALIBRATION_SURVEY_MARKERS_KEY, {});
    return markers && typeof markers === 'object' && !Array.isArray(markers) ? markers : {};
  },

  async markTripSubmitted(tripId, marker) {
    if (tripId == null) return null;
    const markers = await getJson(CALIBRATION_SURVEY_MARKERS_KEY, {});
    const next = {
      ...(markers && typeof markers === 'object' ? markers : {}),
      [String(tripId)]: {
        ...marker,
        trip_id: String(tripId),
      },
    };
    await setJson(CALIBRATION_SURVEY_MARKERS_KEY, next);
    return next[String(tripId)];
  },

  async markTripSkipped(tripId) {
    if (tripId == null) return null;
    return this.markTripSubmitted(tripId, {
      skipped: true,
      skipped_at: new Date().toISOString(),
      upload_status: 'skipped',
    });
  },

  async deleteAll() {
    await Promise.all([
      removeJson(CALIBRATION_LABELS_KEY),
      removeJson(CALIBRATION_SURVEY_MARKERS_KEY),
    ]);
    return { success: true };
  },
};
