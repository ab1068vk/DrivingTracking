/**
 * Backup-import result presentation.
 *
 * Every partial failure has to reach the user. The import itself already logs
 * each failure through `logSystemFailure` and returns an explicit `*Restored`
 * flag, so the only job here is to report all of them together instead of
 * letting one warning hide the others.
 */

/**
 * @param {Record<string, any>} result Return value of `importBackup`.
 * @returns {string[]} One sentence per problem, empty when the import was clean.
 */
export function collectBackupImportIssues(result = {}) {
  const speedKnowledgeItems = (result.speedKnowledgeCells || 0) +
    (result.speedKnowledgeCorrections || 0) +
    (result.roadMemoryCandidates || 0) +
    (result.excludedSpeedSections || 0);
  const issues = [];

  if (result.truncatedFields) {
    issues.push((result.warnings || []).join(' '));
  }
  if (result.signatureRecovered) {
    issues.push('The old backup signature could not be verified, so settings were not imported.');
  }
  if (!result.savedFiltersRestored && result.savedFilters) {
    issues.push('Saved filters could not be restored.');
  }
  if (!result.calibrationLabelsRestored && result.calibrationLabels) {
    issues.push('Calibration labels could not be restored.');
  }
  if (!result.speedKnowledgeRestored && speedKnowledgeItems) {
    issues.push('Saved road speeds could not be restored.');
  }
  if (result.speedKnowledgeRescoreFailed) {
    issues.push('Saved road speeds were restored, but affected trips could not be re-scored yet.');
  }
  if (result.privacy_zones_need_reconfiguration) {
    const count = result.privacy_zones_need_reconfiguration;
    issues.push(`Re-add ${count} privacy zone${count === 1 ? '' : 's'} because backups do not store private coordinates.`);
  }

  return issues.filter((issue) => String(issue || '').trim().length > 0);
}

/**
 * @param {Record<string, any>} result Return value of `importBackup`.
 * @returns {{ title: string, description: string, issues: string[], hasIssues: boolean }}
 */
export function describeBackupImportResult(result = {}) {
  const issues = collectBackupImportIssues(result);
  const summary = `${result.trips || 0} trips, ${result.vehicles || 0} vehicles, and ${result.savedFilters || 0} saved filters merged.`;

  return {
    title: issues.length ? 'Import completed with warnings' : 'Import complete',
    description: issues.length ? `${summary} ${issues.join(' ')}` : summary,
    issues,
    hasIssues: issues.length > 0,
  };
}
