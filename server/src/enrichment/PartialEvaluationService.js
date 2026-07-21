import { setTimeout as sleep } from 'node:timers/promises';
import { ModelVersion } from '../domain/Constants.js';
import { AmountBaselineProvider } from './AmountBaselineProvider.js';
import { AnomalyDetector } from './AnomalyDetector.js';
import { ComplianceEvaluator } from './ComplianceEvaluator.js';
import { RiskScorer } from './RiskScorer.js';

/**
 * Anomaly signals, risk score and compliance flags - everything except vectors.
 *
 * This class deliberately imports neither the EntryVectors model nor its
 * repository. That import boundary is what makes it impossible for a
 * risk-only re-evaluation to touch the vector layer, rather than merely
 * unlikely. EnrichmentService composes it, so scoring has one implementation.
 *
 * Anomaly signals are recomputed here too, not just the scalars: the score is
 * a function of the signals, and a threshold shift changes which ones fire.
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
   * Commits through the same fenced write as a full run; that write touches
   * analytics.* paths only.
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

  /** Shared with EnrichmentService so full and partial runs land the same shape. */
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
