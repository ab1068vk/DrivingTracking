import { signExport } from '@/lib/exportIntegrity';
import { exportAuditCheckpoint, verifyCheckpoint } from '@/lib/hashChainLog';
import { buildPrivacyRecommendations } from '@/lib/privacyIntelligence';

export const PRIVACY_REPORT_HEADER = 'Privacy Intelligence is a local dashboard that reports app-recorded privacy activity, outbound location-sharing evidence, privacy-zone protection counts, local protection checks, and audit-chain consistency.';
export const PRIVACY_REPORT_FORMAT = 'road-sage-privacy-report';
export const PRIVACY_REPORT_VERSION = 1;

const drivingHighlights = (readout = {}) => ({
  tripCount: readout.tripCount || 0,
  recentTripCount: readout.recentTripCount || 0,
  recentProtectedTripCount: readout.recentProtectedTripCount || 0,
  recentProtectionRate: readout.recentProtectionRate ?? null,
  privateEndpointTripCount: readout.privateEndpointTripCount || 0,
  protectedPointCount: readout.protectedPointCount || 0,
  protectedEventCount: readout.protectedEventCount || 0,
  rawPointInsideZoneCount: readout.rawPointInsideZoneCount || 0,
  untouchedZoneCount: readout.untouchedZoneCount || 0,
  staleZoneCount: readout.staleZoneCount || 0,
});

const reportScore = (score = {}) => ({
  overall: score.overall ?? null,
  label: score.label || 'Unavailable',
  tone: score.tone || 'unknown',
  layers: score.layers || [],
  summary: score.summary || {},
  webCapApplied: score.webCapApplied === true,
  capNote: score.webCapApplied ? score.capReason : null,
});

export async function buildPrivacyReportPayload(data = {}) {
  const checkpoint = await exportAuditCheckpoint();
  const checkpointVerification = await verifyCheckpoint(checkpoint);
  const recommendations = buildPrivacyRecommendations(data.protections || [], 5)
    .map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      category: item.category,
      riskIfMissing: item.riskIfMissing,
      userAction: item.userAction,
    }));

  return {
    format: PRIVACY_REPORT_FORMAT,
    version: PRIVACY_REPORT_VERSION,
    header: PRIVACY_REPORT_HEADER,
    generatedAt: Date.now(),
    score: reportScore(data.score),
    protectionSummary: data.protectionSummary || {},
    recommendations,
    zoneSummary: data.zoneSummary || {},
    drivingReadout: drivingHighlights(data.drivingReadout),
    audit: {
      chainResult: data.chainResult || {},
      signatureStatus: checkpointVerification.signatureStatus,
    },
    auditCheckpoint: checkpoint,
  };
}

export async function exportPrivacyReport(data = {}) {
  return signExport(await buildPrivacyReportPayload(data));
}
