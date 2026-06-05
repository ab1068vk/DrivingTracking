export function formatPromotionBlockerFailure({ constantName }) {
  return `Constant ${constantName} is marked @promotionBlocker but is missing required JSDoc fields. See phase5-calibration-deep-dive.md.`;
}
