import { getBuildIntegrityInfo } from '@/lib/buildIntegrity';

const randomToken = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

const CURRENT_SESSION_ID = `launch-${randomToken()}`.slice(0, 100);
let currentBuildScopeId = null;
let currentBuildMetadata = null;
let currentNativeSessionId = null;

export const setCurrentDiagnosticsBuildIdentity = (value, nativeSessionId = null) => {
  if (nativeSessionId) currentNativeSessionId = String(nativeSessionId).slice(0, 100);
  const next = String(typeof value === 'object' ? value?.artifactId || '' : value || '').slice(0, 180);
  if (next) currentBuildScopeId = next;
  if (next && value && typeof value === 'object') currentBuildMetadata = Object.freeze({
    artifactId: next,
    sourceId: String(value.sourceId || '').slice(0, 180),
    versionName: String(value.versionName || '').slice(0, 40),
    versionCode: Number.isSafeInteger(value.versionCode) ? value.versionCode : null,
    flavor: String(value.flavor || '').slice(0, 40),
    buildType: String(value.buildType || '').slice(0, 40),
  });
  return currentBuildScopeId;
};

export const getCurrentDiagnosticsBuildMetadata = () => currentBuildMetadata;

export function createDiagnosticsAttribution({ sessionId, buildScopeId, nativeSessionId } = {}) {
  const integrity = getBuildIntegrityInfo();
  return Object.freeze({
    sessionId: String(sessionId || CURRENT_SESSION_ID).slice(0, 100),
    nativeSessionId: String(nativeSessionId || currentNativeSessionId || '').slice(0, 100),
    buildScopeId: String(
      buildScopeId || currentBuildScopeId || integrity.sourceId || integrity.buildHash || 'build-unavailable'
    ).slice(0, 180),
  });
}

export const getCurrentDiagnosticsAttribution = () => createDiagnosticsAttribution();

export function evidenceScopeFor(value = {}, current = getCurrentDiagnosticsAttribution()) {
  if (value.sessionId && value.sessionId === current.sessionId) return 'current_session';
  if (value.sessionId && value.sessionId === current.nativeSessionId) return 'current_session';
  if (value.buildScopeId && value.buildScopeId === current.buildScopeId) return 'current_build';
  if (!value.sessionId && !value.buildScopeId) return 'unattributed_history';
  return 'older_build';
}
