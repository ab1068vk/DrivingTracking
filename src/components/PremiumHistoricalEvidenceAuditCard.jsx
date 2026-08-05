// @ts-check
import { ShieldCheck } from 'lucide-react';
import premiumHistoricalAuditHero from '@/assets/premium-historical-audit-hero.webp';
import premiumHistoricalAuditCompleted from '@/assets/premium-historical-audit-completed.webp';
import premiumHistoricalAuditDriver from '@/assets/premium-historical-audit-driver.webp';
import premiumHistoricalAuditScore from '@/assets/premium-historical-audit-score.webp';
import premiumHistoricalAuditEvents from '@/assets/premium-historical-audit-events.webp';
import premiumHistoricalAuditRoute from '@/assets/premium-historical-audit-route.webp';
import premiumHistoricalAuditPrivacy from '@/assets/premium-historical-audit-privacy.webp';
import premiumHistoricalAuditCompletedIcon from '@/assets/premium-historical-audit-icon-completed-v3.webp';
import premiumHistoricalAuditDriverIcon from '@/assets/premium-historical-audit-icon-driver-v3.webp';
import premiumHistoricalAuditScoreIcon from '@/assets/premium-historical-audit-icon-score-v3.webp';
import premiumHistoricalAuditEventsIcon from '@/assets/premium-historical-audit-icon-events-v3.webp';
import premiumHistoricalAuditRouteIcon from '@/assets/premium-historical-audit-icon-route-v3.webp';
import premiumHistoricalAuditPrivacyIcon from '@/assets/premium-historical-audit-icon-privacy-v3.webp';

export const shouldRenderPremiumHistoricalEvidenceAudit = (premiumVisualExperience) => (
  premiumVisualExperience === true
);

/**
 * @param {Record<string, any>} audit
 */
export function buildPremiumHistoricalEvidenceAuditViewModel(audit = {}) {
  const totalCompleted = Math.max(0, Math.trunc(Number(audit.totalCompleted) || 0));
  const driverEligible = Math.max(0, Math.trunc(Number(audit.driverEligible) || 0));
  const scoreReady = Math.max(0, Math.trunc(Number(audit.scoreReady) || 0));
  const eventReady = Math.max(0, Math.trunc(Number(audit.eventReady) || 0));
  const routeReady = Math.max(0, Math.trunc(Number(audit.routeReady) || 0));
  const missingCoachMeasurements = Math.max(
    0,
    Math.trunc(Number(audit.missingCoachMeasurements) || 0),
  );
  const excludedDriver = Math.max(0, Math.trunc(Number(audit.excludedDriver) || 0));
  const privacyProtected = Math.max(0, Math.trunc(Number(audit.privacyProtected) || 0));

  return {
    metrics: [
      {
        id: 'completed',
        tone: 'blue',
        icon: premiumHistoricalAuditCompletedIcon,
        art: premiumHistoricalAuditCompleted,
        value: totalCompleted ? String(totalCompleted) : 'None',
        label: 'completed trips found',
        measured: totalCompleted > 0,
      },
      {
        id: 'driver',
        tone: 'green',
        icon: premiumHistoricalAuditDriverIcon,
        art: premiumHistoricalAuditDriver,
        value: driverEligible ? String(driverEligible) : 'None eligible',
        label: 'driver trips eligible',
        measured: driverEligible > 0,
      },
      {
        id: 'score',
        tone: 'violet',
        icon: premiumHistoricalAuditScoreIcon,
        art: premiumHistoricalAuditScore,
        value: scoreReady ? `${scoreReady} trips` : 'Not measured',
        label: 'score evidence',
        measured: scoreReady > 0,
      },
      {
        id: 'events',
        tone: 'amber',
        icon: premiumHistoricalAuditEventsIcon,
        art: premiumHistoricalAuditEvents,
        value: eventReady ? `${eventReady} trips` : 'Not measured',
        label: 'event evidence',
        measured: eventReady > 0,
      },
      {
        id: 'route',
        tone: 'cyan',
        icon: premiumHistoricalAuditRouteIcon,
        art: premiumHistoricalAuditRoute,
        value: routeReady ? `${routeReady} trips` : 'No route key',
        label: 'route evidence',
        measured: routeReady > 0,
      },
    ],
    notices: [
      missingCoachMeasurements > 0 && {
        id: 'missing',
        count: missingCoachMeasurements,
        lead: `${missingCoachMeasurements} historical trips:`,
        detail: 'no reliable score or Coach event measurement; excluded, never counted as 0.',
      },
      excludedDriver > 0 && {
        id: 'excluded',
        count: excludedDriver,
        lead: `${excludedDriver} trips:`,
        detail: 'passenger or manually excluded from driver metrics.',
      },
      privacyProtected > 0 && {
        id: 'privacy',
        count: privacyProtected,
        lead: `${privacyProtected} privacy-protected trips:`,
        detail: 'included using stored scores, events, and route points outside your configured privacy-zone radius. Protected coordinates remain excluded.',
      },
    ].filter(Boolean),
  };
}

/**
 * Premium presentation for the historical evidence values already calculated
 * by buildCoachEvidenceAudit. Generated artwork is decorative only.
 * @param {{ audit?: Record<string, any>, loading?: boolean }} props
 */
export default function PremiumHistoricalEvidenceAuditCard({
  audit = {},
  loading = false,
}) {
  const { metrics, notices } = buildPremiumHistoricalEvidenceAuditViewModel(audit);

  return (
    <section
      className="premium-historical-audit"
      aria-labelledby="premium-historical-audit-title"
      aria-busy={loading}
    >
      <img loading="lazy"
        className="premium-historical-audit-hero"
        src={premiumHistoricalAuditHero}
        alt=""
        aria-hidden="true"
      />
      <span className="premium-historical-audit-hero-veil" aria-hidden="true" />

      <header className="premium-historical-audit-head">
        <div className="premium-historical-audit-kicker">
          <ShieldCheck aria-hidden="true" />
          <span>Historical evidence audit</span>
        </div>
        <h2 id="premium-historical-audit-title">What the Coach can actually measure</h2>
        <p>
          A numeric 0 appears only when a trip explicitly recorded zero events. Missing legacy
          values are labelled unavailable and excluded.
        </p>
        {loading && (
          <span className="premium-historical-audit-refresh" role="status">
            Refreshing trip evidence
          </span>
        )}
      </header>

      <div className="premium-historical-audit-metrics" aria-label="Historical coaching evidence">
        {metrics.map(({ id, tone, icon, art, value, label, measured }) => (
          <article
            key={id}
            className="premium-historical-audit-metric"
            data-evidence-metric={id}
            data-tone={tone}
            data-state={measured ? 'measured' : 'unavailable'}
            aria-label={`${label}: ${value}`}
          >
            <img loading="lazy" className="premium-historical-audit-art" src={art} alt="" aria-hidden="true" />
            <span className="premium-historical-audit-metric-veil" aria-hidden="true" />
            <img loading="lazy" className="premium-historical-audit-icon" src={icon} alt="" aria-hidden="true" />
            <span className="premium-historical-audit-copy">
              <strong>{value}</strong>
              <span>{label}</span>
            </span>
          </article>
        ))}
      </div>

      {notices.length > 0 && (
        <aside className="premium-historical-audit-notices" aria-label="Historical evidence exclusions and privacy">
          <img loading="lazy"
            className="premium-historical-audit-notices-art"
            src={premiumHistoricalAuditPrivacy}
            alt=""
            aria-hidden="true"
          />
          <span className="premium-historical-audit-notice-veil" aria-hidden="true" />
          <img loading="lazy"
            className="premium-historical-audit-lock"
            src={premiumHistoricalAuditPrivacyIcon}
            alt=""
            aria-hidden="true"
          />
          <div>
            {notices.map((notice) => (
              <p key={notice.id} data-notice={notice.id}>
                <strong>{notice.lead}</strong>{' '}{notice.detail}
              </p>
            ))}
          </div>
        </aside>
      )}
    </section>
  );
}
