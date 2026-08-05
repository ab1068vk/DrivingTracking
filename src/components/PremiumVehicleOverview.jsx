// @ts-check
import { motion } from 'framer-motion';
import { Car, ClipboardCheck, Fuel, Wrench } from 'lucide-react';
import premiumVehicleGarage from '@/assets/premium-vehicle-garage.webp';
import premiumVehicleAssignment from '@/assets/premium-vehicle-assignment.webp';
import premiumVehicleCost from '@/assets/premium-vehicle-cost.webp';
import premiumVehicleService from '@/assets/premium-vehicle-service.webp';
import './PremiumVehicleOverview.css';

const CARD_DEFINITIONS = [
  {
    id: 'garage',
    label: 'Garage',
    icon: Car,
    tone: 'garage',
    art: premiumVehicleGarage,
  },
  {
    id: 'assignment',
    label: 'Assignment health',
    icon: ClipboardCheck,
    tone: 'assignment',
    art: premiumVehicleAssignment,
  },
  {
    id: 'cost',
    label: 'This month',
    icon: Fuel,
    tone: 'cost',
    art: premiumVehicleCost,
  },
  {
    id: 'service',
    label: 'Service watch',
    icon: Wrench,
    tone: 'service',
    art: premiumVehicleService,
  },
];

/**
 * @param {{
 *  summary: {
 *    vehicleCount: number,
 *    completedTripCount: number,
 *    assignmentReviewCount: number,
 *    monthlyCost: number,
 *    serviceDueCount: number,
 *    totalKm: number,
 *  },
 *  formattedMonthlyCost: string,
 *  formattedTotalDistance: string,
 *  loading?: boolean,
 * }} props
 */
export default function PremiumVehicleOverview({
  summary,
  formattedMonthlyCost,
  formattedTotalDistance,
  loading = false,
}) {
  const cards = {
    garage: {
      value: String(summary.vehicleCount),
      description: `${summary.completedTripCount} completed trip${summary.completedTripCount === 1 ? '' : 's'}`,
      state: summary.vehicleCount > 0 ? 'active' : 'empty',
    },
    assignment: {
      value: String(summary.assignmentReviewCount),
      description: summary.assignmentReviewCount === 1
        ? 'trip needs vehicle review'
        : 'trips need vehicle review',
      state: summary.assignmentReviewCount > 0 ? 'attention' : 'clear',
    },
    cost: {
      value: formattedMonthlyCost,
      description: `${formattedTotalDistance} total history`,
      state: summary.monthlyCost > 0 ? 'active' : 'empty',
    },
    service: {
      value: String(summary.serviceDueCount),
      description: `maintenance item${summary.serviceDueCount === 1 ? '' : 's'} due soon`,
      state: summary.serviceDueCount > 0 ? 'attention' : 'clear',
    },
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="premium-vehicle-overview"
      aria-label="Vehicle overview"
      aria-busy={loading}
    >
      {CARD_DEFINITIONS.map(({ id, label, icon: Icon, tone, art }) => {
        const card = cards[id];
        const accessibleLabel = loading
          ? `${label} is loading`
          : `${label}: ${card.value}. ${card.description}`;

        return (
          <article
            key={id}
            className="premium-vehicle-card"
            data-tone={tone}
            data-state={card.state}
            aria-label={accessibleLabel}
          >
            <img loading="lazy" className="premium-vehicle-card-art" src={art} alt="" aria-hidden="true" />
            <div className="premium-vehicle-card-grid" aria-hidden="true" />
            <div className="premium-vehicle-card-content">
              <div className="premium-vehicle-card-icon" aria-hidden="true">
                <Icon />
              </div>
              <div className="premium-vehicle-card-copy">
                <span>{label}</span>
                {loading ? (
                  <>
                    <span className="premium-vehicle-loading-value" />
                    <span className="premium-vehicle-loading-detail" />
                  </>
                ) : (
                  <>
                    <strong title={card.value}>{card.value}</strong>
                    <small>{card.description}</small>
                  </>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </motion.section>
  );
}
