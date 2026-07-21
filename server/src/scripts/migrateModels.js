import { Config } from '../config/Config.js';
import { MongoConnection } from '../db/MongoConnection.js';
import { EnrichmentService } from '../enrichment/EnrichmentService.js';
import { EntryRepository } from '../repositories/EntryRepository.js';
import { EntryVectorsRepository } from '../repositories/EntryVectorsRepository.js';
import { CliArguments } from '../util/CliArguments.js';
import { ModelMigrationService } from './ModelMigrationService.js';

/**
 * Entry point for `npm run migrate:models`. Accepts --dry-run and
 * --batch-size. Prime stale data first with `npm run seed -- --enrich-historical`.
 */
class MigrateModelsCommand {
  constructor() {
    this.config = Config.load();
    this.args = new CliArguments();
    this.connection = new MongoConnection(this.config.mongoUri);
  }

  async execute() {
    const batchSize = this.args.int('batch-size', this.config.migrationBatchSize);
    if (batchSize < 1) throw new Error('--batch-size must be at least 1');
    const dryRun = this.args.bool('dry-run');

    await this.connection.connect();
    try {
      const entryRepository = new EntryRepository();
      const entryVectorsRepository = new EntryVectorsRepository();
      const enrichmentService = new EnrichmentService({
        entryRepository,
        entryVectorsRepository,
        delayMs: 0 // the 400ms simulation belongs to the async worker, not a bulk CLI
      });

      const migration = new ModelMigrationService({
        entryRepository,
        enrichmentService,
        batchSize,
        dryRun
      });
      await migration.run();
    } finally {
      await this.connection.disconnect();
    }
  }
}

try {
  await new MigrateModelsCommand().execute();
  process.exit(0);
} catch (error) {
  console.error(`[migrate] failed: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
}
