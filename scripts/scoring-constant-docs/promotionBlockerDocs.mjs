import { constantNameAfterBlock } from './constantNames.mjs';
import { extractJsdocBlocks } from './jsdocBlocks.mjs';
import {
  REQUIRED_PROMOTION_BLOCKER_TAGS,
  hasTagWithValue,
  hasTruePromotionBlocker,
} from './jsdocTags.mjs';

function missingRequiredTags(blockText) {
  return REQUIRED_PROMOTION_BLOCKER_TAGS.filter((tagName) => !hasTagWithValue(blockText, tagName));
}

function auditBlock(source, block) {
  const missingTags = missingRequiredTags(block.text);
  if (missingTags.length === 0) return null;

  return {
    constantName: constantNameAfterBlock(source, block),
    missingTags,
  };
}

export function auditPromotionBlockerDocs(source) {
  return extractJsdocBlocks(source)
    .filter((block) => hasTruePromotionBlocker(block.text))
    .map((block) => auditBlock(source, block))
    .filter(Boolean);
}
