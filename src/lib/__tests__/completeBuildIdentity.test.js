import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeCompleteBuildIdentity, computeCompleteBuildIdentityFromEntries } from '../../../scripts/complete-build-identity.mjs';

describe('complete build identity', () => {
  const web = { path: 'src/main.jsx', content: 'same web bundle source' };

  it('changes when native packaged input changes even if web input is unchanged', () => {
    const first = computeCompleteBuildIdentityFromEntries([
      web,
      { path: 'android/app/src/main/java/App.java', content: 'native-v1' },
    ], { variantFamily: 'physical-h-enabled' });
    const second = computeCompleteBuildIdentityFromEntries([
      web,
      { path: 'android/app/src/main/java/App.java', content: 'native-v2' },
    ], { variantFamily: 'physical-h-enabled' });
    expect(first).not.toBe(second);
  });

  it('is deterministic across input ordering and separates variant families', () => {
    const entries = [web, { path: 'android/app/build.gradle', content: 'versionCode 3' }];
    const standard = computeCompleteBuildIdentityFromEntries(entries, { variantFamily: 'standard' });
    expect(computeCompleteBuildIdentityFromEntries([...entries].reverse(), { variantFamily: 'standard' })).toBe(standard);
    expect(computeCompleteBuildIdentityFromEntries(entries, { variantFamily: 'physical-h-enabled' })).not.toBe(standard);
  });

  it('separates packaged build configuration without exposing its private inputs', () => {
    const first = computeCompleteBuildIdentityFromEntries([web], { qualificationGate: 'private-build-input-a' });
    const second = computeCompleteBuildIdentityFromEntries([web], { qualificationGate: 'private-build-input-b' });
    expect(first).not.toBe(second);
    expect(first).not.toContain('private-build-input');
    expect(first).toMatch(/^sha256-packaged-inputs-v1:[a-f0-9]{64}$/);
  });

  it('ignores generated Android web copies so repeated builds do not feed back into their identity', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'roadsage-identity-test-'));
    try {
      const native = path.join(fixture, 'android/app/src/main/java');
      const webAssets = path.join(fixture, 'android/app/src/main/assets/public');
      await mkdir(native, { recursive: true });
      await mkdir(webAssets, { recursive: true });
      await writeFile(path.join(native, 'App.java'), 'native-input');
      await writeFile(path.join(webAssets, 'index.js'), 'previous-generated-bundle');
      const first = await computeCompleteBuildIdentity(fixture);
      await writeFile(path.join(webAssets, 'index.js'), 'new-generated-bundle-with-embedded-id');
      expect(await computeCompleteBuildIdentity(fixture)).toBe(first);
      await writeFile(path.join(native, 'App.java'), 'changed-native-input');
      const nativeChanged = await computeCompleteBuildIdentity(fixture);
      expect(nativeChanged).not.toBe(first);
      await writeFile(path.join(fixture, 'android/app/proguard-rules.pro'), '-keep class NativeArtifact');
      expect(await computeCompleteBuildIdentity(fixture)).not.toBe(nativeChanged);
    } finally {
      // fixture is the exact directory returned by mkdtemp, outside the repository.
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
