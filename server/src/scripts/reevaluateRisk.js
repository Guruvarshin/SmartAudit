import { Config } from '../config/Config.js';
import { MongoConnection } from '../db/MongoConnection.js';
import { PartialEvaluationService } from '../enrichment/PartialEvaluationService.js';
import { EntryRepository } from '../repositories/EntryRepository.js';
import { CliArguments } from '../util/CliArguments.js';
import { RiskReEvaluationService } from './RiskReEvaluationService.js';

/**
 * Entry point for `npm run reevaluate:risk` — SPEC.md Scenario D's partial
 * evaluation script. Run it after shifting RiskThresholds or
 * APPROVAL_THRESHOLD in domain/Constants.js; it re-scores every settled entry
 * under the new context via targeted $set operators, leaving the vector
 * collection entirely untouched.
 *
 *   npm run reevaluate:risk
 *   npm run reevaluate:risk -- --dry-run
 *   npm run reevaluate:risk -- --batch-size=50
 *
 * Note what is NOT imported here: EntryVectorsRepository. This process holds
 * no handle to the vectors collection at all.
 */
class ReEvaluateRiskCommand {
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
      const reEvaluation = new RiskReEvaluationService({
        entryRepository,
        partialEvaluationService: new PartialEvaluationService({ entryRepository }),
        batchSize,
        dryRun
      });
      await reEvaluation.run();
    } finally {
      await this.connection.disconnect();
    }
  }
}

try {
  await new ReEvaluateRiskCommand().execute();
  process.exit(0);
} catch (error) {
  console.error(`[reevaluate] failed: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
}
