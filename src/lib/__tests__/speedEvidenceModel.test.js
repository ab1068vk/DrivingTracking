import { describe, expect, it } from 'vitest';

import { LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';
import { speedKnowledgeCellEligibility } from '@/lib/speedKnowledgeCellPolicy';
import {
  MAX_LIMIT_VOTES,
  MIN_VOTES_TO_SWITCH,
  appendLimitVote,
  confidenceFromAgreement,
  limitVotesFromLegacyCell,
  summarizeLimitVotes,
  wilsonLowerBound,
} from '@/lib/speed/speedEvidenceModel';

const DAY_MS = 86400000;
const votesOf = (limits, startMs = Date.UTC(2026, 0, 1)) => limits.map((limitKmh, index) => ({
  limitKmh,
  at: startMs + index * DAY_MS,
}));

describe('wilson lower bound', () => {
  it('rewards sample size, not just ratio', () => {
    // A plain ratio calls both of these 1.0.
    expect(wilsonLowerBound(3, 3)).toBeLessThan(wilsonLowerBound(20, 20));
    expect(wilsonLowerBound(0, 5)).toBe(0);
  });

  it('is monotonic in agreement at a fixed sample size', () => {
    let previous = -1;
    for (let successes = 0; successes <= 10; successes += 1) {
      const value = wilsonLowerBound(successes, 10);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('caps learned confidence below posted confidence', () => {
    expect(confidenceFromAgreement(100, 100)).toBeLessThanOrEqual(0.85);
  });
});

describe('summarizeLimitVotes', () => {
  it('converges on a real limit change once it earns a majority', () => {
    const incumbentLimitKmh = 50;

    // Two dissenting trips are not enough to move a settled limit.
    const early = summarizeLimitVotes(votesOf([50, 50, 50, 60, 60]), { incumbentLimitKmh });
    expect(early.limitKmh).toBe(50);
    expect(early.pendingLimitKmh).toBe(60);

    // A genuine majority is.
    const converged = summarizeLimitVotes(votesOf([50, 50, 50, 60, 60, 60, 60]), { incumbentLimitKmh });
    expect(converged.limitKmh).toBe(60);
    expect(converged.changed).toBe(true);
    expect(converged.previousLimitKmh).toBe(50);
  });

  it('needs at least MIN_VOTES_TO_SWITCH before switching at all', () => {
    expect(MIN_VOTES_TO_SWITCH).toBe(3);
    // The rival leads on count but has too few votes to stand on its own, so
    // the settled limit holds and the rival is reported as pending instead.
    const summary = summarizeLimitVotes(votesOf([50, 60, 60]), { incumbentLimitKmh: 50 });
    expect(summary.limitKmh).toBe(50);
    expect(summary.pendingLimitKmh).toBe(60);

    // One more vote clears the threshold and outnumbers the incumbent.
    const switched = summarizeLimitVotes(votesOf([50, 60, 60, 60]), { incumbentLimitKmh: 50 });
    expect(switched.limitKmh).toBe(60);
  });

  it('lowers confidence when evidence disagrees and never raises it', () => {
    const agreeing = summarizeLimitVotes(votesOf([50, 50, 50, 50]), { incumbentLimitKmh: 50 });
    const contradicted = summarizeLimitVotes(votesOf([50, 50, 50, 50, 60]), { incumbentLimitKmh: 50 });
    expect(contradicted.confidence).toBeLessThan(agreeing.confidence);
    expect(contradicted.agreementRatio).toBeLessThan(1);
  });

  it('drops votes outside the retention window', () => {
    const ancient = [{ limitKmh: 50, at: Date.now() - 500 * DAY_MS }];
    expect(summarizeLimitVotes(ancient, { incumbentLimitKmh: 50 }).totalVotes).toBe(0);
  });

  it('keeps the history bounded', () => {
    let votes = [];
    for (let i = 0; i < MAX_LIMIT_VOTES * 3; i += 1) {
      votes = appendLimitVote(votes, { limitKmh: 50, at: Date.now() - i * 1000 });
    }
    expect(votes.length).toBeLessThanOrEqual(MAX_LIMIT_VOTES);
  });

  it('reconstructs votes for a cell saved before the vote history existed', () => {
    const legacy = {
      limitKmh: 50,
      tripCount: 4,
      firstSeenAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      lastUpdatedAt: new Date(Date.UTC(2026, 0, 10)).toISOString(),
    };
    const votes = limitVotesFromLegacyCell(legacy, Date.UTC(2026, 0, 11));
    expect(votes).toHaveLength(4);
    expect(votes.every((vote) => vote.limitKmh === 50)).toBe(true);
    expect(summarizeLimitVotes(votes, { incumbentLimitKmh: 50, nowMs: Date.UTC(2026, 0, 11) }).limitKmh).toBe(50);
  });
});

describe('learned cells re-converge end to end', () => {
  const cellPoint = { lat: 43.6532, lng: -79.3842 };

  function knowledgeStore() {
    const values = new Map();
    return {
      get: async (key, fallback) => values.get(key) ?? fallback,
      set: async (key, value) => { values.set(key, value); },
    };
  }

  const learn = (knowledge, limitKmh, evidenceId) => knowledge.learnFromTrip(
    [{
      ...cellPoint,
      limitKmh,
      speed_limit_kmh: limitKmh,
      speed_limit_source: 'user_confirmed_posted_sign',
      source: 'user_confirmed_posted_sign',
      timestamp: new Date().toISOString(),
    }],
    [],
    { tripId: evidenceId }
  );

  it('flips a learned cell after the road really changes from 50 to 60', async () => {
    const knowledge = new LocalSpeedKnowledge(knowledgeStore());

    for (let trip = 0; trip < 4; trip += 1) {
      await learn(knowledge, 50, `old-${trip}`);
    }
    const settled = await knowledge.getForPoint(cellPoint.lat, cellPoint.lng, Date.now());
    expect(settled?.limitKmh).toBe(50);
    expect(speedKnowledgeCellEligibility(await cellFor(knowledge)).eligible).toBe(true);

    // The limit changes on the ground. Under the previous model this cell was
    // stuck on 50 permanently: the disagreement branch decayed confidence but
    // never reassigned limitKmh, so no amount of new evidence could move it.
    for (let trip = 0; trip < 6; trip += 1) {
      await learn(knowledge, 60, `new-${trip}`);
    }

    // Mid-transition the cell has already converged internally, but the split
    // evidence has pushed its confidence below the eligibility floor — so it
    // reports nothing rather than asserting a limit it is no longer sure of.
    const transitioning = await cellFor(knowledge);
    expect(transitioning.limitKmh).toBe(60);
    expect(await knowledge.getForPoint(cellPoint.lat, cellPoint.lng, Date.now())).toBeNull();

    // Once the new limit is corroborated, the cell is usable again — at 60.
    for (let trip = 6; trip < 14; trip += 1) {
      await learn(knowledge, 60, `new-${trip}`);
    }
    const resolved = await knowledge.getForPoint(cellPoint.lat, cellPoint.lng, Date.now());
    expect(resolved?.limitKmh).toBe(60);
  });

  it('does not flip on a single contradicting trip', async () => {
    const knowledge = new LocalSpeedKnowledge(knowledgeStore());
    for (let trip = 0; trip < 5; trip += 1) {
      await learn(knowledge, 50, `old-${trip}`);
    }
    await learn(knowledge, 60, 'one-off');

    const resolved = await knowledge.getForPoint(cellPoint.lat, cellPoint.lng, Date.now());
    expect(resolved?.limitKmh).toBe(50);
  });

  it('raises a conflict for review when a contradiction is large', async () => {
    const knowledge = new LocalSpeedKnowledge(knowledgeStore());
    for (let trip = 0; trip < 5; trip += 1) {
      await learn(knowledge, 50, `old-${trip}`);
    }
    await learn(knowledge, 90, 'way-off');

    const cell = await cellFor(knowledge);
    expect(cell.limitKmh).toBe(50);
    expect(cell.conflict).toBe(true);
    expect(cell.conflictDetails).toMatchObject({ existingLimitKmh: 50, newLimitKmh: 90 });
    // A conflicted cell stops driving alerts and scores until it is resolved.
    expect(await knowledge.getForPoint(cellPoint.lat, cellPoint.lng, Date.now())).toBeNull();
  });

  it('does not let repeated contradiction raise confidence', async () => {
    const knowledge = new LocalSpeedKnowledge(knowledgeStore());
    for (let trip = 0; trip < 4; trip += 1) {
      await learn(knowledge, 50, `old-${trip}`);
    }
    const before = (await cellFor(knowledge)).confidence;

    // Three contradicting trips used to push evidenceCount past the
    // corroboration threshold and add 0.05 to the cell's confidence.
    for (let trip = 0; trip < 3; trip += 1) {
      await learn(knowledge, 80, `contradiction-${trip}`);
    }
    const after = (await cellFor(knowledge)).confidence;
    expect(after).toBeLessThan(before);
  });

  async function cellFor(knowledge) {
    const data = await knowledge.exportData();
    return Object.values(data.cells)[0];
  }
});
