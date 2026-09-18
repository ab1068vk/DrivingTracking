import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAppExperienceReport } from '@/lib/appExperienceDiagnostics';
import { setCurrentDiagnosticsBuildIdentity } from '@/lib/diagnosticsIdentity';

/**
 * A physical qualification run has to be attributable to one installed binary. That breaks the
 * moment a product surface states a version the APK does not carry, so these pin the rule that
 * the Android product version comes from the native build and never from a constant.
 */
const repoRoot = process.cwd();
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

describe('app version identity', () => {
  it('does not hardcode a product version in the Settings About card', () => {
    const settings = read('src/pages/Settings.jsx');
    // The literal this replaced claimed "Version 1.0.0 (Capacitor Android)" on a 1.1.0 build.
    expect(settings).not.toMatch(/Version \d+\.\d+\.\d+ \(Capacitor/);
    expect(settings).toContain('getCurrentDiagnosticsBuildMetadata');
  });

  it('derives the Settings version label from the native build, not an env fallback', () => {
    const settings = read('src/pages/Settings.jsx');
    const label = settings.slice(settings.indexOf('const appVersionLabel'));
    expect(label).toContain('nativeBuildMetadata?.versionName');
    expect(label).not.toContain('VITE_APP_VERSION');
  });

  it('prefers the native versionName over the env fallback in Diagnostics', () => {
    const diagnostics = read('src/lib/appExperienceDiagnostics.js');
    expect(diagnostics).toMatch(/nativeBuild\.versionName \|\| import\.meta\.env\?\.VITE_APP_VERSION/);
  });

  it('reports the native version and code on an Android build', () => {
    setCurrentDiagnosticsBuildIdentity({
      artifactId: 'artifact-under-test', sourceId: 'source-under-test',
      versionName: '1.1.0', versionCode: 3, flavor: 'none', buildType: 'debug',
    });
    const report = buildAppExperienceReport({
      nativeDiagnostics: { runtime: { platform: 'android' } },
    });
    expect(report.app.version_name).toBe('1.1.0');
    expect(report.app.version_code).toBe(3);
  });

  it('keeps packaged-build identity distinct from the web bundle hash', () => {
    const diagnostics = read('src/lib/appExperienceDiagnostics.js');
    // Collapsing these into one "build hash" would make evidence unattributable.
    expect(diagnostics).toContain('artifact_id:');
    expect(diagnostics).toContain('build_source_id:');
    expect(diagnostics).toContain('web_bundle_hash:');
  });

  it('keeps Gradle as the single source of the Android product version', () => {
    const gradle = read('android/app/build.gradle');
    expect(gradle).toMatch(/versionCode = 3/);
    expect(gradle).toMatch(/versionName = "1\.1\.0"/);
  });

  it('never consumes the npm package version as an app version', () => {
    // package.json version is package metadata; Vite does not expose it and src must not read it.
    const settings = read('src/pages/Settings.jsx');
    const diagnostics = read('src/lib/appExperienceDiagnostics.js');
    for (const source of [settings, diagnostics]) {
      expect(source).not.toMatch(/from ['"].*package\.json['"]/);
    }
  });
});
