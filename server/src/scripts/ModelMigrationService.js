import { ModelVersion } from '../domain/Constants.js';
import { KeysetPager } from '../util/KeysetPager.js';

/**
 * Pages through entries stamped at superseded model versions and re-enriches
 * each at the current versions, using keyset pagination so memory stays
 * bounded however deep the history is.
 *
 * Safe to run while the API and workers are live: every write is guarded, so
 * a concurrent recompute is never clobbered, and re-running after a crash
 * converges because the version stamp is itself the checkpoint.
 */
export class ModelMigrationService {
  constructor({ entryRepository, enrichmentService, batchSize, dryRun = false, logger = console }) {
    this.entryRepository = entryRepository;
    this.enrichmentService = enrichmentService;
    this.batchSize = batchSize;
    this.dryRun = dryRun;
    this.logger = logger;
  }

  async run() {
    const startedAt = Date.now();
    const staleVersions = await this.#staleVersions();

    if (staleVersions.length === 0) {
      this.logger.log(`[migrate] nothing to do — every entry is at ${ModelVersion.RISK}`);
      return { migrated: 0, skipped: 0, versions: {} };
    }

    const report = { migrated: 0, skipped: 0, versions: {} };
    for (const version of staleVersions) {
      const count = await this.entryRepository.countByRiskModelVersion(version);
      this.logger.log(
        `[migrate] ${count} completed entr${count === 1 ? 'y' : 'ies'} at ${version} ` +
          `→ ${ModelVersion.RISK}${this.dryRun ? ' (dry run, not migrating)' : ''}`
      );
      report.versions[version] = { found: count, migrated: 0, skipped: 0 };
      if (this.dryRun) continue;

      await this.#migrateVersion(version, report);
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    this.logger.log(
      this.dryRun
        ? `[migrate] dry run complete in ${seconds}s`
        : `[migrate] done in ${seconds}s — migrated=${report.migrated} skipped=${report.skipped}`
    );
    return report;
  }

  async #staleVersions() {
    const versions = await this.entryRepository.distinctRiskModelVersions();
    return versions.filter((version) => version && version !== ModelVersion.RISK);
  }

  async #migrateVersion(version, report) {
    const pager = new KeysetPager({
      batchSize: this.batchSize,
      fetchPage: (afterId, batchSize) =>
        this.entryRepository.pageByRiskModelVersion(version, afterId, batchSize)
    });

    let processed = 0;
    for await (const page of pager.pages()) {
      for (const entry of page) {
        const { analyticsUpdated } = await this.enrichmentService.migrateStale(entry, {
          fromRiskVersion: version
        });
        if (analyticsUpdated) {
          report.migrated += 1;
          report.versions[version].migrated += 1;
        } else {
          // A live worker re-stamped this entry between our page read and our
          // guarded write; its fresher result stands.
          report.skipped += 1;
          report.versions[version].skipped += 1;
        }
      }
      processed += page.length;
      this.logger.log(
        `[migrate] ${version}: ${processed}/${report.versions[version].found} processed ` +
          `(batch of ${page.length}, lastId=${page[page.length - 1]._id})`
      );
    }
  }
}
