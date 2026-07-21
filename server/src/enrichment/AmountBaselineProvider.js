/**
 * Robust log-scale amount statistics per (companyId, glNumber) population,
 * with a short in-process TTL cache.
 *
 * Median + MAD rather than mean + stddev: the outliers being hunted are 50-200x
 * the typical posting, large enough to drag a mean-based baseline toward
 * themselves and mask their own detection. The median is indifferent to them.
 *
 * The cache exists because a drain of N pending entries would otherwise run N
 * baseline queries against ~20 distinct populations. Thirty seconds of
 * staleness in a statistical baseline is immaterial; N-to-20 query reduction
 * is not.
 */
export class AmountBaselineProvider {
  static #TTL_MS = 30000;

  /** 1.4826 scales MAD to estimate sigma under normality — the standard consistency constant. */
  static #MAD_SIGMA = 1.4826;

  constructor({ entryRepository }) {
    this.entryRepository = entryRepository;
    this.cache = new Map();
  }

  /**
   * @returns {{ count: number, medianLog: number, sigmaLog: number } | null}
   */
  async baselineFor(companyId, glNumber) {
    const key = `${companyId}:${glNumber}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const amounts = await this.entryRepository.amountsForAccount(companyId, glNumber);
    const value = this.#compute(amounts);
    this.cache.set(key, { value, expiresAt: Date.now() + AmountBaselineProvider.#TTL_MS });
    return value;
  }

  #compute(amounts) {
    const logs = amounts.filter((amount) => amount > 0).map((amount) => Math.log10(amount));
    if (logs.length === 0) return null;

    const medianLog = this.#median(logs);
    const deviations = logs.map((log) => Math.abs(log - medianLog));
    const sigmaLog = AmountBaselineProvider.#MAD_SIGMA * this.#median(deviations);

    return { count: logs.length, medianLog, sigmaLog };
  }

  #median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }
}
