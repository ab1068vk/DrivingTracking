import { describe, expect, it } from 'vitest';
import {
  collectBackupImportIssues,
  describeBackupImportResult,
} from '@/lib/dataBackupPresentation';

const cleanImport = {
  trips: 12,
  vehicles: 2,
  savedFilters: 3,
  savedFiltersRestored: true,
  calibrationLabels: 4,
  calibrationLabelsRestored: true,
  speedKnowledgeCells: 20,
  speedKnowledgeRestored: true,
  speedKnowledgeRescoreFailed: false,
  warnings: [],
  truncatedFields: 0,
  privacy_zones_need_reconfiguration: 0,
};

describe('backup import result presentation', () => {
  it('reports a clean import without warnings', () => {
    const report = describeBackupImportResult(cleanImport);

    expect(report.hasIssues).toBe(false);
    expect(report.title).toBe('Import complete');
    expect(report.description).toBe('12 trips, 2 vehicles, and 3 saved filters merged.');
  });

  it('reports a calibration-label failure that no other warning would reveal', () => {
    const report = describeBackupImportResult({
      ...cleanImport,
      calibrationLabelsRestored: false,
    });

    expect(report.hasIssues).toBe(true);
    expect(report.title).toBe('Import completed with warnings');
    expect(report.description).toContain('Calibration labels could not be restored.');
  });

  it('reports a saved-road-speed failure on its own', () => {
    const report = describeBackupImportResult({
      ...cleanImport,
      speedKnowledgeRestored: false,
    });

    expect(report.description).toContain('Saved road speeds could not be restored.');
  });

  it('reports a failed re-score even when the restore itself succeeded', () => {
    const report = describeBackupImportResult({
      ...cleanImport,
      speedKnowledgeRescoreFailed: true,
    });

    expect(report.description).toContain('could not be re-scored yet');
  });

  it('reports every partial failure instead of only the first', () => {
    const issues = collectBackupImportIssues({
      ...cleanImport,
      truncatedFields: 1,
      warnings: ['Some trip notes were shortened.'],
      signatureRecovered: true,
      savedFiltersRestored: false,
      calibrationLabelsRestored: false,
      speedKnowledgeRestored: false,
      speedKnowledgeRescoreFailed: true,
      privacy_zones_need_reconfiguration: 2,
    });

    expect(issues).toEqual([
      'Some trip notes were shortened.',
      'The old backup signature could not be verified, so settings were not imported.',
      'Saved filters could not be restored.',
      'Calibration labels could not be restored.',
      'Saved road speeds could not be restored.',
      'Saved road speeds were restored, but affected trips could not be re-scored yet.',
      'Re-add 2 privacy zones because backups do not store private coordinates.',
    ]);
  });

  it('stays quiet about content the backup never contained', () => {
    const issues = collectBackupImportIssues({
      trips: 1,
      vehicles: 0,
      savedFilters: 0,
      savedFiltersRestored: false,
      calibrationLabels: 0,
      calibrationLabelsRestored: false,
      speedKnowledgeCells: 0,
      speedKnowledgeCorrections: 0,
      roadMemoryCandidates: 0,
      excludedSpeedSections: 0,
      speedKnowledgeRestored: false,
    });

    expect(issues).toEqual([]);
  });

  it('uses singular wording for a single privacy zone', () => {
    const issues = collectBackupImportIssues({
      ...cleanImport,
      privacy_zones_need_reconfiguration: 1,
    });

    expect(issues[0]).toContain('Re-add 1 privacy zone because');
  });
});
