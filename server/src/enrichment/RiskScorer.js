import { AnomalyType, RiskThresholds, RiskTier } from '../domain/Constants.js';

/**
 * Weight of each anomaly type's contribution to the composite risk score.
 *
 * Calibration notes (against the tier thresholds in Constants.js):
 *  - an unbalanced line alone (0.45) lands medium — a broken ledger line is
 *    never a low-risk event;
 *  - the spec's canonical "2:00 AM on a Sunday" posting alone (1.0 × 0.40)
 *    lands medium, satisfying §3.1's demand that unusual timestamps
 *    "programmatically trigger higher risk elevations";
 *  - unbalanced AND off-hours (0.45 + 0.40) crosses into high — the seed
 *    deliberately plants this overlap, and additive factors are what make the
 *    combination outrank either cause alone;
 *  - a hard numeric outlier alone (up to 0.40) reaches medium;
 *  - rounding and narrative signals are corroborating evidence, not
 *    independently damning.
 */
const FACTOR_WEIGHTS = Object.freeze({
  [AnomalyType.BALANCE_MISMATCH]: { weight: 0.45, label: 'Unbalanced ledger line' },
  [AnomalyType.TEMPORAL_ANOMALY]: { weight: 0.4, label: 'Unusual posting time' },
  [AnomalyType.NUMERIC_OUTLIER]: { weight: 0.4, label: 'Amount outlier for GL account' },
  [AnomalyType.ROUNDING_PATTERN]: { weight: 0.2, label: 'Rounding / threshold pattern' },
  [AnomalyType.SEMANTIC_ANOMALY]: { weight: 0.2, label: 'Uncharacteristic narrative' }
});

/**
 * Multi-factor risk scoring — SPEC.md §3.1.
 *
 * "Multi-factor" is demonstrable, not asserted: every contributing factor is
 * returned with its weight and contribution, persisted to analytics.risk.factors,
 * and rendered as a breakdown in the Day 4 diagnostics modal. The composite is
 * a clamped weighted sum, so co-occurring causes (the seed's unbalanced ×
 * off-hours overlap) genuinely outrank any single cause.
 */
export class RiskScorer {
  /**
   * @param {object[]} signals output of AnomalyDetector.detect()
   * @returns {{ score: number, tier: string, factors: object[] }}
   */
  score(signals) {
    const factors = signals
      .filter((signal) => FACTOR_WEIGHTS[signal.type])
      .map((signal) => {
        const { weight, label } = FACTOR_WEIGHTS[signal.type];
        return {
          code: signal.type,
          label,
          weight,
          contribution: this.#round(weight * signal.score)
        };
      })
      .sort((a, b) => b.contribution - a.contribution);

    const score = this.#round(
      Math.min(1, factors.reduce((sum, factor) => sum + factor.contribution, 0))
    );

    return { score, tier: this.#tier(score), factors };
  }

  #tier(score) {
    if (score >= RiskThresholds.HIGH) return RiskTier.HIGH;
    if (score >= RiskThresholds.MEDIUM) return RiskTier.MEDIUM;
    return RiskTier.LOW;
  }

  #round(value) {
    return Math.round(value * 1000) / 1000;
  }
}
