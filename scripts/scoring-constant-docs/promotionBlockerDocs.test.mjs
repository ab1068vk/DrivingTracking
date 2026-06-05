import { describe, expect, it } from 'vitest';
import { auditPromotionBlockerDocs } from './promotionBlockerDocs.mjs';

describe('promotion blocker JSDoc audit', () => {
  it('accepts blocked exported constants with required fields', () => {
    const source = `
      /**
       * @promotionBlocker true
       * @calibrationRequirement labeled data
       * @currentValue 1
       */
      export const GOOD_CONSTANT = 1;
    `;

    expect(auditPromotionBlockerDocs(source)).toEqual([]);
  });

  it('reports blocked object constants missing required fields', () => {
    const source = `
      export const SCORING_CONSTANTS = Object.freeze({
        /**
         * @promotionBlocker true
         * @currentValue 12
         */
        NEEDS_REQUIREMENT: constant(12, {}),
      });
    `;

    expect(auditPromotionBlockerDocs(source)).toEqual([
      {
        constantName: 'NEEDS_REQUIREMENT',
        missingTags: ['calibrationRequirement'],
      },
    ]);
  });

  it('ignores non-blocking JSDoc', () => {
    const source = `
      /**
       * @promotionBlocker false
       */
      export const NORMAL_CONSTANT = 1;
    `;

    expect(auditPromotionBlockerDocs(source)).toEqual([]);
  });
});
