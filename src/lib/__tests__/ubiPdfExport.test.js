import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeUBIReport } from '@/lib/ubiReport';
import { exportMonthlyReportPDF, exportUBIReportPDF } from '@/lib/pdfExport';

const { pdfSave, pdfText } = vi.hoisted(() => ({ pdfSave: vi.fn(), pdfText: vi.fn() }));

vi.mock('jspdf', () => ({
  jsPDF: class {
    setFont() {}
    setFontSize() {}
    setTextColor() {}
    setDrawColor() {}
    setFillColor() {}
    rect() {}
    roundedRect() {}
    addPage() {}
    text(...args) { pdfText(...args); }
    save(...args) { pdfSave(...args); }
  },
}));

vi.mock('@/lib/nativePlatform', () => ({
  isNativePlatform: () => false,
}));

vi.mock('@/lib/nativeDownloads', () => ({
  saveExportToDownloads: vi.fn(),
}));

describe('UBI PDF export', () => {
  beforeEach(() => {
    pdfSave.mockClear();
    pdfText.mockClear();
  });

  it('prints an insufficient-data state without a grade or tier when no score exists', async () => {
    await exportUBIReportPDF(computeUBIReport([]));
    const renderedText = pdfText.mock.calls.map(([text]) => String(text)).join(' ');

    expect(renderedText).toContain('Insufficient data');
    expect(renderedText).not.toContain('Non-preferred');
    expect(renderedText).not.toContain('D -');
    expect(renderedText).not.toContain('null');
  });

  it('adds UBI metric registry metadata to score-card PDFs', async () => {
    await exportUBIReportPDF(computeUBIReport([]));
    const renderedText = pdfText.mock.calls.map(([text]) => String(text)).join(' ');

    expect(renderedText).toContain('NOT AN INSURANCE RATING');
    expect(renderedText).toContain('must not be used for insurance eligibility');
    expect(renderedText).toContain('Metric Reference');
    expect(renderedText).toContain('UBI-Style Score [ubi_score]');
    expect(renderedText).toContain('Internal estimate only; not insurer validated.');
  });

  it('prints the insurance warning on the face of a scored UBI PDF', async () => {
    await exportUBIReportPDF(computeUBIReport([{
      status: 'completed',
      start_time: '2026-05-01T08:00:00.000Z',
      end_time: '2026-05-01T09:00:00.000Z',
      distance_km: 60,
      duration_seconds: 3600,
      score_overall: 88,
      harsh_brakes_count: 1,
      rapid_accel_count: 0,
      sharp_turns_count: 0,
      speeding_events_count: 0,
    }]));
    const renderedText = pdfText.mock.calls.map(([text]) => String(text)).join(' ');

    expect(renderedText).toContain('NOT AN INSURANCE RATING');
    expect(renderedText).toContain('Internal estimate:');
    expect(renderedText).toContain('~');
    expect(renderedText).toContain('underwriting, or pricing');
  });

  it('adds trip metric registry metadata to selected-period PDFs', async () => {
    await exportMonthlyReportPDF([{
      status: 'completed',
      start_time: '2026-05-01T08:00:00.000Z',
      distance_km: 10,
      duration_seconds: 900,
      score_overall: 82,
      score_safety: 80,
      score_smoothness: 84,
      score_eco: 83,
      harsh_brakes_count: 1,
      speeding_events_count: 0,
    }], 'week');
    const renderedText = pdfText.mock.calls.map(([text]) => String(text)).join(' ');

    expect(renderedText).toContain('This Week Driving Report');
    expect(renderedText).toContain('Metric Reference');
    expect(renderedText).toContain('Scores are estimates');
    expect(renderedText).toContain('~82');
    expect(renderedText).toContain('Total estimated fuel cost');
    expect(renderedText).toContain('Safety Pattern Estimate [score_safety]');
    expect(renderedText).toContain('not calibrated to crashes, claims, or safety outcomes');
    expect(pdfSave).toHaveBeenCalledWith(expect.stringMatching(/^road-sage-driving-report-week-\d{4}-\d{2}-\d{2}\.pdf$/));
  });
});
