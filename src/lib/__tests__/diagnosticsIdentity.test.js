import { describe, expect, it } from 'vitest';
import { createDiagnosticsAttribution, evidenceScopeFor, getCurrentDiagnosticsAttribution, setCurrentDiagnosticsBuildIdentity } from '@/lib/diagnosticsIdentity';
import { buildAppExperienceReport } from '@/lib/appExperienceDiagnostics';

describe('anonymous Diagnostics launch/build identity', () => {
  it('discriminates the same launch, another launch on this build, an older build and unattributed history', () => {
    const current = createDiagnosticsAttribution({ sessionId: 'launch-a', nativeSessionId: 'native-launch-a', buildScopeId: 'artifact-a' });
    expect(evidenceScopeFor(current, current)).toBe('current_session');
    expect(evidenceScopeFor(createDiagnosticsAttribution({ sessionId: 'launch-b', buildScopeId: 'artifact-a' }), current)).toBe('current_build');
    expect(evidenceScopeFor(createDiagnosticsAttribution({ sessionId: 'launch-old', buildScopeId: 'artifact-old' }), current)).toBe('older_build');
    expect(evidenceScopeFor({}, current)).toBe('unattributed_history');
    expect(evidenceScopeFor({ sessionId: 'native-launch-a', buildScopeId: 'artifact-a' }, current)).toBe('current_session');
  });

  it('keeps complete identity when a separate native watchdog probe fails', () => {
    setCurrentDiagnosticsBuildIdentity({ artifactId: 'complete-artifact', sourceId: 'source-id', versionName: '1.1.0', versionCode: 3, flavor: 'none', buildType: 'debug' });
    const report = buildAppExperienceReport({ nativeDiagnostics: { runtime: { platform: 'android', probeState: 'failed', nativeBridgeAvailable: null }, watchdog: null } });
    expect(report.app.artifact_id).toBe('complete-artifact');
    expect(report.app.version_code).toBe(3);
    expect(report.attribution.current_build_scope_id).toBe('complete-artifact');
    expect(report.runtime.probe_state).toBe('failed');
    expect(report.runtime.available).toBe(false);
    expect(getCurrentDiagnosticsAttribution().sessionId).toMatch(/^launch-/);
  });
});
