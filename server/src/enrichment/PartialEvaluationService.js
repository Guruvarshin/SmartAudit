import { setTimeout as sleep } from 'node:timers/promises';
import { ModelVersion } from '../domain/Constants.js';
import { AmountBaselineProvider } from './AmountBaselineProvider.js';
import { AnomalyDetector } from './AnomalyDetector.js';
import { ComplianceEvaluator } from './ComplianceEvaluator.js';
import { RiskScorer } from './RiskScorer.js';

/**
 * The cheap half of the intelligence pipeline: anomaly signals, risk score,
 * compliance flags — everything EXCEPT vectors.
 *
 * This class exists so Scenario D is structurally incapable of touching the
 * vector layer (DECISIONS.md Day 1: "the risk/compliance path must never
 * import EntryVectors"). It imports neither the EntryVectors model nor its
 * repository, so no code path that runs through here — the worker's
 * context_shift jobs, or the bulk reevaluate:risk script — can reach the
 * expensive embeddings even by accident. EnrichmentService composes this class
 * for its risk half, so there is exactly one implementation of scoring, not a
 * full and a partial copy that could drift.
 *
 * Anomaly signals are recomputed here too, not just the risk/compliance
 * scalars: the score is a function of the signals, and a threshold shift
 * (APPROVAL_THRESHOLD, RiskThresholds) changes which signals fire. The spec's
 * boundary is cheap analytics vs expensive vectors, and signals sit on the
 * cheap side.
 */
export class PartialEvaluationService {
  constructor({ entryRepository, delayMs = 0 }) {
    this.entryRepository = entryRepository;
    this.delayMs = delayMs;

    this.baselineProvider = new AmountBaselineProvider({ entryRepository });
    this.anomalyDetector = new AnomalyDetector();
    this.riskScorer = new RiskScorer();
    this.complianceEvaluator = new ComplianceEvaluator();
  }

  /**
   * Runs the partial pipeline for a claimed context_shift job and commits it
   * through the same fenced write as a full run. completeEnrichment touches
   * analytics.* paths only, so the "vectors entirely untouched" guarantee is
   * carried by both the import boundary of this class and the shape of the
   * terminal write.
   *
   * @returns {Promise<{ outcome: 'complete' | 'discarded', artifacts: object }>}
   */
  async process(entry) {
    const claim = {
      claimedAt: entry.analytics.enrichment.claimedAt,
      attempts: entry.analytics.enrichment.attempts
    };

    const artifacts = await this.compute(entry, { simulateModelDelay: true });
    const committed = await this.entryRepository.completeEnrichment(
      entry._id,
      claim,
      this.analyticsPayload(artifacts, {
        risk: ModelVersion.RISK,
        anomaly: ModelVersion.ANOMALY,
        complianceRuleset: ModelVersion.COMPLIANCE_RULESET
      })
    );
    return { outcome: committed ? 'complete' : 'discarded', artifacts };
  }

  /**
   * Pure computation: baseline fetch, anomaly signals, risk score, compliance
   * flags. EnrichmentService calls this for its risk half (with the delay
   * already served on its side); the bulk reevaluate:risk script calls it with
   * no delay at all.
   *
   * @returns {Promise<{ anomalies: object[], risk: object, compliance: object }>}
   */
  async compute(entry, { simulateModelDelay = false } = {}) {
    if (simulateModelDelay) {
      await sleep(this.delayMs);
    }

    const baseline = await this.baselineProvider.baselineFor(entry.companyId, entry.glNumber);
    const anomalies = this.anomalyDetector.detect(entry, baseline);
    const risk = this.riskScorer.score(anomalies);
    const compliance = this.complianceEvaluator.evaluate(anomalies, risk);

    return { anomalies, risk, compliance };
  }

  /**
   * Shapes computed artifacts into the analytics sub-document written by
   * completeEnrichment / applyReEvaluatedAnalytics. Shared with
   * EnrichmentService so full and partial runs land byte-compatible analytics.
   */
  analyticsPayload(artifacts, versions) {
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
