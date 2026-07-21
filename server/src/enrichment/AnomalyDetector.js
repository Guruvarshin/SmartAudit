import { AnomalySeverity, AnomalyType, APPROVAL_THRESHOLD } from '../domain/Constants.js';

/**
 * Terms that make a journal-entry narrative read as evasive or non-substantive
 * against normal business vocabulary. This list is the detector's own model of
 * suspicion — it deliberately does NOT import the seed's SUSPICIOUS_DESCRIPTIONS
 * (that would be reading the answer key rather than detecting anything).
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
 * The granular anomaly pipeline — SPEC.md §3.2. Evaluates specific fields
 * independently and emits one signal object per finding, each identifying its
 * type and the exact field it was raised against.
 *
 * Pure computation: the entry and a pre-fetched amount baseline go in, signal
 * objects come out. All I/O (fetching the baseline) stays in the enrichment
 * service so this class is trivially testable.
 */
export class AnomalyDetector {
  /**
   * @param {object} entry plain journal-entry document
   * @param {{ count: number, medianLog: number, sigmaLog: number } | null} amountBaseline
   *   robust log-amount statistics for this entry's (companyId, glNumber)
   *   population, or null when no baseline is available
   * @returns {object[]} anomaly signal objects, possibly empty
   */
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
   * Balance interpretation per DECISIONS.md Day 1: each row is a single-sided
   * ledger line, balanced when debit + credit === amount with exactly one side
   * non-zero. (The literal "debit must equal credit" reading would flag the
   * spec's own §2 example entry.)
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

  /**
   * SPEC.md §3.1 names "2:00 AM on a Sunday" as the canonical unusual
   * timestamp, so weekend small-hours postings score highest.
   */
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
   * Outlier relative to the robust log-scale baseline of the same GL account
   * within the same company. Median/MAD rather than mean/stddev because the
   * outliers being hunted would otherwise inflate the very spread they are
   * measured against.
   */
  #numericOutlier(entry, baseline) {
    // Fewer than 8 peers is not a population, it is an anecdote.
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

  /**
   * Two shapes: implausibly round large amounts, and amounts clustered just
   * beneath the internal approval threshold (structuring).
   */
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

  /** Evasive vocabulary and non-narratives on the description field. */
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
