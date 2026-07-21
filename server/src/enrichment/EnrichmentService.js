import { setTimeout as sleep } from 'node:timers/promises';
import { ModelVersion } from '../domain/Constants.js';
import { PartialEvaluationService } from './PartialEvaluationService.js';
import { VectorGenerator } from './VectorGenerator.js';

/**
 * Orchestrates the FULL intelligence pipeline for one journal entry: the
 * simulated model delay, the risk half (delegated to PartialEvaluationService
 * so scoring has exactly one implementation), the vector half, and the ordered
 * two-collection write.
 *
 * Write order is the Day 1 commit-point design (no cross-collection
 * transaction, by decision): vectors are upserted first, then a single fenced
 * $set lands the analytics AND flips enrichment.status to complete. The status
 * flip is the commit point — until it lands, the entry still reads as
 * processing and a crashed run is simply reclaimed after its lease and re-run
 * idempotently. No partial state is ever readable as complete.
 */
export class EnrichmentService {
  constructor({
    entryRepository,
    entryVectorsRepository,
    delayMs,
    partialEvaluationService = null,
    logger = console
  }) {
    this.entryRepository = entryRepository;
    this.entryVectorsRepository = entryVectorsRepository;
    this.delayMs = delayMs;
    this.logger = logger;

    // The risk half. Injectable so the worker can share one instance (and its
    // baseline cache) between full and partial jobs.
    this.partialEvaluationService =
      partialEvaluationService ?? new PartialEvaluationService({ entryRepository, delayMs });
    this.vectorGenerator = new VectorGenerator();
  }

  /**
   * Runs the pipeline for a claimed job. Outcome is 'complete' when the fenced
   * commit landed, or 'discarded' when the fence rejected it (this worker's
   * claim expired and another worker took the job — the correct response is
   * to drop our result on the floor and move on). Artifacts are returned
   * either way so the caller can log what was computed without re-reading.
   *
   * @param {object} entry the claimed entry document
   * @returns {Promise<{ outcome: 'complete' | 'discarded', artifacts: object }>}
   */
  async process(entry) {
    const claim = {
      claimedAt: entry.analytics.enrichment.claimedAt,
      attempts: entry.analytics.enrichment.attempts
    };

    const artifacts = await this.compute(entry, { simulateModelDelay: true });
    await this.#persistVectors(entry, artifacts, ModelVersion.VECTOR);

    const committed = await this.entryRepository.completeEnrichment(
      entry._id,
      claim,
      this.#analyticsPayload(artifacts, {
        risk: ModelVersion.RISK,
        anomaly: ModelVersion.ANOMALY,
        complianceRuleset: ModelVersion.COMPLIANCE_RULESET
      })
    );
    return { outcome: committed ? 'complete' : 'discarded', artifacts };
  }

  /**
   * Enriches an entry outside the queue, without claim or fence — used by the
   * seed's --enrich-historical mode to backfill records as if a previous model
   * generation had processed them. Same engines, same write shape, different
   * version stamps; deliberately NOT a second implementation of enrichment.
   */
  async enrichDirect(entry, { versions, skipDelay = true }) {
    const artifacts = await this.compute(entry, { simulateModelDelay: !skipDelay });
    await this.#persistVectors(entry, artifacts, versions.vector);
    await this.entryRepository.forceEnrichmentResult(
      entry._id,
      this.#analyticsPayload(artifacts, versions)
    );
  }

  /**
   * Scenario C: re-enriches one stale entry at the CURRENT model versions,
   * with both writes guarded so a concurrently running worker (whose result
   * is computed from fresher content) is never clobbered:
   *
   *  - the vector replace lands only while the stored vector doc is still at
   *    a superseded version;
   *  - the analytics $set lands only while analytics.risk.modelVersion still
   *    reads the stale version this migration pass scanned.
   *
   * Both writes are idempotent and independently guarded, so a crash between
   * them re-converges on the next run: the entry still scans as stale, the
   * already-migrated half's guard simply misses, and the missing half lands.
   *
   * @returns {Promise<{ vectorsUpdated: boolean, analyticsUpdated: boolean }>}
   */
  async migrateStale(entry, { fromRiskVersion }) {
    const artifacts = await this.compute(entry, { simulateModelDelay: false });

    const vectorsUpdated = await this.entryVectorsRepository.replaceIfStale(
      entry._id,
      entry.companyId,
      artifacts.vectors,
      ModelVersion.VECTOR
    );
    const analyticsUpdated = await this.entryRepository.applyMigratedAnalytics(
      entry._id,
      fromRiskVersion,
      this.#analyticsPayload(artifacts, {
        risk: ModelVersion.RISK,
        anomaly: ModelVersion.ANOMALY,
        complianceRuleset: ModelVersion.COMPLIANCE_RULESET
      })
    );
    return { vectorsUpdated, analyticsUpdated };
  }

  /**
   * The computation half, shared by every path: simulated ML delay, then the
   * risk half (baseline, anomalies, score, compliance) plus the vectors.
   */
  async compute(entry, { simulateModelDelay }) {
    if (simulateModelDelay) {
      // SPEC.md Scenario A: the intelligence pipeline simulates a machine
      // learning model execution with an explicit delay.
      await sleep(this.delayMs);
    }

    const partial = await this.partialEvaluationService.compute(entry);
    const vectors = this.vectorGenerator.generate(entry);

    return { ...partial, vectors };
  }

  async #persistVectors(entry, artifacts, vectorModelVersion) {
    await this.entryVectorsRepository.upsertForEntry(
      entry._id,
      entry.companyId,
      artifacts.vectors,
      vectorModelVersion
    );
  }

  #analyticsPayload(artifacts, versions) {
    return this.partialEvaluationService.analyticsPayload(artifacts, versions);
  }
}
