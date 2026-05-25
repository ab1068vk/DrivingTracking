import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeUBIReport } from '@/lib/ubiReport';
import { exportMonthlyReportPDF, exportUBIReportPDF } from '@/lib/pdfExport';

const { pdfText } = vi.hoisted(() => ({ pdfText: vi.fn() }));

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
    save() {}
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

    expect(renderedText).toContain('Metric Reference');
    expect(renderedText).toContain('UBI-Style Score [ubi_score]');
    expect(renderedText).toContain('Internal estimate only; not insurer validated.');
  });

  it('adds trip metric registry metadata to monthly PDFs', async () => {
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
    }], 'month');
    const renderedText = pdfText.mock.calls.map(([text]) => String(text)).join(' ');

    expect(renderedText).toContain('Metric Reference');
    expect(renderedText).toContain('Safety Score [score_safety]');
    expect(renderedText).toContain('PENALTY_SCALE_FACTOR 40.0 provisional');
  });
});
