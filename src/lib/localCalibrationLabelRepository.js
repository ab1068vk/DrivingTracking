import { getJson, setJson } from '@/lib/mobileStorage';

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
      ...(tripId != null ? { trip_id: String(tripId) } : {}),
      ...payload,
    };
    await setJson(CALIBRATION_LABELS_KEY, [record, ...(Array.isArray(labels) ? labels : [])]);
    if (tripId != null) {
      await this.markTripSubmitted(tripId, {
        label_id: record.id,
        rating: record.surveyLabel?.overallDriveRating ?? null,
        score_accuracy: record.surveyLabel?.scoreAccuracy ?? null,
        score_issue_types: record.surveyLabel?.scoreIssueTypes ?? [],
        target_score: record.surveyLabel?.targetScore ?? null,
        wasDriver: record.surveyLabel?.wasDriver ?? null,
        context_tags: record.surveyLabel?.contextTags ?? [],
        free_text_note: record.local_only_note ?? '',
        submitted_at: record.createdAt ?? record.stored_at,
        eligible_for_calibration: record.eligibleForCalibration ?? record.eligible_for_calibration ?? false,
        upload_status: uploadStatus,
        ...(record.remote_label_id ? { remote_label_id: record.remote_label_id } : {}),
      });
    }
    return record;
  },

  async list() {
    const labels = await getJson(CALIBRATION_LABELS_KEY, []);
    return Array.isArray(labels) ? labels : [];
  },

  async update(labelId, patch = {}) {
    if (!labelId) return null;
    const labels = await this.list();
    let updatedRecord = null;
    const next = labels.map((label) => {
      if (label?.id !== labelId) return label;
      updatedRecord = {
        ...label,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      return updatedRecord;
    });
    await setJson(CALIBRATION_LABELS_KEY, next);
    return updatedRecord;
  },

  async delete(labelId) {
    if (!labelId) return false;
    const labels = await this.list();
    const target = labels.find((label) => label?.id === labelId);
    const next = labels.filter((label) => label?.id !== labelId);
    await setJson(CALIBRATION_LABELS_KEY, next);
    if (target?.trip_id != null) {
      const marker = await this.getTripSurveyStatus(target.trip_id);
      if (marker?.label_id === labelId) await this.clearTripSurveyStatus(target.trip_id);
    }
    return labels.length !== next.length;
  },

  async deleteTripLabel(tripId) {
    if (tripId == null) return 0;
    const labels = await this.list();
    const tripKey = String(tripId);
    const next = labels.filter((label) => String(label?.trip_id ?? '') !== tripKey);
    await setJson(CALIBRATION_LABELS_KEY, next);
    await this.clearTripSurveyStatus(tripKey);
    return labels.length - next.length;
  },

  async replaceAll(labels = []) {
    const next = Array.isArray(labels) ? labels : [];
    await setJson(CALIBRATION_LABELS_KEY, next);
    return next;
  },

  /**
   * Merge imported labels into the existing set, keyed by id. Restoring a
   * backup used to call replaceAll, which silently destroyed every survey
   * label created since that backup was taken.
   *
   * On an id collision the newer `created_at` wins; labels with no id are
   * appended, since they cannot be matched.
   */
  async mergeAll(labels = []) {
    const incoming = Array.isArray(labels) ? labels : [];
    if (!incoming.length) return this.list();
    const existing = await this.list();
    const byId = new Map();
    const unkeyed = [];

    const absorb = (label) => {
      if (label?.id == null) {
        unkeyed.push(label);
        return;
      }
      const key = String(label.id);
      const current = byId.get(key);
      if (!current) {
        byId.set(key, label);
        return;
      }
      const currentAt = new Date(current.created_at || 0).getTime();
      const incomingAt = new Date(label.created_at || 0).getTime();
      if (Number.isFinite(incomingAt) && incomingAt > (Number.isFinite(currentAt) ? currentAt : 0)) {
        byId.set(key, label);
      }
    };

    existing.forEach(absorb);
    incoming.forEach(absorb);
    const next = [...byId.values(), ...unkeyed];
    await setJson(CALIBRATION_LABELS_KEY, next);
    return next;
  },

  async count() {
    return (await this.list()).length;
  },

  async getTripSurveyStatus(tripId) {
    if (tripId == null) return null;
    const markers = await getJson(CALIBRATION_SURVEY_MARKERS_KEY, {});
    return markers?.[String(tripId)] || null;
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

  async listTripSurveyMarkers() {
    const markers = await getJson(CALIBRATION_SURVEY_MARKERS_KEY, {});
    return markers && typeof markers === 'object' && !Array.isArray(markers) ? markers : {};
  },

  async replaceTripSurveyMarkers(markers = {}) {
    const next = markers && typeof markers === 'object' && !Array.isArray(markers) ? markers : {};
    await setJson(CALIBRATION_SURVEY_MARKERS_KEY, next);
    return next;
  },

  /** Merge imported survey markers over the existing ones (see mergeAll). */
  async mergeTripSurveyMarkers(markers = {}) {
    const incoming = markers && typeof markers === 'object' && !Array.isArray(markers) ? markers : {};
    if (!Object.keys(incoming).length) return getJson(CALIBRATION_SURVEY_MARKERS_KEY, {});
    const existing = await getJson(CALIBRATION_SURVEY_MARKERS_KEY, {});
    const next = { ...(existing && typeof existing === 'object' ? existing : {}), ...incoming };
    await setJson(CALIBRATION_SURVEY_MARKERS_KEY, next);
    return next;
  },

  async clearTripSurveyStatus(tripId) {
    if (tripId == null) return null;
    const markers = await getJson(CALIBRATION_SURVEY_MARKERS_KEY, {});
    const next = { ...(markers && typeof markers === 'object' ? markers : {}) };
    delete next[String(tripId)];
    await setJson(CALIBRATION_SURVEY_MARKERS_KEY, next);
    return null;
  },

  async markTripSkipped(tripId) {
    if (tripId == null) return null;
    return this.markTripSubmitted(tripId, {
      skipped: true,
      skipped_at: new Date().toISOString(),
      upload_status: 'skipped',
    });
  },
};
