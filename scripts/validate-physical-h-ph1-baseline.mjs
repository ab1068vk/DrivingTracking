#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const EXPECTED_PACKAGE_ID = 'com.drivesense.app.p35h';
const EXPECTED_PREFERENCE_XML = [
  "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>",
  '<map>',
  '    <string name="deadlines">{}</string>',
  '</map>',
].join('\n');
const EXPECTED_PREFERENCE_SHA256 =
  '57252e8e0ebaa04bd3cf361432ae85a26e25cd0962e5908b0a518acbca5459a9';

const ALLOWED_PATHS = new Set([
  '.',
  './cache',
  './code_cache',
  './app_dxmaker_cache',
  './shared_prefs',
  './shared_prefs/parking_photo_expiry.xml',
  './files',
  './files/profileInstalled',
]);

const REQUIRED_INVARIANTS = [
  'nativeArchiveOrDatabaseAbsent',
  'noBackupArchiveStateAbsent',
  'indexedDbOrWebViewProductStateAbsent',
  'tripHistoryFixtureDataAbsent',
  'roadSageKeystoreStateAbsent',
  'testAuthorityOff',
  'trackingServiceNotRunning',
];

function sha256Utf8(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeXml(value) {
  return String(value).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n$/, '');
}

export function validatePhysicalHPh1Baseline(snapshot) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { pass: false, errors: ['snapshot must be a JSON object'] };
  }
  if (snapshot.schemaVersion !== 1) fail('schemaVersion must equal 1');
  if (snapshot.phase !== 'PH-1') fail('phase must equal PH-1');
  if (snapshot.packageId !== EXPECTED_PACKAGE_ID) {
    fail(`packageId must equal ${EXPECTED_PACKAGE_ID}`);
  }

  const paths = snapshot.packageDataPaths;
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
    fail('packageDataPaths must be an array of strings');
  } else {
    const uniquePaths = new Set(paths);
    if (uniquePaths.size !== paths.length) fail('packageDataPaths must not contain duplicates');
    for (const path of uniquePaths) {
      if (!ALLOWED_PATHS.has(path)) fail(`unexpected package-data path: ${path}`);
    }
    for (const requiredPath of ALLOWED_PATHS) {
      if (!uniquePaths.has(requiredPath)) fail(`required baseline path missing: ${requiredPath}`);
    }
  }

  const residue = snapshot.knownBenignBaselineResidue;
  if (!residue || typeof residue !== 'object') {
    fail('knownBenignBaselineResidue must be present');
  } else {
    const profile = residue.profileInstalled;
    if (!profile || profile.path !== './files/profileInstalled') {
      fail('profileInstalled path must be ./files/profileInstalled');
    } else {
      if (profile.sizeBytes !== 24) fail('profileInstalled must be the 24-byte AndroidX cache record');
      if (!/^[0-9a-f]{64}$/i.test(profile.sha256 ?? '')) {
        fail('profileInstalled must have a recorded SHA-256');
      }
      if (profile.creator !== 'androidx.profileinstaller.ProfileVerifier') {
        fail('profileInstalled creator attribution must be AndroidX ProfileVerifier');
      }
      if (profile.profileInstallerVersion !== '1.4.0') {
        fail('profileInstalled must be attributed to resolved ProfileInstaller 1.4.0');
      }
      if (profile.installLogObserved !== true) {
        fail('ProfileInstaller installation log evidence must be observed');
      }
    }

    const preference = residue.parkingPhotoExpiry;
    if (!preference || preference.path !== './shared_prefs/parking_photo_expiry.xml') {
      fail('parkingPhotoExpiry path must be ./shared_prefs/parking_photo_expiry.xml');
    } else {
      const xml = normalizeXml(preference.exactXml ?? '');
      if (xml !== EXPECTED_PREFERENCE_XML) {
        fail('parking_photo_expiry.xml is not the exact expected empty deadlines structure');
      }
      const calculatedSha = sha256Utf8(`${xml}\n`);
      if (preference.sizeBytes !== 111) {
        fail('parking_photo_expiry.xml must be 111 bytes');
      }
      if ((preference.sha256 ?? '').toLowerCase() !== EXPECTED_PREFERENCE_SHA256) {
        fail('parking_photo_expiry.xml recorded SHA-256 does not match the expected empty file');
      }
      if (calculatedSha !== EXPECTED_PREFERENCE_SHA256) {
        fail('parking_photo_expiry.xml exactXml does not hash to the expected empty file');
      }
      if (preference.creator !== 'DriveSenseBootReceiver->ParkingPhotoExpiryScheduler.reconcile') {
        fail('parking_photo_expiry.xml creator attribution is missing or incorrect');
      }
      if (preference.trigger !== 'android.intent.action.MY_PACKAGE_REPLACED') {
        fail('parking_photo_expiry.xml trigger must be MY_PACKAGE_REPLACED');
      }
    }
  }

  const invariants = snapshot.invariants;
  if (!invariants || typeof invariants !== 'object') {
    fail('invariants must be present');
  } else {
    for (const invariant of REQUIRED_INVARIANTS) {
      if (invariants[invariant] !== true) fail(`required fail-closed invariant is not proven: ${invariant}`);
    }
    const unexpected = Object.keys(invariants).filter((key) => !REQUIRED_INVARIANTS.includes(key));
    if (unexpected.length > 0) fail(`unrecognized invariant fields: ${unexpected.join(', ')}`);
  }

  return { pass: errors.length === 0, errors };
}

function usage() {
  return 'Usage: node scripts/validate-physical-h-ph1-baseline.mjs <snapshot.json> | --self-test';
}

function makePassingFixture() {
  return {
    schemaVersion: 1,
    phase: 'PH-1',
    packageId: EXPECTED_PACKAGE_ID,
    packageDataPaths: [...ALLOWED_PATHS],
    knownBenignBaselineResidue: {
      profileInstalled: {
        path: './files/profileInstalled',
        sizeBytes: 24,
        sha256: '8ed37506a889b58c0d7449ff865b54a272bf1ccc6b99207fafe675cb4a20a95e',
        creator: 'androidx.profileinstaller.ProfileVerifier',
        profileInstallerVersion: '1.4.0',
        installLogObserved: true,
      },
      parkingPhotoExpiry: {
        path: './shared_prefs/parking_photo_expiry.xml',
        sizeBytes: 111,
        sha256: EXPECTED_PREFERENCE_SHA256,
        exactXml: `${EXPECTED_PREFERENCE_XML}\n`,
        creator: 'DriveSenseBootReceiver->ParkingPhotoExpiryScheduler.reconcile',
        trigger: 'android.intent.action.MY_PACKAGE_REPLACED',
      },
    },
    invariants: Object.fromEntries(REQUIRED_INVARIANTS.map((key) => [key, true])),
  };
}

function selfTest() {
  const passing = makePassingFixture();
  const cases = [
    ['reviewed baseline passes', passing, true],
    [
      'extra file fails',
      { ...passing, packageDataPaths: [...passing.packageDataPaths, './databases/road_sage.db'] },
      false,
    ],
    [
      'non-empty deadline fails',
      {
        ...passing,
        knownBenignBaselineResidue: {
          ...passing.knownBenignBaselineResidue,
          parkingPhotoExpiry: {
            ...passing.knownBenignBaselineResidue.parkingPhotoExpiry,
            exactXml: passing.knownBenignBaselineResidue.parkingPhotoExpiry.exactXml.replace(
              '{}',
              '{"00000000-0000-0000-0000-000000000000":1}',
            ),
          },
        },
      },
      false,
    ],
    [
      'missing absence proof fails',
      {
        ...passing,
        invariants: { ...passing.invariants, roadSageKeystoreStateAbsent: false },
      },
      false,
    ],
  ];

  for (const [name, fixture, expected] of cases) {
    const result = validatePhysicalHPh1Baseline(fixture);
    if (result.pass !== expected) {
      throw new Error(`${name}: expected pass=${expected}; got ${JSON.stringify(result)}`);
    }
  }
  console.log(`PASS: ${cases.length} PH-1 baseline validator cases`);
}

if (process.argv[1]?.endsWith('validate-physical-h-ph1-baseline.mjs')) {
  const argument = process.argv[2];
  if (argument === '--self-test') {
    selfTest();
  } else if (argument && process.argv.length === 3) {
    const snapshot = JSON.parse(readFileSync(argument, 'utf8'));
    const result = validatePhysicalHPh1Baseline(snapshot);
    if (!result.pass) {
      console.error('BLOCKED: PH-1 baseline validation failed');
      for (const error of result.errors) console.error(`- ${error}`);
      process.exitCode = 1;
    } else {
      console.log('PASS: PH-1 baseline contains only reviewed benign residue and all absence invariants hold');
    }
  } else {
    console.error(usage());
    process.exitCode = 2;
  }
}
