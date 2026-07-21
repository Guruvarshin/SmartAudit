import { AnomalySeverity, AnomalyType, APPROVAL_THRESHOLD } from '../domain/Constants.js';

/**
 * The detector's own model of suspicion. Deliberately not imported from the
 * seed's planted descriptions — that would be reading the answer key rather
 * than detecting anything.
 */
const EVASIVE_TERMS = Object.freeze([
  'misc',
  'test',
  'temp',
  'adjust',
  'reversal',
  'correction',
  'manual',
  'xxx',
  'balancing',
  'instruction',
  'discussed',
  'backup',
  'fix later',
  'do not use',
  'see email',
  'per management'
]);

/** Sides balance when they sum to `amount` within a currency rounding margin. */
const BALANCE_EPSILON = 0.005;

/** Postings before this hour (UTC) count as small-hours activity. */
const SMALL_HOURS_END = 6;

/**
 * Evaluates fields independently and emits one signal per finding, each
 * naming its type and the field it was raised against (spec §3.2).
 *
 * Pure computation — the amount baseline is fetched by the caller so this
 * class stays trivially testable.
 */
export class AnomalyDetector {
  detect(entry, amountBaseline = null) {
    const detectedAt = new Date();
    const signals = [
      this.#balanceMismatch(entry),
      this.#temporalAnomaly(entry),
      this.#numericOutlier(entry, amountBaseline),
      this.#roundingPattern(entry),
      this.#semanticAnomaly(entry)
    ].filter(Boolean);

    return signals.map((signal) => ({ ...signal, detectedAt }));
  }

  /**
   * Each row is a single-sided ledger line, balanced when debit + credit
   * equals amount with exactly one side non-zero. Note this is not the literal
   * "debit must equal credit" reading, which would flag the spec's own example
   * entry as high-risk.
   */
  #balanceMismatch(entry) {
    const bothSides = entry.debit > 0 && entry.credit > 0;
    const neitherSide = entry.debit === 0 && entry.credit === 0;
    const sum = entry.debit + entry.credit;
    const offBy = Math.abs(sum - entry.amount);

    if (!bothSides && !neitherSide && offBy <= BALANCE_EPSILON) return null;

    const detail = bothSides
      ? `both sides populated (debit ${entry.debit}, credit ${entry.credit}) on a single ledger line`
      : neitherSide
        ? 'neither debit nor credit populated'
        : `sides sum to ${sum}, stated amount is ${entry.amount} (off by ${offBy.toFixed(2)})`;

    return {
      type: AnomalyType.BALANCE_MISMATCH,
      field: 'debit',
      severity: AnomalySeverity.CRITICAL,
      score: 1,
      detail
    };
  }

  /** The spec names "2:00 AM on a Sunday", so weekend small-hours scores highest. */
  #temporalAnomaly(entry) {
    const posting = new Date(entry.postingDate);
    const hour = posting.getUTCHours();
    const day = posting.getUTCDay();
    const weekend = day === 0 || day === 6;
    const smallHours = hour < SMALL_HOURS_END;

    if (!weekend && !smallHours) return null;

    const score = weekend && smallHours ? 1 : smallHours ? 0.75 : 0.6;
    return {
      type: AnomalyType.TEMPORAL_ANOMALY,
      field: 'postingDate',
      severity: score >= 1 ? AnomalySeverity.CRITICAL : AnomalySeverity.WARNING,
      score,
      detail: `posted ${weekend ? 'on a weekend' : 'on a weekday'} at ${String(hour).padStart(2, '0')}:${String(posting.getUTCMinutes()).padStart(2, '0')} UTC`
    };
  }

  /**
   * Median/MAD rather than mean/stddev: the outliers being hunted would
   * otherwise inflate the very spread they are measured against.
   */
  #numericOutlier(entry, baseline) {
    // Fewer than 8 peers is not a population.
    if (!baseline || baseline.count < 8 || entry.amount <= 0) return null;

    const distance = Math.abs(Math.log10(entry.amount) - baseline.medianLog);
    const threshold = Math.max(3 * baseline.sigmaLog, 0.8);
    if (distance <= threshold) return null;

    return {
      type: AnomalyType.NUMERIC_OUTLIER,
      field: 'amount',
      severity: AnomalySeverity.WARNING,
      score: Math.min(1, 0.5 + (distance - threshold) / 2),
      detail:
        `amount ${entry.amount} sits ${distance.toFixed(2)} log-decades from the ` +
        `GL ${entry.glNumber} median (threshold ${threshold.toFixed(2)}, n=${baseline.count})`
    };
  }

  /** Implausibly round large amounts, and structuring just beneath the approval threshold. */
  #roundingPattern(entry) {
    const amount = entry.amount;
    const underThreshold = APPROVAL_THRESHOLD - amount;

    if (underThreshold > 0 && underThreshold <= 2500) {
      return {
        type: AnomalyType.ROUNDING_PATTERN,
        field: 'amount',
        severity: AnomalySeverity.WARNING,
        score: 0.8,
        detail: `amount ${amount} sits ${underThreshold} below the ${APPROVAL_THRESHOLD} approval threshold`
      };
    }

    if (amount >= 200000 && amount % 50000 === 0) {
      return {
        type: AnomalyType.ROUNDING_PATTERN,
        field: 'amount',
        severity: AnomalySeverity.INFO,
        score: 0.6,
        detail: `amount ${amount} is an implausibly round figure for an operational posting`
      };
    }

    return null;
  }

  #semanticAnomaly(entry) {
    const text = String(entry.description ?? '').toLowerCase().trim();
    const hits = EVASIVE_TERMS.filter((term) => text.includes(term));
    const tokenCount = text.split(/\s+/).filter(Boolean).length;
    const tooShort = tokenCount <= 2;

    if (hits.length === 0 && !tooShort) return null;

    const score = Math.min(1, hits.length * 0.45 + (tooShort ? 0.3 : 0));
    return {
      type: AnomalyType.SEMANTIC_ANOMALY,
      field: 'description',
      severity: hits.length >= 2 ? AnomalySeverity.WARNING : AnomalySeverity.INFO,
      score,
      detail:
        hits.length > 0
          ? `evasive terms in narrative: ${hits.join(', ')}`
          : `narrative too short to substantiate the posting (${tokenCount} token${tokenCount === 1 ? '' : 's'})`
    };
  }
}
