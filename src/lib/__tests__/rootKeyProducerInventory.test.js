/**
 * AUD-007 round 6 — the root-key producer inventory, enforced.
 *
 * Five rounds of this defect had the same shape: a producer nobody remembered to wrap.
 * Round 5's own handoff named three modules it had not covered, and CODEX found a real
 * canonical trip-write failure in exactly one of them. Patching each newly-found producer
 * is not convergence; it is the same round again with different coordinates.
 *
 * So the inventory itself is the artefact under test. Every production module that can
 * turn plaintext into root-key-bound ciphertext must appear below with an explicit
 * classification, and a module classified as a PRODUCER must reach the canonical
 * admission primitive. Adding a new durable encrypted producer without admission — or
 * adding one this table has never heard of — breaks here.
 *
 * This is deliberately not a substring search for a call: it enumerates the encrypting
 * modules from source, then requires each to be classified, so the failure mode it guards
 * is *omission* rather than spelling.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const LIB = resolve(process.cwd(), 'src/lib');
const CANONICAL_API = 'withDurableKeyPublication';

/** The primitives that turn plaintext into root-key-bound ciphertext. */
const ENCRYPTORS = /\b(encryptSensitiveValue|encryptSensitiveValues|setEncryptedJson)\s*\(/;

/**
 * The inventory. Every encrypting module resolves to exactly one classification.
 *
 *  PRODUCER             — calls a RAW encryptor and commits the result itself; must reach
 *                         the canonical admission API.
 *  COVERED_BY_PRIMITIVE — only publishes through `setEncryptedJson`, which holds admission
 *                         across its own capture-to-commit span. Such a module cannot
 *                         capture a version outside admission, and the guard below proves
 *                         it by requiring that it never touches a raw encryptor.
 *  NO_DURABLE_REFERENCE — encrypts but never persists the result; proven, not assumed.
 *  CRYPTO_LAYER         — the implementation of the primitives themselves.
 */
const INVENTORY = {
  'securePayloadCrypto.js': {
    class: 'CRYPTO_LAYER',
    why: 'Implements the encryptors. `setEncryptedJson` holds admission itself.',
  },
  'localTripRepository.js': {
    class: 'PRODUCER',
    why: 'Canonical trip and summary wrappers: create, update, chunked persist, retention '
      + 'repair, migration writes and the fallback document all share the encoders.',
  },
  'tripProjectionStore.js': {
    class: 'PUBLISHED_BY_CALLER',
    why: 'Encodes projection envelopes and returns the bytes; it performs no durable write '
      + 'at all. Owning a token here would release it the moment the bytes are handed back '
      + '- the exact escape the final invariant forbids - so the caller that commits owns '
      + 'the publication. Its callers are checked below.',
  },
  'browserActiveTripSpool.js': {
    class: 'PRODUCER',
    // `begin()` is synchronous and returns a session id, so its publication cannot be one
    // lexical callback: the token is opened when the wrapper is created and released by
    // `releaseInitialWrite()` once `begin()`'s first `persistManifest()` is durable. The
    // lifetime is therefore proven BEHAVIOURALLY (a parked wrapper makes deletion refuse)
    // rather than by the lexical commit check below. Named here so the exemption is
    // visible rather than silent.
    lifetimeProof: 'behavioural',
    proofTest: 'keyAdmissionOwnership.test.js > "refuses deletion while an initial spool '
      + 'wrapper is in flight"',
    why: 'The session DEK wrapper in the RSAS manifest, on the browser route authority.',
  },
  'p6TripDerivedState.js': {
    class: 'PRODUCER',
    why: 'Geometry chunks, analytics contributions and buckets, road observations, the '
      + 'affected-selection request and the spatial secret.',
  },
  'p6RoadMemoryState.js': {
    class: 'PRODUCER',
    why: 'Road reducer windows, outputs and observation payloads.',
  },
  'speedKnowledgeRepository.js': {
    class: 'PRODUCER',
    why: 'The legacy whole-model wrapper, stage-bucket partitions and the published root.',
  },
  'privacyZones.js': {
    class: 'PRODUCER',
    why: 'The native privacy-zone wrapper written to Preferences.',
  },
  'dangerZoneEngine.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'Danger-zone cache document. Publishes only through setEncryptedJson.',
  },
  'keyRotationManager.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'The rotation log and the encrypted-JSON sweep. Publishes only through setEncryptedJson.',
  },
  'mapMatching.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'Map-matching cache document. Publishes only through setEncryptedJson.',
  },
  'parkingDiagnostics.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'Parking diagnostics document. Publishes only through setEncryptedJson.',
  },
  'parkingHistory.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'Parking history and vehicle-state documents. Publishes only through setEncryptedJson.',
  },
  'privacyCellKey.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'The privacy cell key document. Publishes only through setEncryptedJson.',
  },
  'privacyIntelligence.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'Privacy score history and posture snapshots. Publishes only through setEncryptedJson.',
  },
  'privacyZoneSuggestions.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'Zone suggestion state and dismissals. Publishes only through setEncryptedJson.',
  },
  'routeRiskIndex.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'Route risk index document. Publishes only through setEncryptedJson.',
  },
  'speedGeometryIndex.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'Speed geometry index document. Publishes only through setEncryptedJson.',
  },
  'speedLimitSource.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'OSM speed-limit cache document. Publishes only through setEncryptedJson.',
  },
  'speedSignEvidence.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'Speed-sign evidence document. Publishes only through setEncryptedJson.',
  },
  'trackingStore.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'Active trip, last parked and related settings-adjacent documents. Publishes only through setEncryptedJson.',
  },
  'transmissionLog.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'Transmission log document. Publishes only through setEncryptedJson.',
  },
  'weatherContext.js': {
    class: 'COVERED_BY_PRIMITIVE',
    why: 'Open-Meteo weather cache document. Publishes only through setEncryptedJson.',
  },
  'controlSelfTests.js': {
    class: 'NO_DURABLE_REFERENCE',
    why: 'The storage-encryption self test encrypts a canary, decrypts it, compares it and '
      + 'drops it. The ciphertext is a local const and reaches no store.',
  },
};

const productionModules = () => readdirSync(LIB)
  .filter((name) => name.endsWith('.js'))
  .filter((name) => ENCRYPTORS.test(readFileSync(join(LIB, name), 'utf8')));

describe('AUD-007 root-key producer inventory', () => {
  it('classifies every module that can create root-key-bound ciphertext', () => {
    const unclassified = productionModules().filter((name) => !INVENTORY[name]);

    // A new encrypting module must be classified here before it can ship. If this fails,
    // the inventory is incomplete — which is the defect, not a test to relax.
    expect(unclassified).toEqual([]);
  });

  it('has no module classified as a known-but-unwrapped limitation', () => {
    const classes = Object.values(INVENTORY).map((entry) => entry.class);
    expect(classes).not.toContain('LIMITATION');
    expect(classes.every((value) => (
      ['PRODUCER', 'PUBLISHED_BY_CALLER', 'COVERED_BY_PRIMITIVE', 'NO_DURABLE_REFERENCE',
        'CRYPTO_LAYER'].includes(value)
    ))).toBe(true);
  });

  /**
   * Extract the body of every `withDurableKeyPublication(` callback by brace matching.
   * Crude on purpose — this is not a compiler, it is a structural coupling check.
   */
  const publicationBodies = (source) => {
    const bodies = [];
    const TOKEN = `${CANONICAL_API}(`;
    let from = source.indexOf(TOKEN);
    while (from !== -1) {
      let depth = 0;
      let index = from + TOKEN.length - 1;
      for (; index < source.length; index += 1) {
        const char = source[index];
        if (char === '(') depth += 1;
        else if (char === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      bodies.push(source.slice(from, index + 1));
      from = source.indexOf(TOKEN, index + 1);
    }
    return bodies;
  };

  /** What counts as an authoritative durable commit, not merely a queued request. */
  const COMMITS = /(idbTransactionDone|transactionDone|Preferences\.set|await setJson|await put\()/;

  /**
   * A publication may reach its commit through ONE named helper defined in the same
   * module (`return withDurableKeyPublication(() => stepInternal())`). That is still a
   * single awaited lifetime — the token is held until the helper resolves — so the check
   * follows one level of delegation rather than demanding the commit be inlined.
   *
   * One level only. This is a coupling check, not a call-graph analyser.
   */
  const reachesCommit = (source, body) => {
    if (COMMITS.test(body)) return true;
    const calls = [...body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]);
    return calls.some((name) => {
      const declaration = new RegExp(
        `(?:const|function)\\s+${name}\\s*(?:=\\s*(?:async\\s*)?\\(|\\()`,
      );
      const at = source.search(declaration);
      if (at < 0) return false;
      return COMMITS.test(source.slice(at, at + 4000));
    });
  };

  it('requires every producer to reach the canonical admission primitive', () => {
    const offenders = Object.entries(INVENTORY)
      .filter(([, entry]) => entry.class === 'PRODUCER')
      .filter(([name]) => !readFileSync(join(LIB, name), 'utf8').includes(CANONICAL_API))
      .map(([name]) => name);

    expect(offenders).toEqual([]);
  });

  /**
   * The R6 guard proved the API was PRESENT and stayed green while the architecture was
   * still wrong: the token wrapped the encoder and was released before the durable
   * transaction. Presence is not lifetime. Every producer must own at least one
   * publication whose callback reaches an authoritative COMMIT — not a queued `put()`,
   * not "bytes returned".
   */
  it('requires every producer to hold admission through an actual durable commit', () => {
    const offenders = Object.entries(INVENTORY)
      .filter(([, entry]) => entry.class === 'PRODUCER')
      .filter(([, entry]) => entry.lifetimeProof !== 'behavioural')
      .filter(([name]) => {
        const source = readFileSync(join(LIB, name), 'utf8');
        const bodies = publicationBodies(source);
        return !bodies.some((body) => reachesCommit(source, body));
      })
      .map(([name]) => name);

    expect(offenders).toEqual([]);
  });

  /**
   * And the specific escape CODEX proved: a publication whose callback encrypts but never
   * commits is the `encrypt -> release -> commit later` shape. Every publication that
   * encrypts must also commit inside the same callback.
   */
  it('never opens a publication that encrypts without committing', () => {
    const ENCRYPTS = /\b(encryptSensitiveValue|encryptSensitiveValues)\s*\(/;
    const offenders = [];
    for (const [name, entry] of Object.entries(INVENTORY)) {
      if (entry.class !== 'PRODUCER') continue;
      if (entry.lifetimeProof === 'behavioural') continue;
      const source = readFileSync(join(LIB, name), 'utf8');
      publicationBodies(source).forEach((body, index) => {
        if (ENCRYPTS.test(body) && !reachesCommit(source, body)) {
          offenders.push(`${name}#${index}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * ─── The call-site rule ────────────────────────────────────────────────────────────
   *
   * AUD-007 REDESIGN. Every rule above asks a question about the MODULE: does it contain
   * the API, does SOME publication in it reach a commit. CODEX falsified the architecture
   * twice by adding persistent writes to a module whose other functions were correct —
   * `runLegacyBrowserRawGpsRetention()` and `writeTripSummariesToDb()` — and this guard
   * stayed green both times. Asking module-level questions IS the process failure.
   *
   * This rule is per CALL SITE. Every place a producer turns plaintext into root-key-bound
   * ciphertext must be covered by one of four things and nothing else:
   *
   *   (a) it sits lexically inside a `withDurableKeyPublication` callback;
   *   (b) it sits in a named helper that such a callback calls in the same module — one
   *       delegate level, because that is still one awaited lifetime;
   *   (c) it sits in a function that demands the capability with
   *       `assertDurablePublication`, so it cannot run without a live publication at all;
   *   (d) it sits in a registered `rewrapStep`, which `stepBrowserKeyRewrap` admits for
   *       every domain in one place. That delegation crosses a module boundary, so it is
   *       proven by its own test below rather than assumed here.
   */
  const BLANK = (match) => match.replace(/[^\n]/g, ' ');

  /** Blank comments in place: prose about `encryptSensitiveValue()` is not a call site. */
  const stripComments = (raw) => raw
    .replace(/\/\*[\s\S]*?\*\//g, BLANK)
    .replace(/(^|\n)([ \t]*\/\/[^\n]*)/g, (match, head, body) => head + BLANK(body));

  /**
   * Calls that produce durable root-key-bound bytes. `setEncryptedJson` is deliberately
   * excluded: it is itself an admitted capture-to-commit primitive, not a raw encryption.
   */
  const PERSISTENT_ENCRYPT = /\b(encodeTripRecord|encodeTripSummaryRecord|encodeTripRecords|encodeTripSummaryRecords|encodeProjectionPayloads|encryptSensitiveValue|encryptSensitiveValues)\s*\(/g;
  /** A FUNCTION declaration, not any `const`: the owner of a call site is the nearest
   *  enclosing function, and `const bytes = await encrypt...` is not one. */
  const DECLARATION = /(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)|(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/g;

  /** Byte spans of every `withDurableKeyPublication(...)` call, arguments included. */
  const publicationSpans = (source) => {
    const spans = [];
    const TOKEN = `${CANONICAL_API}(`;
    let from = source.indexOf(TOKEN);
    while (from !== -1) {
      let depth = 0;
      let index = from + TOKEN.length - 1;
      for (; index < source.length; index += 1) {
        const char = source[index];
        if (char === '(') depth += 1;
        else if (char === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      spans.push([from, index]);
      from = source.indexOf(TOKEN, index + 1);
    }
    return spans;
  };

  const unadmittedCallSites = (raw) => {
    const source = stripComments(raw);
    const spans = publicationSpans(source);
    // The owner of a call site is its nearest enclosing TOP-LEVEL function. Resolving to
    // the nearest declaration of any kind picks up inner arrows (`const selected = ...`)
    // and loses the name the delegate and capability clauses have to reason about, so
    // only declarations at the file's outermost indentation count as owners.
    const all = [...source.matchAll(DECLARATION)].map((match) => ({
      at: match.index,
      name: match[1] || match[2],
      indent: /\n([ \t]*)\S/.exec(match[0])?.[1].length ?? 0,
    }));
    const outermost = all.length ? Math.min(...all.map((entry) => entry.indent)) : 0;
    const declarations = all.filter((entry) => entry.indent === outermost);
    const registration = /rewrapStep:[\s\S]*?\n\s{0,4}\}/.exec(source);
    const offenders = [];
    for (const match of source.matchAll(PERSISTENT_ENCRYPT)) {
      const at = match.index;
      // Declaring one of these functions is not calling it.
      if (/(function|const)\s+$/.test(source.slice(Math.max(0, at - 24), at))) continue;
      if (spans.some(([start, end]) => at > start && at < end)) continue;                 // (a)
      const owner = declarations.filter((entry) => entry.at < at).pop()
        || { at: 0, name: '__module__' };
      if (source.slice(owner.at, at).includes('assertDurablePublication(')) continue;     // (c)
      const called = new RegExp(`\\b${owner.name}\\s*\\(`);
      if (spans.some(([start, end]) => called.test(source.slice(start, end)))) continue;  // (b)
      if (registration && called.test(registration[0])) continue;                         // (d)
      offenders.push(`${owner.name}@${source.slice(0, at).split('\n').length}`);
    }
    return offenders;
  };

  /**
   * The rule's own discrimination, proven on synthetic sources rather than by damaging
   * production code. A guard that cannot fail is the R6 failure repeating: this pins the
   * exact shapes it must accept and reject, including the one nobody had written yet — a
   * new persistent writer added to a module that already contains correct publications.
   */
  it('catches a new unadmitted writer added beside correct ones', () => {
    const correct = `
      const publishOne = async (row) => withDurableKeyPublication(async (publication) => {
        const bytes = await encryptSensitiveValue(row, 'ctx');
        const tx = db.transaction('rows', 'readwrite');
        tx.objectStore('rows').put(bytes);
        await idbTransactionDone(tx);
      });
    `;
    expect(unadmittedCallSites(correct)).toEqual([]);

    // The CODEX shape, bolted onto the same module: encrypt, then commit, no publication.
    const withBypass = `${correct}
      const backfillRows = async (rows) => {
        const bytes = await encryptSensitiveValues(rows);
        const tx = db.transaction('rows', 'readwrite');
        bytes.forEach((value) => tx.objectStore('rows').put(value));
        await idbTransactionDone(tx);
      };
    `;
    expect(unadmittedCallSites(withBypass)).toEqual([expect.stringContaining('backfillRows')]);

    // Prose is not a call site, and a delegate of a publication is admitted.
    const commented = `
      // encryptSensitiveValue(row, 'ctx') is what the old code did here.
      const step = async () => withDurableKeyPublication(async () => helper());
      const helper = async () => {
        const bytes = await encryptSensitiveValue(1, 'ctx');
        await idbTransactionDone(bytes);
      };
    `;
    expect(unadmittedCallSites(commented)).toEqual([]);
  });

  it('admits every persistent encryption call site, not merely every module', () => {
    const offenders = {};
    for (const [name, entry] of Object.entries(INVENTORY)) {
      // CRYPTO_LAYER implements the encryptors, so it cannot be inside one.
      // NO_DURABLE_REFERENCE produces no durable reference at all, and that claim is not
      // taken on trust either — it has its own test below.
      if (entry.class === 'CRYPTO_LAYER' || entry.class === 'NO_DURABLE_REFERENCE') continue;
      const found = unadmittedCallSites(readFileSync(join(LIB, name), 'utf8'));
      if (found.length) offenders[name] = found;
    }

    // One correct publication elsewhere in the file buys a module nothing here.
    expect(offenders).toEqual({});
  });

  /**
   * Clause (d) crosses a module boundary, so it is proven rather than trusted: every
   * domain's registered rewrap step is invoked from inside a publication, in one place.
   */
  it('admits every registered rewrap step from one publication', () => {
    const source = stripComments(readFileSync(join(LIB, 'browserKeyReferences.js'), 'utf8'));
    const calls = [...source.matchAll(/domain\.rewrapStep\s*\(/g)].map((match) => match.index);
    expect(calls.length).toBeGreaterThan(0);
    const spans = publicationSpans(source);
    const outside = calls.filter((at) => !spans.some(([start, end]) => at > start && at < end));
    expect(outside).toEqual([]);
  });

  /**
   * The capability itself. The canonical trip/summary/projection encoders must DEMAND a
   * live publication, so a future persistent writer has nothing to pass if it forgets to
   * admit. This is the part of the redesign that makes the bypass unwritable rather than
   * merely detectable afterwards.
   */
  it('makes the canonical persistent encoders demand the capability', () => {
    const repository = readFileSync(join(LIB, 'localTripRepository.js'), 'utf8');
    const projections = readFileSync(join(LIB, 'tripProjectionStore.js'), 'utf8');
    const ungated = [
      'encodeTripRecord', 'encodeTripSummaryRecord',
      'encodeTripRecords', 'encodeTripSummaryRecords',
    ].filter((name) => !repository.includes(`assertDurablePublication(publication, '${name}')`));

    expect(ungated).toEqual([]);
    expect(projections).toContain("assertDurablePublication(publication, 'encodeProjectionPayloads')");
  });

  it('keeps the inventory honest about modules that no longer encrypt', () => {
    const encrypting = new Set(productionModules());
    const stale = Object.entries(INVENTORY)
      .filter(([, entry]) => entry.class !== 'CRYPTO_LAYER')
      .map(([name]) => name)
      .filter((name) => !encrypting.has(name));

    // A module listed here that no longer encrypts is dead inventory: it makes the table
    // look more complete than it is.
    expect(stale).toEqual([]);
  });

  it('requires every behavioural lifetime exemption to cite a real test', () => {
    const exempt = Object.entries(INVENTORY)
      .filter(([, entry]) => entry.lifetimeProof === 'behavioural');
    // The exemption exists because a synchronous entry point cannot be one lexical
    // callback. It must still name the test that proves the lifetime, or it is just an
    // unwrapped producer with better paperwork.
    expect(exempt.length).toBeGreaterThan(0);
    for (const [, entry] of exempt) {
      expect(typeof entry.proofTest).toBe('string');
      expect(entry.proofTest.length).toBeGreaterThan(20);
    }
  });

  it('gives every classification a stated reason', () => {
    const missing = Object.entries(INVENTORY)
      .filter(([, entry]) => !entry.why || entry.why.length < 20)
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('holds COVERED_BY_PRIMITIVE modules to that claim', () => {
    // The claim is "this module never captures a version outside admission", and it is
    // only true while the module stays away from the raw encryptors. A module that starts
    // calling one has become a producer and must be reclassified and wrapped.
    const RAW = /\b(encryptSensitiveValue|encryptSensitiveValues)\s*\(/;
    const offenders = Object.entries(INVENTORY)
      .filter(([, entry]) => entry.class === 'COVERED_BY_PRIMITIVE')
      .filter(([name]) => RAW.test(readFileSync(join(LIB, name), 'utf8')))
      .map(([name]) => name);

    expect(offenders).toEqual([]);
  });

  it('holds PUBLISHED_BY_CALLER to its claim, and checks its callers', () => {
    const projection = readFileSync(join(LIB, 'tripProjectionStore.js'), 'utf8');
    // It must not durably write anything itself.
    expect(projection).not.toMatch(/idbTransactionDone|await setJson|Preferences\.set/);

    // Every call of its encoder must sit inside a publication that commits.
    const repository = readFileSync(join(LIB, 'localTripRepository.js'), 'utf8');
    const bodies = publicationBodies(repository).filter((body) => COMMITS.test(body));
    const callSites = [...repository.matchAll(/encodeProjectionPayloads\(/g)].map((m) => m.index);
    expect(callSites.length).toBeGreaterThan(0);
    const uncovered = callSites.filter((index) => {
      const call = repository.slice(index, index + 30);
      return !bodies.some((body) => body.includes(call));
    });
    expect(uncovered).toEqual([]);
  });

  it('proves the self-test canary never reaches a store', () => {
    const source = readFileSync(join(LIB, 'controlSelfTests.js'), 'utf8');
    const start = source.indexOf('selfTestStorageEncryption');
    const body = source.slice(start, source.indexOf('export const', start + 10));

    // It encrypts, decrypts and compares. Nothing in that span writes anywhere.
    expect(body).toMatch(/encryptSensitiveValue\(canary/);
    expect(body).toMatch(/decryptSensitiveValue\(/);
    expect(body).not.toMatch(/setJson|put\(|Preferences\.set|setItem|setEncryptedJson/);
  });
});
