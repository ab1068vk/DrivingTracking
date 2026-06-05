export const PROMOTION_BLOCKER_TAG = 'promotionBlocker';
export const REQUIRED_PROMOTION_BLOCKER_TAGS = Object.freeze([
  'calibrationRequirement',
  'currentValue',
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function tagValue(blockText, tagName) {
  const pattern = new RegExp(`@${escapeRegExp(tagName)}(?:\\s+([^\\r\\n*]+))?`);
  const match = blockText.match(pattern);
  return match ? (match[1] || '').trim() : null;
}

export function hasTag(blockText, tagName) {
  return tagValue(blockText, tagName) !== null;
}

export function hasTagWithValue(blockText, tagName) {
  const value = tagValue(blockText, tagName);
  return value !== null && value.length > 0;
}

export function hasTruePromotionBlocker(blockText) {
  return tagValue(blockText, PROMOTION_BLOCKER_TAG) === 'true';
}
