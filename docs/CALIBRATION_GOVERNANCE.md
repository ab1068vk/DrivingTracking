# Calibration Governance

Road Sage calibration is a living process. A successful promotion is not the end of calibration; it starts an audit trail and creates a baseline that future model changes must be checked against.

This document defines when to recalibrate, what must be reviewed before promotion, how users should hear about scoring-model changes, and what calibration can never prove.

## 1. Recalibration Triggers

Run `npm run calibration:fit` and consider promotion when any of these triggers occurs.

### Automatic Triggers

- **500 new labels since the last promotion.** Once 500 additional eligible calibration labels have accumulated after the latest entry in `scripts/calibration-audit-log.jsonl`, run a new fit and compare the candidate constants against the current production constants.
- **Validation drift above 3 MAE points.** If the latest `npm run calibration:validate` result shows `crossValidationMAE` has increased by more than 3 points compared with the last promoted audit entry, treat the model as drifting from user expectations and run a new fit.

### Manual Trigger

- **A significant scoring feature change affects `PENALTY_SCALE_FACTOR`.** Examples include adding a new event type to Safety scoring, changing event severity weights, changing distance normalization, or changing how driving events are counted. Any change that alters the relationship between event rates and score deductions requires a calibration review.

### Mandatory Trigger

- **A developer changes any `@promotionBlocker` constant without running `calibration:promote`.** The CI calibration gate must block this. A promotion-blocking constant change is not complete until the calibration audit log, fit report, and generated scoring version are updated together.

## 2. Promotion Review Checklist

Before running `npm run calibration:promote`, the developer must confirm every item below.

- [ ] `npm run calibration:validate` passes for all golden fixtures.
- [ ] `crossValidationMAE < 10.0`.
  This is stricter than the automated guard of `12.0`; manual review should use the stricter threshold.
- [ ] No single constant changes by more than 25% from its current value.
  A change above 25% suggests a label quality issue, cohort shift, or fitting problem unless there is a documented scoring feature change that explains it.
- [ ] The confusion matrix shows acceptable diagonal dominance.
  Compute `sum of diagonal / total`; it must be greater than `0.65`, meaning the model agrees with users on more than 65% of labels.
- [ ] `scripts/calibration-audit-log.jsonl` has been committed to the repository.
  This is the permanent audit trail. Never delete it, rewrite it, or omit it from a promotion commit.

## 3. User Communication When Constants Change

When `SCORING_VERSION` changes after a promotion, existing trips may need to be re-scored.

The stale-trip detection system in `useStaleTripDetection.js` already marks existing trips for re-scoring. That behavior should remain enabled.

Add a one-time in-app notification through the existing notification system:

**Title:** Coaching improved

**Body:** We updated the scoring model with data from real drives. Your recent trips are being re-scored. Scores may change slightly.

Use the language of improved accuracy. Do not say old scores were wrong.

If `PENALTY_SCALE_FACTOR` changed by more than 10%, append this sentence to the notification body:

If your Safety score changed significantly, this reflects a recalibration of how driving events are weighted, not a change in how you're driving.

## 4. What Calibration Cannot Fix

Calibration improves internal consistency. It does not turn Road Sage into an outcome-validated safety model.

- **No crash outcome data.** Road Sage does not have crash, claim, injury, or casualty outcome data and should not assume it will. Current calibration uses self-reported driving quality, not safety outcome validation.
- **Label bias.** Drivers who use Road Sage are likely more safety-conscious than average drivers. Constants calibrated from this population may not generalize to all drivers.
- **Geographic bias.** Early users may cluster in specific regions. Route risk constants calibrated on urban Ontario data are still provisional for rural roads, other provinces, other countries, and regions with different road geometry or enforcement patterns.
- **Fatigue limitations.** Fatigue constants remain anchored to Williamson & Feyer (2000), which reported BAC-equivalent impairment from wakefulness duration. Fatigue self-reports improve the calibration path, but they cannot fully replace outcome data or controlled fatigue studies.

## 5. Aspirational External Data Sources

External collision-outcome calibration should not be implemented until legal review confirms that correlating user GPS data with crash locations does not create privacy obligations beyond the current privacy policy.

Potential future data sources:

- **Transport Canada NCDB, National Collision Database.**
  Open data with collision records and location fields such as latitude and longitude. Requires attribution and review of dataset license terms.
- **Ontario Road Safety Annual Report, Ministry of Transportation Ontario.**
  Public road-safety reporting useful for aggregate regional validation. Usually less suitable for direct GPS-cell matching than record-level collision datasets. Requires attribution and review of reuse terms.
- **UK STATS19, Department for Transport.**
  Open collision data with location and severity fields. Requires attribution and compliance with the UK open government data terms.
- **US NHTSA CRSS, Crash Report Sampling System.**
  Public crash sample data. Useful for national-level patterns, but sampling design and location precision must be reviewed before any route-level matching.

Any future matching should use **GPS cell overlap**, not exact coordinate matching. The model should compare Road Sage route-risk cells with historical collision density in nearby cells, with privacy zones and minimum aggregation thresholds applied before analysis.

Do not build external-data matching until a legal and privacy review approves:

- Whether user GPS data can be compared with public crash datasets under the current privacy policy.
- Whether additional user consent is needed.
- Whether attribution, retention, or derived-data requirements apply.
- Whether regional datasets can be mixed without misleading users about coverage quality.
