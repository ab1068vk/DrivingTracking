/**
 * Single source of truth for driving-event feedback keys and for applying a
 * trip's stored `event_feedback` to a freshly detected event list.
 *
 * This lived in three places (TripDetail, localTripRepository, and a test)
 * which let rescore paths silently disagree about which events the driver had
 * already reviewed. Every path that re-detects events must run through here.
 */

/**
 * Stable identity for an event within a trip's feedback map.
 * @param {any} event
 * @param {number|string} index
 * @returns {string}
 */
export const eventFeedbackKey = (event, index) => [
  event?.type || 'event',
  event?.timestamp || index,
  Number.isFinite(Number(event?.value)) ? Number(event.value).toFixed(2) : '',
].join('|');

/**
 * Remove events the driver marked "wrong".
 *
 * Feedback recorded with `affects_score: false` is a detection note only - the
 * UI explicitly promises it does not change the score - so those entries are
 * kept in the list and surfaced via `flagged` instead of being dropped.
 *
 * @param {any[]} events
 * @param {Record<string, any>} feedback
 * @returns {{ events: any[], removed: number, flagged: number }}
 */
export const applyEventFeedbackToEvents = (events = [], feedback = {}) => {
  const reviewed = feedback && typeof feedback === 'object' && !Array.isArray(feedback) ? feedback : {};
  const list = Array.isArray(events) ? events : [];
  let removed = 0;
  let flagged = 0;
  const filtered = list.filter((event, index) => {
    const entry = reviewed[eventFeedbackKey(event, index)];
    if (entry?.verdict !== 'wrong') return true;
    if (entry.affects_score === false) {
      flagged += 1;
      return true;
    }
    removed += 1;
    return false;
  });
  return { events: filtered, removed, flagged };
};

/**
 * Apply the same feedback filter to phone-use evidence and rebuild the derived
 * phone-use summary from what survives.
 *
 * @param {any} phoneUse
 * @param {Record<string, any>} feedback
 * @param {number} durationSeconds
 * @param {(events:any[], durationSeconds:number, source:string)=>any} buildPhoneUseFromEvents
 */
export const applyEventFeedbackToPhoneUseWith = (
  phoneUse = {},
  feedback = {},
  durationSeconds = 0,
  buildPhoneUseFromEvents
) => {
  const confirmedEvents = Array.isArray(phoneUse?.phone_use_events) ? phoneUse.phone_use_events : [];
  const proxyEvents = Array.isArray(phoneUse?.phone_proxy_events) ? phoneUse.phone_proxy_events : [];
  const adjusted = applyEventFeedbackToEvents([...confirmedEvents, ...proxyEvents], feedback);
  const rebuilt = buildPhoneUseFromEvents(adjusted.events, durationSeconds, 'none');
  const hadConfirmedScore = phoneUse?.phone_use_score_available === true;
  const hasConfirmedEvents = rebuilt.phone_use_events?.length > 0;

  return {
    phoneUse: hadConfirmedScore && !hasConfirmedEvents
      ? {
        ...rebuilt,
        phone_use_score: 100,
        phone_use_score_available: true,
        phone_use_score_status: phoneUse.phone_use_score_status || 'android_usage_access',
        data_sources: Array.isArray(phoneUse.data_sources) && phoneUse.data_sources.length
          ? phoneUse.data_sources
          : ['android_usage_access'],
      }
      : rebuilt,
    removed: adjusted.removed,
    flagged: adjusted.flagged,
  };
};

/**
 * Keep a trip's feedback map aligned with its current events.
 *
 * Feedback keys embed the event magnitude, so re-detection with a different
 * effective speed limit moves a `speeding` event's key and orphans the
 * driver's verdict. Rather than dropping it, follow the event: an entry whose
 * key no longer resolves is remapped onto the live event with the same type
 * and timestamp. Only entries with no matching event at all are removed, and
 * entries carrying no timestamp are always kept because they cannot be
 * matched safely.
 *
 * @param {Record<string, any>} feedback
 * @param {any[]} events every event the trip currently has, any order
 * @returns {{ feedback: Record<string, any>, remapped: number, pruned: number }}
 */
export const reconcileEventFeedbackKeys = (feedback = {}, events = []) => {
  if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback)) {
    return { feedback: {}, remapped: 0, pruned: 0 };
  }
  const list = Array.isArray(events) ? events : [];
  const live = new Set(list.map(eventFeedbackKey));
  const byIdentity = new Map();
  list.forEach((event, index) => {
    if (event?.timestamp == null) return;
    byIdentity.set(`${event.type || 'event'}|${event.timestamp}`, eventFeedbackKey(event, index));
  });

  const next = {};
  let remapped = 0;
  let pruned = 0;
  Object.entries(feedback).forEach(([key, value]) => {
    if (live.has(key)) {
      next[key] = value;
      return;
    }
    const timestamp = value?.timestamp;
    if (timestamp == null) {
      next[key] = value;
      return;
    }
    const movedKey = byIdentity.get(`${value?.type || 'event'}|${timestamp}`);
    if (movedKey) {
      next[movedKey] = next[movedKey] || value;
      remapped += 1;
      return;
    }
    pruned += 1;
  });
  return { feedback: next, remapped, pruned };
};
