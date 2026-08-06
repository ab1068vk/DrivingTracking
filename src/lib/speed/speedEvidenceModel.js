/**
 * How a learned cell accumulates evidence — and how it changes its mind.
 *
 * The old model was a single `limitKmh` plus a counter, updated by three
 * branches: create, agree, disagree. The disagree branch decayed confidence but
 * **never reassigned `limitKmh`**, so once a cell had learned 50 it could never
 * converge on a real change to 60 no matter how many trips disagreed. It also
 * incremented `evidenceCount` on disagreement, which fed a corroboration bonus
 * downstream — contradiction partly *raised* confidence.
 *
 * A cell now holds a bounded, ordered vote history. The effective limit is the
 * plurality of the recent window, so a genuine limit change converges. The
 * confidence is a Wilson lower bound on the agreement ratio, so contradiction
 * can only ever lower it. Switching requires a real majority rather than one
 * dissenting trip, which is what keeps the cell from flapping.
 */

/** Votes retained per cell. Older ones age out so a change can win eventually. */
export const MAX_LIMIT_VOTES = 24;

/** A new limit needs this many votes before it can take over. */
export const MIN_VOTES_TO_SWITCH = 3;

/** Votes older than this stop counting; a limit from years ago is not evidence. */
export const VOTE_WINDOW_MS = 400 * 86400000;

/** Ceiling on learned confidence — a learned limit is never as good as a posted one. */
export const MAX_LEARNED_CONFIDENCE = 0.85;

/** Maps a Wilson score onto the confidence range learned cells are scored on. */
const CONFIDENCE_BASE = 0.35;
const CONFIDENCE_SPAN = 0.60;

const Z = 1.96;

const finiteMs = (value) => {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Lower bound of the Wilson score interval.
 *
 * Chosen over a raw ratio because it accounts for sample size: 3 out of 3
 * agreeing is genuinely weaker evidence than 20 out of 20, and a plain ratio
 * calls both of them 1.0.
 */
export function wilsonLowerBound(successes, total, z = Z) {
  const n = Number(total);
  const k = Number(successes);
  if (!Number.isFinite(n) || !Number.isFinite(k) || n <= 0 || k < 0) return 0;
  const p = Math.min(1, Math.max(0, k / n));
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, Math.min(1, (centre - margin) / denominator));
}

export function confidenceFromAgreement(agreeingVotes, totalVotes) {
  const wilson = wilsonLowerBound(agreeingVotes, totalVotes);
  return Math.max(0, Math.min(MAX_LEARNED_CONFIDENCE, CONFIDENCE_BASE + CONFIDENCE_SPAN * wilson));
}

export function normalizeLimitVotes(votes = [], nowMs = Date.now()) {
  return (Array.isArray(votes) ? votes : [])
    .map((vote) => ({
      limitKmh: Math.round(Number(vote?.limitKmh)),
      at: finiteMs(vote?.at),
      evidenceId: vote?.evidenceId == null ? null : String(vote.evidenceId),
    }))
    .filter((vote) => (
      Number.isFinite(vote.limitKmh) &&
      vote.limitKmh > 0 &&
      vote.at != null &&
      nowMs - vote.at <= VOTE_WINDOW_MS
    ))
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_LIMIT_VOTES);
}

/**
 * A pre-vote-history cell reconstructed as votes, so an existing install keeps
 * its accumulated evidence instead of restarting from zero on upgrade.
 */
export function limitVotesFromLegacyCell(cell = {}, nowMs = Date.now()) {
  const limitKmh = Math.round(Number(cell?.limitKmh));
  if (!Number.isFinite(limitKmh) || limitKmh <= 0) return [];
  const count = Math.max(1, Math.min(
    MAX_LIMIT_VOTES,
    Math.round(Number(cell.tripCount ?? cell.evidenceCount) || 1)
  ));
  const lastAt = finiteMs(cell.lastUpdatedAt ?? cell.verifiedAt) ?? nowMs;
  const firstAt = finiteMs(cell.firstSeenAt) ?? lastAt;
  const step = count > 1 ? (lastAt - firstAt) / (count - 1) : 0;
  return Array.from({ length: count }, (_, index) => ({
    limitKmh,
    at: Math.round(firstAt + step * index),
    evidenceId: null,
  }));
}

export function appendLimitVote(votes = [], vote = {}, nowMs = Date.now()) {
  return normalizeLimitVotes([...(Array.isArray(votes) ? votes : []), {
    limitKmh: vote.limitKmh,
    at: vote.at ?? nowMs,
    evidenceId: vote.evidenceId ?? null,
  }], nowMs);
}

/**
 * Resolve a vote history into an effective limit and a confidence.
 *
 * @param {Array<{limitKmh: number, at: number}>} votes
 * @param {{incumbentLimitKmh?: number|null, nowMs?: number}} [options]
 */
export function summarizeLimitVotes(votes = [], options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const active = normalizeLimitVotes(votes, nowMs);
  const incumbent = Number.isFinite(Number(options.incumbentLimitKmh))
    ? Math.round(Number(options.incumbentLimitKmh))
    : null;

  if (!active.length) {
    return {
      limitKmh: incumbent,
      votes: active,
      totalVotes: 0,
      agreeingVotes: 0,
      agreementRatio: 0,
      confidence: 0,
      changed: false,
      previousLimitKmh: incumbent,
      pendingLimitKmh: null,
      pendingVotes: 0,
    };
  }

  const counts = new Map();
  const lastSeen = new Map();
  for (const vote of active) {
    counts.set(vote.limitKmh, (counts.get(vote.limitKmh) || 0) + 1);
    lastSeen.set(vote.limitKmh, Math.max(lastSeen.get(vote.limitKmh) ?? 0, vote.at));
  }

  // Highest count wins; a tie goes to whichever limit was seen most recently.
  const [leaderLimit, leaderCount] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (lastSeen.get(b[0]) ?? 0) - (lastSeen.get(a[0]) ?? 0))[0];

  const incumbentCount = incumbent == null ? 0 : (counts.get(incumbent) || 0);
  const incumbentStillKnown = incumbent != null && incumbentCount > 0;

  // Switching needs a genuine majority, not one dissenting trip: enough votes to
  // stand on its own AND strictly more than the limit it would replace.
  const canSwitch = leaderLimit !== incumbent &&
    leaderCount >= MIN_VOTES_TO_SWITCH &&
    leaderCount > incumbentCount;
  const effectiveLimitKmh = (!incumbentStillKnown || canSwitch) ? leaderLimit : incumbent;

  const totalVotes = active.length;
  const agreeingVotes = counts.get(effectiveLimitKmh) || 0;

  // The strongest limit that is *not* the one in effect — whether it lost on
  // count or was blocked by the switch threshold. This is what a change-review
  // prompt shows the user, so it must not be hidden just because the incumbent
  // happens to still be leading.
  const [rivalLimit, rivalCount] = [...counts.entries()]
    .filter(([limit]) => limit !== effectiveLimitKmh)
    .sort((a, b) => b[1] - a[1] || (lastSeen.get(b[0]) ?? 0) - (lastSeen.get(a[0]) ?? 0))[0] ?? [null, 0];

  return {
    limitKmh: effectiveLimitKmh,
    votes: active,
    totalVotes,
    agreeingVotes,
    agreementRatio: totalVotes ? agreeingVotes / totalVotes : 0,
    confidence: confidenceFromAgreement(agreeingVotes, totalVotes),
    changed: incumbent != null && effectiveLimitKmh !== incumbent,
    previousLimitKmh: incumbent,
    leaderLimitKmh: leaderLimit,
    leaderVotes: leaderCount,
    pendingLimitKmh: rivalLimit,
    pendingVotes: rivalCount,
  };
}
