import { setTimeout as sleep } from 'node:timers/promises';
import { ModelVersion } from '../domain/Constants.js';
import { AmountBaselineProvider } from './AmountBaselineProvider.js';
import { AnomalyDetector } from './AnomalyDetector.js';
import { ComplianceEvaluator } from './ComplianceEvaluator.js';
import { RiskScorer } from './RiskScorer.js';
import { VectorGenerator } from './VectorGenerator.js';

/**
 * Orchestrates the full intelligence pipeline for one journal entry: the
 * simulated model delay, the four engines, and the ordered two-collection
 * write.
 *
 * Write order is the Day 1 commit-point design (no cross-collection
 * transaction, by decision): vectors are upserted first, then a single fenced
 * $set lands the analytics AND flips enrichment.status to complete. The status
 * flip is the commit point — until it lands, the entry still reads as
 * processing and a crashed run is simply reclaimed after its lease and re-run
 * idempotently. No partial state is ever readable as complete.
 */
export class EnrichmentService {
  constructor({ entryRepository, entryVectorsRepository, delayMs, logger = console }) {
    this.entryRepository = entryRepository;
    this.entryVectorsRepository = entryVectorsRepository;
    this.delayMs = delayMs;
    this.logger = logger;

    this.baselineProvider = new AmountBaselineProvider({ entryRepository });
    this.anomalyDetector = new AnomalyDetector();
    this.riskScorer = new RiskScorer();
    this.complianceEvaluator = new ComplianceEvaluator();
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
   * The computation half, shared by every path: simulated ML delay, then
   * baseline fetch, anomaly signals, risk score, compliance flags, vectors.
   */
  async compute(entry, { simulateModelDelay }) {
    if (simulateModelDelay) {
      // SPEC.md Scenario A: the intelligence pipeline simulates a machine
      // learning model execution with an explicit delay.
      await sleep(this.delayMs);
    }

    const baseline = await this.baselineProvider.baselineFor(entry.companyId, entry.glNumber);
    const anomalies = this.anomalyDetector.detect(entry, baseline);
    const risk = this.riskScorer.score(anomalies);
    const compliance = this.complianceEvaluator.evaluate(anomalies, risk);
    const vectors = this.vectorGenerator.generate(entry);

    return { anomalies, risk, compliance, vectors };
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
    const computedAt = new Date();
    return {
      risk: {
        score: artifacts.risk.score,
        tier: artifacts.risk.tier,
        factors: artifacts.risk.factors,
        modelVersion: versions.risk,
        computedAt
      },
      compliance: {
        status: artifacts.compliance.status,
        flags: artifacts.compliance.flags,
        rulesetVersion: versions.complianceRuleset,
        evaluatedAt: computedAt
      },
      anomalies: artifacts.anomalies,
      anomalyModelVersion: versions.anomaly
    };
  }
}
