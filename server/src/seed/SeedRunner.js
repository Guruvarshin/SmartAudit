import { SupersededModelVersion } from '../domain/Constants.js';
import { EnrichmentService } from '../enrichment/EnrichmentService.js';
import { Entry } from '../models/Entry.js';
import { EntryVectors } from '../models/EntryVectors.js';
import { EntryRepository } from '../repositories/EntryRepository.js';
import { EntryVectorsRepository } from '../repositories/EntryVectorsRepository.js';
import { EntryFactory } from './EntryFactory.js';
import { COMPANIES } from './LedgerReferenceData.js';

const INSERT_CHUNK_SIZE = 250;

/**
 * Clears prior seed data, rebuilds indexes, inserts a generated ledger, and
 * reports what was planted — that report is what detection output gets
 * compared against.
 */
export class SeedRunner {
  constructor({ count, seed, enrichHistorical = false, logger = console }) {
    this.count = count;
    this.seed = seed;
    this.enrichHistorical = enrichHistorical;
    this.logger = logger;
  }

  async run() {
    this.logger.log(`[seed] generating ${this.count} entries (random seed ${this.seed})`);

    await this.#resetCollections();
    await this.#syncIndexes();

    const factory = new EntryFactory({ seed: this.seed, count: this.count });
    const { documents, tags } = factory.build();

    await this.#insert(documents);
    if (this.enrichHistorical) await this.#enrichHistorical();
    await this.#report(documents, tags);

    return { inserted: documents.length };
  }

  /**
   * Backfills every seeded entry through the real enrichment service, stamped
   * at superseded model versions, so the migration has genuinely stale records
   * to page through. Deliberately not a second implementation — the same
   * service with different version stamps, minus the simulated delay.
   */
  async #enrichHistorical() {
    const entryRepository = new EntryRepository();
    const service = new EnrichmentService({
      entryRepository,
      entryVectorsRepository: new EntryVectorsRepository(),
      delayMs: 0
    });
    const versions = {
      risk: SupersededModelVersion.RISK,
      anomaly: SupersededModelVersion.ANOMALY,
      vector: SupersededModelVersion.VECTOR,
      complianceRuleset: SupersededModelVersion.COMPLIANCE_RULESET
    };

    this.logger.log(
      `[seed] enriching historical records at superseded model versions (${versions.risk}, ${versions.vector})`
    );

    let enriched = 0;
    // Keyset walk in _id order: no skip(), no unbounded cursor held across
    // slow work.
    let lastId = null;
    for (;;) {
      const batch = await Entry.find(lastId ? { _id: { $gt: lastId } } : {})
        .sort({ _id: 1 })
        .limit(100)
        .lean();
      if (batch.length === 0) break;

      for (const entry of batch) {
        await service.enrichDirect(entry, { versions });
        enriched += 1;
      }
      lastId = batch[batch.length - 1]._id;
      this.logger.log(`[seed]   enriched ${enriched}/${this.count}`);
    }
  }

  /**
   * Drops both collections so re-running the seed is idempotent; appending
   * would break the per-company unique index on entryNo.
   */
  async #resetCollections() {
    for (const model of [Entry, EntryVectors]) {
      try {
        await model.collection.drop();
        this.logger.log(`[seed] dropped ${model.collection.collectionName}`);
      } catch (error) {
        // 26 = NamespaceNotFound: nothing to drop on a first run.
        if (error.code !== 26) throw error;
      }
    }
  }

  async #syncIndexes() {
    // Built before insertion so the unique (companyId, entryNo) constraint
    // validates the generated data rather than being applied after the fact.
    await Entry.syncIndexes();
    await EntryVectors.syncIndexes();
    this.logger.log('[seed] indexes synced');
  }

  async #insert(documents) {
    for (let i = 0; i < documents.length; i += INSERT_CHUNK_SIZE) {
      const chunk = documents.slice(i, i + INSERT_CHUNK_SIZE);
      // Preserves the factory's historical created/updated values; otherwise
      // Mongoose stamps everything now and the ledger has no history.
      await Entry.insertMany(chunk, { ordered: true, timestamps: false });
    }
    this.logger.log(`[seed] inserted ${documents.length} entries`);
  }

  async #report(documents, tags) {
    const cohortCounts = new Map();
    for (const tagList of tags) {
      for (const tag of tagList) {
        cohortCounts.set(tag, (cohortCounts.get(tag) ?? 0) + 1);
      }
    }

    const entryCount = await Entry.countDocuments();
    const vectorCount = await EntryVectors.countDocuments();
    const pendingCount = await Entry.countDocuments({
      'analytics.enrichment.status': 'pending'
    });

    const dates = documents.map((d) => d.postingDate.getTime());
    const oldest = new Date(Math.min(...dates)).toISOString().slice(0, 10);
    const newest = new Date(Math.max(...dates)).toISOString().slice(0, 10);

    this.logger.log('');
    this.logger.log('  Planted cohorts');
    this.logger.log('  ' + '-'.repeat(46));
    const sorted = [...cohortCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cohort, count] of sorted) {
      const pct = ((count / documents.length) * 100).toFixed(1).padStart(5);
      this.logger.log(`  ${cohort.padEnd(20)} ${String(count).padStart(5)}   ${pct}%`);
    }
    this.logger.log('  ' + '-'.repeat(46));
    this.logger.log(
      '  (tags overlap: some entries are both unbalanced and off-hours, so risk',
    );
    this.logger.log('   scoring has to combine factors rather than branch on one)');
    this.logger.log('');

    this.logger.log('  Ledger');
    this.logger.log('  ' + '-'.repeat(46));
    this.logger.log(`  entries in database        ${entryCount}`);
    this.logger.log(`  awaiting enrichment        ${pendingCount}`);
    this.logger.log(
      this.enrichHistorical
        ? `  vector documents           ${vectorCount}  (historical, stamped at superseded model versions)`
        : `  vector documents           ${vectorCount}  (expected 0 until the worker runs)`
    );
    this.logger.log(`  posting date range         ${oldest} .. ${newest}`);
    for (const company of COMPANIES) {
      const n = await Entry.countDocuments({ companyId: company._id });
      this.logger.log(`  ${company.name.padEnd(34)} ${n}`);
    }
    this.logger.log('');
  }
}
