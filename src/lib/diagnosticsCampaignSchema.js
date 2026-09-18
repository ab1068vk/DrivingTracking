const pick = (value, keys) => Object.fromEntries(keys
  .filter((key) => ['string', 'number', 'boolean'].includes(typeof value?.[key]) || value?.[key] === null)
  .map((key) => [key, typeof value[key] === 'string'
    ? value[key].replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 180)
    : typeof value[key] === 'number' ? (Number.isFinite(value[key]) ? Math.max(0, value[key]) : null)
      : value[key]]));

export function sanitizeCampaignExport(value = {}) {
  const readiness = {};
  ['analytics', 'geometry', 'spatial_selection', 'road_learning'].forEach((name) => {
    if (value.derived_readiness?.[name]) {
      readiness[name] = pick(value.derived_readiness[name], ['domain', 'state', 'complete', 'pending', 'has_more', 'required_version', 'applied_version']);
    }
  });
  return {
    collection: {
      state: String(value.collection?.state || value.state || 'unavailable').replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 120),
      reason: value.collection?.reason || value.reason
        ? String(value.collection?.reason || value.reason).replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 120)
        : null,
    },
    authority: pick(value.authority, ['trip', 'generation', 'revision', 'snapshot_state']),
    archive_recovery: pick(value.archive_recovery, ['state', 'authority_state', 'sentinel_matches', 'live_record_count', 'pending_count', 'integrity_due']),
    migration: pick(value.migration, ['state', 'items_processed', 'items_pending']),
    active_capture: pick(value.active_capture, ['state', 'service_enabled', 'checkpoint_state', 'completed_journal_count']),
    backup_restore: pick(value.backup_restore, ['state', 'detail']),
    key_rotation: pick(value.key_rotation, ['state', 'active_key_version', 'native_phase', 'pending_count', 'recorded_error_count']),
    derived_readiness: readiness,
    coordinator: pick(value.coordinator, ['registered_jobs', 'active_instances', 'sleeping_instances', 'backlog', 'runnable_backlog', 'lifecycle_epoch', 'foreground', 'telemetry_count', 'telemetry_dropped']),
    road_speed: pick(value.road_speed, ['state', 'generation', 'revision', 'bucket_count', 'item_count']),
    projection_detail: pick(value.projection_detail, ['state', 'complete', 'detail_representation', 'after_revision', 'required_revision']),
    background_enrichment: pick(value.background_enrichment, ['state', 'backlog']),
  };
}
