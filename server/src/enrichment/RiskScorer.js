import { AnomalyType, RiskThresholds, RiskTier } from '../domain/Constants.js';

/**
 * Calibrated against the tier thresholds in Constants.js: an unbalanced line
 * alone reaches medium, as does an off-hours posting alone; the two together
 * cross into high. Rounding and narrative signals are corroborating evidence
 * rather than independently damning.
 */
const FACTOR_WEIGHTS = Object.freeze({
  [AnomalyType.BALANCE_MISMATCH]: { weight: 0.45, label: 'Unbalanced ledger line' },
  [AnomalyType.TEMPORAL_ANOMALY]: { weight: 0.4, label: 'Unusual posting time' },
  [AnomalyType.NUMERIC_OUTLIER]: { weight: 0.4, label: 'Amount outlier for GL account' },
  [AnomalyType.ROUNDING_PATTERN]: { weight: 0.2, label: 'Rounding / threshold pattern' },
  [AnomalyType.SEMANTIC_ANOMALY]: { weight: 0.2, label: 'Uncharacteristic narrative' }
});

/**
 * Every contributing factor is returned with its weight and contribution, so
 * the score is inspectable rather than opaque. The composite is a clamped
 * weighted sum, which is what makes co-occurring causes outrank a single one.
 */
export class RiskScorer {
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
