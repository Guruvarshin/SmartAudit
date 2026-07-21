import { AnomalySeverity, AnomalyType, ComplianceStatus, RiskTier } from '../domain/Constants.js';

/** Which compliance flag, if any, each anomaly type raises. */
const FLAG_RULES = Object.freeze({
  [AnomalyType.BALANCE_MISMATCH]: {
    code: 'UNBALANCED_JOURNAL_LINE',
    severity: AnomalySeverity.CRITICAL,
    message: 'Journal line does not balance; violates double-entry presentation requirements.'
  },
  [AnomalyType.ROUNDING_PATTERN]: {
    code: 'APPROVAL_THRESHOLD_STRUCTURING',
    severity: AnomalySeverity.WARNING,
    message: 'Amount pattern is consistent with structuring around an internal approval limit.'
  },
  [AnomalyType.SEMANTIC_ANOMALY]: {
    code: 'INSUFFICIENT_NARRATIVE',
    severity: AnomalySeverity.WARNING,
    message: 'Posting narrative does not substantiate the transaction for audit documentation.'
  },
  [AnomalyType.TEMPORAL_ANOMALY]: {
    code: 'OFF_HOURS_POSTING',
    severity: AnomalySeverity.INFO,
    message: 'Posted outside normal business hours; review authorisation trail.'
  }
});

/**
 * Mock IFRS-flavoured compliance evaluation. Derives flags from the anomaly
 * signals and an overall pass/review/fail status from flag severity and the
 * risk tier. Scenario D re-runs exactly this (plus RiskScorer) with shifted
 * thresholds while leaving vectors untouched.
 */
export class ComplianceEvaluator {
  /**
   * @param {object[]} signals output of AnomalyDetector.detect()
   * @param {{ tier: string }} risk output of RiskScorer.score()
   * @returns {{ status: string, flags: object[] }}
   */
  evaluate(signals, risk) {
    const flags = signals
      .filter((signal) => FLAG_RULES[signal.type])
      .map((signal) => ({ ...FLAG_RULES[signal.type], standard: 'IFRS' }));

    return { status: this.#status(flags, risk), flags };
  }

  #status(flags, risk) {
    if (flags.some((flag) => flag.severity === AnomalySeverity.CRITICAL)) {
      return ComplianceStatus.FAIL;
    }
    const warnings = flags.filter((flag) => flag.severity === AnomalySeverity.WARNING).length;
    if (risk.tier === RiskTier.HIGH || warnings >= 2) return ComplianceStatus.REVIEW;
    return ComplianceStatus.PASS;
  }
}
