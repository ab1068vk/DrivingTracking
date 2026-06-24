import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }) => <div>{children}</div>,
  DialogContent: ({ children }) => <div>{children}</div>,
  DialogDescription: ({ children }) => <p>{children}</p>,
  DialogHeader: ({ children }) => <div>{children}</div>,
  DialogTitle: ({ children }) => <h2>{children}</h2>,
}));

import {
  actionToneClass,
  AuditTab,
  createPrivacyAppStateHandler,
  OverviewTab,
  PrivacyAuthenticationGate,
  privacyLevelClass,
  ProtectionsTab,
  runPrivacyAuthentication,
  statusClass,
  STATUS_LABELS,
  TransmissionsTab,
  ZonesTab,
} from '@/pages/PrivacyIntelligence';

const noop = () => {};
const now = Date.parse('2026-06-22T12:00:00.000Z');

const protections = [
  { id: 'ok', label: 'Verified control', category: 'device', status: 'ok', evidence: 'Verified evidence', riskIfMissing: 'Risk', userAction: 'Action' },
  { id: 'warn', label: 'Warning control', category: 'network', status: 'warn', evidence: 'Warning evidence', riskIfMissing: 'Risk', userAction: 'Action' },
  { id: 'error', label: 'Failing control', category: 'integrity', status: 'error', evidence: 'Failure evidence', riskIfMissing: 'Risk', userAction: 'Action' },
  { id: 'unknown', label: 'Unknown control', category: 'inference', status: 'unknown', evidence: 'Unknown evidence', riskIfMissing: 'Risk', userAction: 'Action' },
  { id: 'configured', label: 'Configured control', category: 'device', status: 'configured', evidence: 'Configured evidence' },
];

const transmissionEntries = [
  {
    id: 'protected',
    type: 'Protected lookup',
    service: 'open-meteo',
    timestamp: now,
    privacyLevel: 'protected',
    status: 'safe',
    displayClassification: { label: 'Verified protection' },
    sentCoords: 'rounded point',
    bytesOut: 10,
  },
  {
    id: 'raw',
    type: 'Raw lookup',
    service: 'osrm',
    timestamp: now - 1,
    privacyLevel: 'raw',
    status: 'warning',
    displayClassification: { label: 'Raw - consented' },
    protections: ['explicit consent'],
    sentCoords: 'raw route segment',
    bytesOut: 20,
  },
  {
    id: 'blocked',
    type: 'Blocked lookup',
    service: 'osrm',
    timestamp: now - 2,
    privacyLevel: 'blocked',
    status: 'blocked',
    displayClassification: { label: 'Blocked' },
    sentCoords: null,
    bytesOut: 0,
  },
  {
    id: 'unknown',
    type: 'Unverified lookup',
    service: 'overpass',
    timestamp: now - 3,
    privacyLevel: 'unverified',
    status: 'warning',
    displayClassification: { label: 'Unverified protection claim' },
    sentCoords: 'bounding box',
    bytesOut: 30,
  },
];

const fixture = {
  generatedAt: now,
  score: {
    overall: 61,
    label: 'Needs review',
    tone: 'warn',
    detail: 'Mixed fixture posture.',
    layers: [
      { id: 'device', label: 'Device', color: '#10b981', score: 80 },
      { id: 'network', label: 'Network', color: '#0ea5e9', score: 40 },
      { id: 'inference', label: 'Inference', color: '#8b5cf6', score: 60 },
      { id: 'integrity', label: 'Integrity', color: '#f59e0b', score: 50 },
    ],
    summary: { ok: 1, configured: 1, warn: 1, unknown: 1, error: 1, not_applicable: 0 },
  },
  protectionSummary: { active: 1, configured: 1, warnings: 1, unknown: 1, errors: 1, notApplicable: 0 },
  protections,
  recommendations: protections.slice(1, 5),
  actionPlan: {
    tone: 'error',
    headline: 'Mixed findings need review',
    claim: 'Local evidence only.',
    primaryAction: { targetTab: 'protections', action: 'Open protections' },
    issues: [
      { id: 'error', tone: 'error', targetTab: 'protections', title: 'Error issue', detail: 'Error detail' },
      { id: 'warn', tone: 'warn', targetTab: 'transmissions', title: 'Warning issue', detail: 'Warning detail' },
      { id: 'unknown', tone: 'unknown', targetTab: 'zones', title: 'Unknown issue', detail: 'Unknown detail' },
    ],
  },
  transmissions: {
    entries: transmissionEntries,
    services: [
      { service: 'open-meteo', count: 1 },
      { service: 'osrm', count: 2 },
      { service: 'overpass', count: 1 },
    ],
    protectedTotal: 1,
    blockedTotal: 1,
    totalRawCoords: 1,
    rawWithConsentCount: 1,
    rawWithoutConsentCount: 0,
    claimedButUnverifiedCount: 1,
    totalBytesOut: 60,
    outboundReadout: {
      tone: 'warn',
      headline: 'Mixed outbound evidence',
      confidence: 55,
      findings: [
        { id: 'warn', title: 'Raw sharing visible', detail: 'Review consent.' },
        { id: 'unknown', title: 'Evidence incomplete', detail: 'Review verification.' },
      ],
      serviceSummaries: [],
    },
  },
  zones: [{
    id: 'home',
    label: 'Home',
    type: 'corridor',
    sensitivity: 'high',
    radius_m: 150,
    expiresAt: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(),
    today: { hidden: 2, events: 1 },
    week: { hidden: 4, events: 2 },
    allTime: { hidden: 8, events: 3 },
    lastActive: now - 1000,
    effectiveness: { nearMissCount: 2, suggestedRadiusM: 190 },
  }, {
    id: 'ready',
    label: 'Ready zone',
    radius_m: 100,
    today: { hidden: 0, events: 0 },
    week: { hidden: 0, events: 0 },
    allTime: { hidden: 0, events: 0 },
    lastActive: null,
  }],
  zoneSummary: {
    zoneCount: 2,
    activeZoneCount: 1,
    pointsToday: 2,
    eventsToday: 1,
    pointsWeek: 4,
    eventsWeek: 2,
    latestAt: now - 1000,
  },
  zoneSuggestions: [{
    suggestedCenter: { lat: 43.65, lng: -79.38 },
    suggestedRadiusM: 140,
    occurrenceDays: 6,
    firstSeenAt: now - 10_000,
    lastSeenAt: now - 2_000,
  }],
  drivingReadout: {
    tripCount: 3,
    recentTripCount: 2,
    recentProtectedTripCount: 1,
    recentProtectionRate: 50,
    tripsWithProtectedActivity: 1,
    privateEndpointTripCount: 1,
    protectedPointCount: 2,
    protectedEventCount: 1,
    rawPointInsideZoneCount: 1,
    untouchedZoneCount: 1,
    staleZoneCount: 0,
    zoneSummaries: [
      { id: 'home', protectedRecords: 11, lastActive: now - 1000 },
      { id: 'ready', protectedRecords: 0, lastActive: null },
    ],
    recommendedChecks: ['One saved route sample needs review.'],
  },
  chain: [
    { seq: 1, op: 'ZONE_SAVED', timestamp: now - 2000, hash: 'a'.repeat(64) },
    { seq: 2, op: 'TRANSMISSION', timestamp: now - 1000, hash: 'b'.repeat(64), details: { service: 'osrm', status: 'warning' } },
  ],
  chainResult: { valid: true, length: 2, tip: 'b'.repeat(64) },
  auditSummary: {
    todayTotal: 2,
    weekTotal: 2,
    latestAt: now - 1000,
    lastCheckpointExportedAt: now,
    signatureCoverage: 2,
    operations: [
      { operation: 'ZONE_SAVED', count: 1 },
      { operation: 'TRANSMISSION', count: 1 },
    ],
  },
};

const render = (component, props) => renderToStaticMarkup(createElement(component, props));

describe('Privacy Intelligence tabs', () => {
  it('renders all five tabs with mixed-status fixture data', () => {
    const outputs = [
      render(OverviewTab, { data: fixture, onOpenTab: noop, onOpenSettings: noop }),
      render(TransmissionsTab, { data: fixture, onClear: noop }),
      render(ProtectionsTab, { data: fixture, onOpenSettings: noop }),
      render(ZonesTab, { data: fixture }),
      render(AuditTab, { data: fixture }),
    ];

    outputs.forEach((html) => expect(html.length).toBeGreaterThan(100));
    expect(outputs[0]).toContain('Mixed findings need review');
    expect(outputs[1]).toContain('Verified protection');
    expect(outputs[1]).toContain('Raw - consented');
    expect(outputs[1]).toContain('Blocked');
    expect(outputs[1]).toContain('Unverified protection claim');
    expect(outputs[2]).toContain('Verified control');
    expect(outputs[2]).toContain('Warning control');
    expect(outputs[2]).toContain('Failing control');
    expect(outputs[2]).toContain('Unknown control');
    expect(outputs[3]).toContain('Raw points in zones');
    expect(outputs[3]).toContain('Frequent stop suggestion');
    expect(outputs[3]).toContain('Review the suggested 140 m circle before saving');
    expect(outputs[3]).toContain('2 raw points were just outside this zone');
    expect(outputs[3]).toContain('Route corridor');
    expect(outputs[3]).toContain('hours remaining');
    expect(outputs[3]).toContain('>High<');
    expect(outputs[4]).toContain('Hash-chain consistent, hardware signature unavailable');
  });

  it('keeps status labels, status colors, transmission colors, and action tones distinct', () => {
    expect(new Set(['ok', 'warn', 'error', 'unknown'].map((status) => statusClass[status])).size).toBe(4);
    expect(new Set(['ok', 'warn', 'error', 'unknown'].map((status) => actionToneClass[status])).size).toBe(4);
    expect(new Set(['protected', 'raw', 'blocked', 'unverified'].map((status) => privacyLevelClass[status])).size).toBe(4);
    expect(new Set(['ok', 'warn', 'error', 'unknown'].map((status) => STATUS_LABELS[status])).size).toBe(4);
    expect(STATUS_LABELS).toMatchObject({
      ok: 'Verified',
      warn: 'Needs attention',
      error: 'Failing',
      unknown: 'Unverified',
    });
  });

  it('renders frequent-stop suggestions even before the first zone exists', () => {
    const html = render(ZonesTab, {
      data: {
        ...fixture,
        zones: [],
        zoneSummary: { zoneCount: 0 },
      },
      onAcceptSuggestion: noop,
      onDismissSuggestion: noop,
    });

    expect(html).toContain('Frequent stop suggestion');
    expect(html).toContain('Review area');
    expect(html).toContain('Dismiss');
  });
});

describe('Privacy Intelligence authentication', () => {
  it('keeps rejected authentication unauthenticated and renders no private data', async () => {
    const setAuthed = vi.fn();
    const onRejected = vi.fn();
    await expect(runPrivacyAuthentication({
      authenticate: vi.fn(async () => ({ verified: false })),
      setAuthed,
      setError: vi.fn(),
      onRejected,
    })).resolves.toBe(false);

    const html = render(PrivacyAuthenticationGate, {
      authed: false,
      loading: false,
      error: '',
      hasData: false,
      onRetry: noop,
      children: createElement('div', null, 'PRIVATE FIXTURE DATA'),
    });
    expect(setAuthed).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(html).toContain('Loading privacy intelligence...');
    expect(html).not.toContain('PRIVATE FIXTURE DATA');
  });

  it('shows data after successful authentication', async () => {
    const setAuthed = vi.fn();
    await expect(runPrivacyAuthentication({
      authenticate: vi.fn(async () => ({ verified: true })),
      setAuthed,
      setError: vi.fn(),
      onRejected: vi.fn(),
    })).resolves.toBe(true);

    const html = render(PrivacyAuthenticationGate, {
      authed: true,
      loading: false,
      error: '',
      hasData: true,
      onRetry: noop,
      children: createElement('div', null, 'PRIVATE FIXTURE DATA'),
    });
    expect(setAuthed).toHaveBeenCalledWith(true);
    expect(html).toContain('PRIVATE FIXTURE DATA');
  });

  it('re-authenticates after five minutes in the background', () => {
    let clock = 1_000;
    const authenticate = vi.fn();
    const setAuthed = vi.fn();
    const handleAppStateChange = createPrivacyAppStateHandler({
      authenticate,
      setAuthed,
      now: () => clock,
    });

    handleAppStateChange({ isActive: false });
    clock += 5 * 60 * 1000;
    handleAppStateChange({ isActive: true });

    expect(setAuthed).toHaveBeenCalledWith(false);
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it('does not re-authenticate after less than five minutes in the background', () => {
    let clock = 1_000;
    const authenticate = vi.fn();
    const setAuthed = vi.fn();
    const handleAppStateChange = createPrivacyAppStateHandler({
      authenticate,
      setAuthed,
      now: () => clock,
    });

    handleAppStateChange({ isActive: false });
    clock += (5 * 60 * 1000) - 1;
    handleAppStateChange({ isActive: true });

    expect(setAuthed).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });
});
