import { ModelVersion } from '../domain/Constants.js';
import { KeysetPager } from '../util/KeysetPager.js';

/**
 * Bulk re-evaluation for a threshold or compliance-rule shift: re-derives
 * risk, compliance and anomaly signals for every settled entry via a targeted
 * $set on analytics.*, leaving vectors untouched.
 *
 * That last part is structural, not behavioural — nothing this class composes
 * imports the EntryVectors model or repository, so there is no code path from
 * here to the vectors collection at all.
 */
export class RiskReEvaluationService {
  constructor({ entryRepository, partialEvaluationService, batchSize, dryRun = false, logger = console }) {
    this.entryRepository = entryRepository;
    this.partialEvaluationService = partialEvaluationService;
    this.batchSize = batchSize;
    this.dryRun = dryRun;
    this.logger = logger;
  }

  async run() {
    const startedAt = Date.now();
    const report = { reEvaluated: 0, tierChanged: 0, skipped: 0 };

    if (this.dryRun) {
      const versions = await this.entryRepository.distinctRiskModelVersions();
      let total = 0;
      for (const version of versions.filter(Boolean)) {
        total += await this.entryRepository.countByRiskModelVersion(version);
      }
      this.logger.log(
        `[reevaluate] dry run: ${total} settled entr${total === 1 ? 'y' : 'ies'} would be ` +
          `re-scored under the current thresholds`
      );
      return report;
    }

    const pager = new KeysetPager({
      batchSize: this.batchSize,
      fetchPage: (afterId, batchSize) =>
        this.entryRepository.pageCompleteEntries(afterId, batchSize)
    });

    let processed = 0;
    for await (const page of pager.pages()) {
      for (const entry of page) {
        await this.#reEvaluate(entry, report);
      }
      processed += page.length;
      this.logger.log(
        `[reevaluate] ${processed} processed (batch of ${page.length}, ` +
          `lastId=${page[page.length - 1]._id})`
      );
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    this.logger.log(
      `[reevaluate] done in ${seconds}s — reEvaluated=${report.reEvaluated} ` +
        `tierChanged=${report.tierChanged} skipped=${report.skipped} — vectors untouched`
    );
    return report;
  }

  async #reEvaluate(entry, report) {
    const artifacts = await this.partialEvaluationService.compute(entry);
    const applied = await this.entryRepository.applyReEvaluatedAnalytics(
      entry._id,
      this.partialEvaluationService.analyticsPayload(artifacts, {
        risk: ModelVersion.RISK,
        anomaly: ModelVersion.ANOMALY,
        complianceRuleset: ModelVersion.COMPLIANCE_RULESET
      })
    );

    if (!applied) {
      // Re-queued or claimed since our page read; the in-flight recompute
      // will apply the current thresholds itself.
      report.skipped += 1;
      return;
    }
    report.reEvaluated += 1;
    if (artifacts.risk.tier !== entry.analytics?.risk?.tier) {
      report.tierChanged += 1;
      this.logger.log(
        `[reevaluate] ${entry._id} (${entry.entryNo}): tier ` +
          `${entry.analytics?.risk?.tier} → ${artifacts.risk.tier} ` +
          `(score ${entry.analytics?.risk?.score} → ${artifacts.risk.score})`
      );
    }
  }
}
