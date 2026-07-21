import { setTimeout as sleep } from 'node:timers/promises';
import { ModelVersion } from '../domain/Constants.js';
import { PartialEvaluationService } from './PartialEvaluationService.js';
import { VectorGenerator } from './VectorGenerator.js';

/**
 * The full pipeline: risk (delegated to PartialEvaluationService so scoring
 * has one implementation) plus vectors, and the ordered two-collection write.
 *
 * There is no cross-collection transaction. Vectors are written first, then a
 * single fenced $set lands the analytics and flips status to complete — that
 * flip is the commit point, so a crashed run is simply reclaimed after its
 * lease and re-run, and no partial state is ever readable as complete.
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

    // Injectable so the worker can share one instance, and its baseline cache,
    // between full and partial jobs.
    this.partialEvaluationService =
      partialEvaluationService ?? new PartialEvaluationService({ entryRepository, delayMs });
    this.vectorGenerator = new VectorGenerator();
  }

  /** 'discarded' means the fence rejected the commit: another worker owns the job now. */
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
   * Enriches outside the queue, for the seed's historical backfill. Same
   * engines and write shape as a real run, only the version stamps differ.
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
   * Re-enriches one stale entry at the current model versions. Both writes
   * are independently guarded on the stale stamp still being in place, so a
   * concurrent worker is never clobbered and a crash between them
   * re-converges on the next run.
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

  /** Pure computation, shared by every path — no writes. */
  async compute(entry, { simulateModelDelay }) {
    if (simulateModelDelay) {
      // Stands in for a real model execution (spec: Scenario A).
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
