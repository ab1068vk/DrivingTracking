/**
 * AUD-003 — what the Report is allowed to say about the numbers it has.
 *
 * THE DEFECT CODEX VERIFIED. The page had ONE gate, `summary.total_trips === 0`, and three
 * different situations fell through it into the same sentence:
 *
 *   - storage or the query authority REFUSED, so nothing is known;
 *   - the period is genuinely empty, and "no trips" is true;
 *   - the reducers answered but have not reached terminal EOF, so the totals are floors.
 *
 * The first rendered as "No report data yet — complete a trip in this period", which tells
 * the driver their trips are gone. The third rendered partial totals, a trend, a baseline
 * and UBI inputs as if they were complete-period exact figures.
 *
 * The hook already computes every signal needed to tell these apart (`unavailable`,
 * `exact`, `termsExact`, `monthlyTrendExact`, `baselineExact`, `mileageWindowExact`,
 * `recordsExact`). Nothing here re-queries or re-derives: this is presentation gating, and
 * it is a pure function so the states can be tested without a renderer.
 */

/** @typedef {'UNAVAILABLE'|'EXACT_EMPTY'|'PARTIAL'|'EXACT'|'LOADING'} ReportState */

export const REPORT_STATE = Object.freeze({
  LOADING: 'LOADING',
  UNAVAILABLE: 'UNAVAILABLE',
  EXACT_EMPTY: 'EXACT_EMPTY',
  PARTIAL: 'PARTIAL',
  EXACT: 'EXACT',
});

/**
 * @param {{unavailable?: unknown, exact?: boolean, totalTrips?: number, isLoading?: boolean}} input
 * @returns {ReportState}
 */
export function reportPresentationState({
  unavailable = null,
  exact = false,
  totalTrips = 0,
  isLoading = false,
} = {}) {
  if (isLoading) return REPORT_STATE.LOADING;
  // Refusal first, and refusal wins even when the totals happen to be zero: a zero derived
  // from an answer nobody could obtain is not the same fact as a zero that was counted.
  if (unavailable) return REPORT_STATE.UNAVAILABLE;
  if (!exact) return REPORT_STATE.PARTIAL;
  return Number(totalTrips) > 0 ? REPORT_STATE.EXACT : REPORT_STATE.EXACT_EMPTY;
}

/**
 * The only state in which the genuine no-trips empty screen is truthful.
 * Preserved deliberately — it is correct, and the correction must not lose it.
 */
export function showsGenuineEmptyState(state) {
  return state === REPORT_STATE.EXACT_EMPTY;
}

/** A partial total is a FLOOR. It is never presented as a complete-period figure. */
export function totalsQualifier(state) {
  return state === REPORT_STATE.PARTIAL ? 'so far' : '';
}

export function formatPartialTotal(text, state) {
  if (state !== REPORT_STATE.PARTIAL) return String(text ?? '');
  return `at least ${String(text ?? '')}`;
}

/**
 * Typed, human copy for a refusal. It must not claim anything about how much the driver
 * drove, because that is precisely what is unknown.
 */
export function unavailableCopy(unavailable) {
  const code = String(unavailable?.code ?? unavailable?.reason ?? '').toUpperCase();
  if (code.includes('STORAGE')) {
    return {
      title: 'Report data could not be read',
      detail: 'Saved trips are still on this device. The report could not read them just now — '
        + 'reopen the page, and check storage permissions if it keeps happening.',
    };
  }
  if (code.includes('CURSOR') || code.includes('SNAPSHOT')) {
    return {
      title: 'Report data moved while it was being read',
      detail: 'Trips changed while this period was being totalled. Reload the report to '
        + 'read the current data.',
    };
  }
  return {
    title: 'Report data is unavailable',
    detail: 'This period could not be totalled. Your trips have not been changed or deleted.',
  };
}

/**
 * Whether each derived conclusion may be presented as an exact figure.
 *
 * Each conclusion names the exactness signal it actually depends on rather than inheriting
 * one global flag: the monthly trend can be terminal while the baseline scan is not, and
 * refusing both because one is partial would hide a fact that is genuinely known.
 *
 * A grade or an exported conclusion is different: it composes several inputs, so it is
 * exact only when ALL of its inputs are.
 *
 * @param {{state: ReportState, monthlyTrendExact?: boolean, baselineExact?: boolean,
 *          mileageWindowExact?: boolean, recordsExact?: boolean, tipsExact?: boolean}} input
 */
export function reportConclusionGates({
  state,
  monthlyTrendExact = false,
  baselineExact = false,
  mileageWindowExact = false,
  recordsExact = false,
  tipsExact = false,
} = {}) {
  const known = state === REPORT_STATE.EXACT || state === REPORT_STATE.PARTIAL;
  const periodExact = state === REPORT_STATE.EXACT;
  const trend = known && monthlyTrendExact;
  const baseline = known && baselineExact;
  const mileage = known && mileageWindowExact;
  return {
    /** O23 — the event trend may only be read as the period's trend when terminal. */
    trend,
    /** O52 — the personal baseline needs its own scan to have reached EOF. */
    baseline,
    /** O26 — UBI mileage input; a partial window understates every derived rate. */
    mileage,
    /** Lifetime records need their own reducer terminal. */
    records: known && recordsExact,
    /** O47 — coaching tips, already correct today; carried so one place answers this. */
    tips: known && tipsExact,
    /**
     * A composed conclusion — the UBI grade, the period verdict, an exported summary —
     * may claim exactness only when the period AND every input it folds is exact.
     */
    grade: periodExact && mileageWindowExact && monthlyTrendExact,
    exportExact: periodExact && mileageWindowExact,
  };
}

/**
 * One label for anything a gate withheld, so a partial figure is never silently absent.
 * "Nothing shown" and "nothing happened" must not look the same either.
 */
export function withheldCopy(what) {
  return `${what} needs the full period. Choose "Finish analysis" to complete the tally.`;
}

/**
 * ─── The three period-level dominant-risk outputs ──────────────────────────────────────
 *
 * AUD-003. `gates.tips` existed and the coaching tips obeyed it, but three other surfaces
 * named a dominant risk for the period without asking: the Recommended focus, the Risk
 * Events "Focus:" chip, and "Most common risk" with its "focus on improving this"
 * instruction. The page could therefore decline to name a leading risk in one section and
 * name one three sections later — an internal contradiction, and the terminal claim is the
 * false half.
 *
 * Each returns `{ text, terminal }`. `terminal` is the property under test: it is true
 * only when the copy is a settled whole-period statement, so a test can assert that no
 * surface makes one while the tally is partial, without rendering anything.
 */

/** O72's recommended focus. `terminalMessage` is the frozen ladder's answer. */
export function recommendedFocusCopy({ allowed, terminalMessage } = {}) {
  if (allowed) return { text: String(terminalMessage ?? ''), terminal: true };
  return {
    text: 'Still counting this period, so the leading risk is not settled yet. '
      + 'Choose "Finish analysis" for a recommended focus.',
    terminal: false,
  };
}

/** The Risk Events header chip. */
export function riskFocusChipCopy({ allowed, label } = {}) {
  const name = String(label ?? '');
  return allowed
    ? { text: `Focus: ${name}`, terminal: true }
    : { text: `Leading so far: ${name}`, terminal: false };
}

/** "Most common risk", and the instruction that follows from it. */
export function commonRiskCopy({ allowed, label } = {}) {
  const name = String(label ?? '');
  return allowed
    ? {
      text: `Most common risk: ${name}`,
      detail: 'Focus on improving this for a better score',
      terminal: true,
    }
    : {
      text: `Most common so far: ${name}`,
      detail: 'Counted so far only - the period has not finished totalling.',
      terminal: false,
    };
}
