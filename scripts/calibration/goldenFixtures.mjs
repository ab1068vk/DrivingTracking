import fs from 'node:fs/promises';
import path from 'node:path';
import { goldenFixtureDir } from './paths.mjs';
import { readCurrentScoringVersion } from './currentConstants.mjs';

const SCORE_TOLERANCE_POINTS = 2;

const SCORE_KEYS = [
  'score_overall',
  'score_safety',
  'score_smoothness',
  'score_eco',
  'harsh_brakes_count',
  'rapid_accel_count',
  'sharp_turns_count',
  'speeding_events_count',
  'speed_creep_score',
  'aggressive_driving_score',
  'defensive_driving_score',
];

async function readFixtureFiles() {
  const entries = await fs.readdir(goldenFixtureDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(goldenFixtureDir, entry.name))
    .sort();
}

async function readFixture(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function relativeFixturePath(filePath) {
  return path.join('src', 'lib', '__tests__', 'goldenFixtures', path.basename(filePath));
}

function createFailure(file, key, expected, actual, delta = Number.POSITIVE_INFINITY) {
  return { file, key, expected, actual, delta };
}

function validateFixtureContract(fixture, file, scoringVersion) {
  const failures = [];
  if (fixture.scoring_version !== scoringVersion) {
    failures.push(createFailure(file, 'scoring_version', scoringVersion, fixture.scoring_version));
  }
  if (fixture.expected?.score_provenance?.scoring_version !== scoringVersion) {
    failures.push(createFailure(
      file,
      'expected.score_provenance.scoring_version',
      scoringVersion,
      fixture.expected?.score_provenance?.scoring_version
    ));
  }
  if (fixture.human_verified !== true) {
    failures.push(createFailure(file, 'human_verified', true, fixture.human_verified));
  }
  return failures;
}

function validateScoreEnvelope(fixture, file) {
  const scores = fixture.expected?.scores || {};
  return SCORE_KEYS.flatMap((key) => {
    const value = scores[key];
    if (value == null) return [];
    if (!Number.isFinite(value)) {
      return [createFailure(file, key, 'finite golden score', value)];
    }
    if (key.endsWith('_count')) return [];
    if (value < -SCORE_TOLERANCE_POINTS || value > 100 + SCORE_TOLERANCE_POINTS) {
      const delta = value < 0 ? Math.abs(value) : Math.abs(value - 100);
      return [createFailure(file, key, 'score within 0-100 envelope', value, delta)];
    }
    return [];
  });
}

export async function validateGoldenFixtures() {
  const scoringVersion = await readCurrentScoringVersion();
  const fixtureFiles = await readFixtureFiles();
  const failures = [];

  for (const fixtureFile of fixtureFiles) {
    const fixture = await readFixture(fixtureFile);
    const file = relativeFixturePath(fixtureFile);
    failures.push(...validateFixtureContract(fixture, file, scoringVersion));
    failures.push(...validateScoreEnvelope(fixture, file));
  }

  return {
    checks: fixtureFiles.map((file) => ({
      file: relativeFixturePath(file),
      key: 'golden_fixture_contract',
      passed: failures.every((failure) => failure.file !== relativeFixturePath(file)),
    })),
    failures,
  };
}
