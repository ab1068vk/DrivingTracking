/**
 * AUD-003 — the Report may not say more than it knows.
 *
 * CODEX verified that one gate, `summary.total_trips === 0`, answered three different
 * questions, so a storage refusal rendered as "No report data yet — complete a trip in
 * this period" and a non-terminal tally rendered as finished totals with a trend, a
 * baseline and UBI inputs beside them.
 *
 * These are the five cases the correction has to keep apart, plus the wiring that carries
 * them into the page. There is no React renderer in this repository's test stack, so the
 * decisions live in a pure module that is tested directly, and the page is checked
 * structurally for actually using it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPORT_STATE,
  commonRiskCopy,
  formatPartialTotal,
  recommendedFocusCopy,
  reportConclusionGates,
  reportPresentationState,
  riskFocusChipCopy,
  showsGenuineEmptyState,
  unavailableCopy,
  withheldCopy,
} from '@/lib/reportPresentation';
import { nextActionMessage } from '@/pages/Report';

describe('AUD-003 — the five report states are distinct', () => {
  it('reports a typed storage refusal as unavailable, never as an empty period', () => {
    const state = reportPresentationState({
      unavailable: { code: 'STORAGE_UNAVAILABLE' },
      exact: false,
      totalTrips: 0,
    });
    expect(state).toBe(REPORT_STATE.UNAVAILABLE);
    expect(showsGenuineEmptyState(state)).toBe(false);

    const copy = unavailableCopy({ code: 'STORAGE_UNAVAILABLE' });
    // It must not tell a driver whose trips exist that they have not driven.
    expect(`${copy.title} ${copy.detail}`).not.toMatch(/no trips|No report data yet|Complete a trip/i);
    expect(copy.detail).toMatch(/still on this device/i);
  });

  it('reports a query refusal as unavailable even when the fold produced zero', () => {
    // The zero here is an artefact of the refusal, not a count. Refusal wins.
    expect(reportPresentationState({
      unavailable: { code: 'CURSOR_SNAPSHOT_CHANGED' },
      exact: true,
      totalTrips: 0,
    })).toBe(REPORT_STATE.UNAVAILABLE);
    expect(unavailableCopy({ code: 'CURSOR_SNAPSHOT_CHANGED' }).detail).toMatch(/not been changed or deleted|Reload/i);
  });

  it('keeps the genuine exact-zero empty state, which is the only truthful one', () => {
    const state = reportPresentationState({ unavailable: null, exact: true, totalTrips: 0 });
    expect(state).toBe(REPORT_STATE.EXACT_EMPTY);
    expect(showsGenuineEmptyState(state)).toBe(true);
  });

  it('reports a non-terminal tally as partial, not as a complete period', () => {
    const state = reportPresentationState({ unavailable: null, exact: false, totalTrips: 7 });
    expect(state).toBe(REPORT_STATE.PARTIAL);
    expect(showsGenuineEmptyState(state)).toBe(false);
    expect(formatPartialTotal('128.4 km', state)).toBe('at least 128.4 km');
  });

  it('reports a terminal tally with trips as exact and leaves its figures alone', () => {
    const state = reportPresentationState({ unavailable: null, exact: true, totalTrips: 7 });
    expect(state).toBe(REPORT_STATE.EXACT);
    expect(formatPartialTotal('128.4 km', state)).toBe('128.4 km');
  });

  it('shows nothing but the loading state while the first answer is outstanding', () => {
    expect(reportPresentationState({ isLoading: true, unavailable: { code: 'X' } }))
      .toBe(REPORT_STATE.LOADING);
  });
});

describe('AUD-003 — derived conclusions require their own exactness', () => {
  const partial = { state: REPORT_STATE.PARTIAL };
  const exact = { state: REPORT_STATE.EXACT };

  it('withholds every conclusion when the report is unavailable', () => {
    const gates = reportConclusionGates({
      state: REPORT_STATE.UNAVAILABLE,
      monthlyTrendExact: true,
      baselineExact: true,
      mileageWindowExact: true,
      recordsExact: true,
      tipsExact: true,
    });
    expect(Object.values(gates).every((allowed) => allowed === false)).toBe(true);
  });

  it('binds each conclusion to the signal it actually depends on', () => {
    // A terminal trend beside a non-terminal baseline is a real situation: refusing the
    // trend too would hide something that IS known.
    const gates = reportConclusionGates({
      ...partial,
      monthlyTrendExact: true,
      baselineExact: false,
      mileageWindowExact: false,
      recordsExact: true,
      tipsExact: false,
    });
    expect(gates).toMatchObject({
      trend: true, baseline: false, mileage: false, records: true, tips: false,
    });
  });

  it('never grades or exports as exact while the period is partial', () => {
    const gates = reportConclusionGates({
      ...partial,
      monthlyTrendExact: true,
      mileageWindowExact: true,
    });
    expect(gates.grade).toBe(false);
    expect(gates.exportExact).toBe(false);
  });

  it('grades only when the period and every folded input is exact', () => {
    expect(reportConclusionGates({ ...exact, monthlyTrendExact: true, mileageWindowExact: true }).grade)
      .toBe(true);
    expect(reportConclusionGates({ ...exact, monthlyTrendExact: false, mileageWindowExact: true }).grade)
      .toBe(false);
    expect(reportConclusionGates({ ...exact, monthlyTrendExact: true, mileageWindowExact: false }).grade)
      .toBe(false);
  });

  it('says what was withheld instead of leaving a gap', () => {
    expect(withheldCopy('A score-card grade')).toMatch(/needs the full period/);
    expect(withheldCopy('A score-card grade')).toMatch(/Finish analysis/);
  });
});

describe('AUD-003 — partial-with-zero is not a terminal empty period', () => {
  it('separates "none counted so far" from "none recorded"', () => {
    // The distinction the copy has to carry: a partial tally that has not yet counted a
    // trip is not a period in which the driver did not drive.
    expect(reportPresentationState({ unavailable: null, exact: false, totalTrips: 0 }))
      .toBe(REPORT_STATE.PARTIAL);
    expect(showsGenuineEmptyState(REPORT_STATE.PARTIAL)).toBe(false);
    expect(showsGenuineEmptyState(REPORT_STATE.EXACT_EMPTY)).toBe(true);
  });

  it('never allows a composed conclusion from a partial-with-zero report', () => {
    const gates = reportConclusionGates({
      state: REPORT_STATE.PARTIAL,
      monthlyTrendExact: true,
      mileageWindowExact: true,
      recordsExact: true,
      tipsExact: true,
    });
    expect(gates.grade).toBe(false);
    expect(gates.exportExact).toBe(false);
  });
});

describe('AUD-003 — every computed gate is consumed at its output', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/pages/Report.jsx'), 'utf8');

  /** A gate that is computed and never read is the defect this section exists to stop. */
  const consumed = (gate) => new RegExp(String.raw`gates\.${gate}\b`).test(page);

  it('consumes every gate the hook computes', () => {
    const unused = ['trend', 'baseline', 'mileage', 'records', 'tips', 'grade', 'exportExact']
      .filter((gate) => !consumed(gate));
    expect(unused).toEqual([]);
  });

  it('withholds the UBI score and its radar unless the grade gate allows it', () => {
    expect(page).toMatch(/\{!gates\.grade \? \(/);
    expect(page).toContain('report-ubi-withheld');
    // The radar is the same composed conclusion drawn differently.
    expect(page).toMatch(/\{gates\.grade && !ubiReport\.insufficientData && \(/);
  });

  it('refuses both report exports unless the period is exact', () => {
    expect(page).toMatch(/const handleExport = async \(\) => \{\s*if \(!gates\.exportExact\)/);
    expect(page).toMatch(/const handlePdfExport = async \(\) => \{\s*if \(!gates\.exportExact\)/);
    // And the buttons say so rather than looking available.
    expect(page).toMatch(/disabled=\{!gates\.exportExact\}/);
    expect(page).toMatch(/disabled=\{pdfLoading \|\| !gates\.exportExact\}/);
    expect(page).toContain('Export unavailable');
  });

  it('refuses the score-card export on the grade gate, not merely the export gate', () => {
    expect(page).toMatch(/const handleUbiExport = async \(\) => \{[\s\S]{0,260}?if \(!gates\.grade\)/);
    expect(page).toMatch(/disabled=\{ubiLoading \|\| !gates\.grade\}/);
  });

  it('withholds period records until their own reducer is terminal', () => {
    expect(page).toContain('report-records-withheld');
    expect(page).toMatch(/\{gates\.records && summary\.best_trip && \(/);
  });

  it('withholds the dominant-risk conclusion until the tips gate allows it', () => {
    expect(page).toMatch(/gates\.tips[\s\S]{0,400}?Main thing to work on/);
    expect(page).toMatch(/gates\.tips[\s\S]{0,600}?No dominant risk event stood out/);
  });

  it('does not use the terminal no-trips sentence for a partial period', () => {
    // The terminal sentence must sit on the NON-partial side of the branch.
    expect(page).toMatch(/isPartial[\s\S]{0,200}?No trips counted so far/);
    expect(page).toMatch(/No trips counted so far[\s\S]{0,200}?No trips were recorded in this report period/);
  });
});

describe('AUD-003 — every period-level dominant-risk output obeys gates.tips', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/pages/Report.jsx'), 'utf8');

  /** A PARTIAL period that HAS an observed leading risk — the situation that misled. */
  const partialGates = reportConclusionGates({
    state: REPORT_STATE.PARTIAL,
    monthlyTrendExact: true,
    baselineExact: true,
    mileageWindowExact: true,
    recordsExact: true,
    tipsExact: false,
  });
  const exactGates = reportConclusionGates({
    state: REPORT_STATE.EXACT,
    monthlyTrendExact: true,
    baselineExact: true,
    mileageWindowExact: true,
    recordsExact: true,
    tipsExact: true,
  });

  const topRisk = { key: 'speeding', label: 'Speeding', count: 9 };
  const peakHourStress = { stress_ratio: 1.0 };

  /** The three outputs, each built the way the page builds it. */
  const outputs = (gates) => ({
    'Recommended focus': recommendedFocusCopy({
      allowed: gates.tips,
      terminalMessage: nextActionMessage(topRisk, peakHourStress),
    }),
    'Risk Events focus chip': riskFocusChipCopy({ allowed: gates.tips, label: topRisk.label }),
    'Most common risk': commonRiskCopy({ allowed: gates.tips, label: 'Speeding' }),
  });

  it('makes no terminal whole-period claim while the tally is partial', () => {
    expect(partialGates.tips).toBe(false);
    const terminal = Object.entries(outputs(partialGates))
      .filter(([, copy]) => copy.terminal)
      .map(([name]) => name);

    // Named individually so a failure says WHICH surface started concluding again.
    expect(terminal).toEqual([]);
  });

  it('says "so far" rather than naming a winner, on every one of them', () => {
    const copies = outputs(partialGates);
    expect(copies['Recommended focus'].text).toMatch(/not settled yet/i);
    expect(copies['Recommended focus'].text).not.toMatch(/biggest score drag this period/i);
    expect(copies['Risk Events focus chip'].text).toBe('Leading so far: Speeding');
    expect(copies['Risk Events focus chip'].text).not.toMatch(/^Focus:/);
    expect(copies['Most common risk'].text).toBe('Most common so far: Speeding');
    expect(copies['Most common risk'].detail).toMatch(/has not finished totalling/i);
    expect(copies['Most common risk'].detail).not.toMatch(/Focus on improving this/i);
  });

  it('never contradicts the coaching tips it sits beside', () => {
    // The defect was the page declining to name a dominant risk in one section while
    // naming one three sections later. One gate, one answer, everywhere.
    const copies = outputs(partialGates);
    const anyConcludes = Object.values(copies).some((copy) => copy.terminal);
    expect(anyConcludes).toBe(partialGates.tips);
  });

  it('still renders the normal conclusions when the period is EXACT', () => {
    expect(exactGates.tips).toBe(true);
    const copies = outputs(exactGates);
    expect(Object.values(copies).every((copy) => copy.terminal)).toBe(true);
    // The frozen O72 ladder is unchanged, not replaced.
    expect(copies['Recommended focus'].text).toBe(nextActionMessage(topRisk, peakHourStress));
    expect(copies['Recommended focus'].text).toMatch(/speeding is the biggest score drag this period/i);
    expect(copies['Risk Events focus chip'].text).toBe('Focus: Speeding');
    expect(copies['Most common risk'].text).toBe('Most common risk: Speeding');
    expect(copies['Most common risk'].detail).toBe('Focus on improving this for a better score');
  });

  it('keeps the negative conclusion gated too', () => {
    // "The report did not find a single dominant risk event" is equally terminal, and is
    // the branch a partial tally reaches most easily — nothing has led yet.
    const quiet = { key: 'harsh_brake', label: 'Harsh Braking', count: 0 };
    const partial = recommendedFocusCopy({
      allowed: false,
      terminalMessage: nextActionMessage(quiet, peakHourStress),
    });
    expect(partial.terminal).toBe(false);
    expect(partial.text).not.toMatch(/did not find a single dominant risk/i);
  });

  /** The three ACTUAL render sites must be the ones calling these. */
  it('is wired at the three real output boundaries, not somewhere else in the file', () => {
    // 1. Recommended focus — the O72 next-action seam.
    expect(page).toMatch(/nextActionFor: \(\) => recommendedFocusCopy\(\{[\s\S]{0,120}?allowed: gates\.tips/);
    // 2. The Risk Events header chip.
    expect(page).toMatch(/riskFocusChipCopy\(\{ allowed: gates\.tips, label: topRisk\.label \}\)\.text/);
    // 3. Most common risk, and the instruction under it.
    expect(page).toMatch(/commonRiskCopy\(\{ allowed: gates\.tips, label: riskLabels\[summary\.most_common_risk\] \}\)\.text/);
    expect(page).toMatch(/commonRiskCopy\(\{ allowed: gates\.tips, label: riskLabels\[summary\.most_common_risk\] \}\)\.detail/);

    // And none of the terminal strings may survive unguarded at those sites.
    expect(page).not.toMatch(/Focus: \{topRisk\.label\}/);
    expect(page).not.toMatch(/Most common risk: \{riskLabels/);
    expect(page).not.toMatch(/>\s*Focus on improving this for a better score\s*</);
    expect(page).not.toMatch(/nextActionFor: \(\) => nextActionMessage\(/);
  });
});

describe('AUD-003 — the page is wired to the gates', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/pages/Report.jsx'), 'utf8');

  it('branches on the report state rather than on the trip count alone', () => {
    expect(page).toContain('reportPresentationState({');
    expect(page).toMatch(/reportState === REPORT_STATE\.UNAVAILABLE/);
    expect(page).toMatch(/showsGenuineEmptyState\(reportState\)/);
    // The single collapsed gate must be gone from the state branch.
    expect(page).not.toMatch(/\)\s*:\s*summary\.total_trips === 0 \?/);
  });

  it('consumes the hook exactness signals it used to ignore', () => {
    for (const signal of [
      'reportData.unavailable',
      'reportData.exact',
      'reportData.monthlyTrendExact',
      'reportData.mileageWindowExact',
      'reportData.baselineExact',
    ]) {
      expect(page).toContain(signal);
    }
  });

  it('labels partial totals and gates trend, baseline, grade and mileage', () => {
    expect(page).toContain('report-partial-notice');
    expect(page).toMatch(/formatPartialTotal\(formatDistance\(/);
    expect(page).toMatch(/gates\.trend/);
    expect(page).toMatch(/gates\.baseline/);
    expect(page).toMatch(/gates\.grade/);
    expect(page).toMatch(/gates\.mileage/);
    expect(page).toContain('report-ubi-withheld');
  });

  it('keeps the unavailable copy free of any no-trips claim', () => {
    const block = page.slice(page.indexOf('report-unavailable'), page.indexOf('report-exact-empty'));
    expect(block).not.toMatch(/Complete a trip/i);
    expect(block).not.toMatch(/No report data yet/i);
  });
});
