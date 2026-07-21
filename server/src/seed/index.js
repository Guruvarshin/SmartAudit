import { Config } from '../config/Config.js';
import { MongoConnection } from '../db/MongoConnection.js';
import { CliArguments } from '../util/CliArguments.js';
import { SeedRunner } from './SeedRunner.js';

/**
 * Entry point for `npm run seed`. Accepts --count, --seed, and
 * --enrich-historical (backfills at superseded model versions, giving the
 * migration stale records to work on).
 */
class SeedCommand {
  constructor() {
    this.config = Config.load();
    this.args = new CliArguments();
    this.connection = new MongoConnection(this.config.mongoUri);
  }

  async execute() {
    const count = this.args.int('count', this.config.seedCount);
    const seed = this.args.int('seed', this.config.seedRandomSeed);
    const enrichHistorical = this.args.bool('enrich-historical');

    await this.connection.connect();
    try {
      const runner = new SeedRunner({ count, seed, enrichHistorical });
      await runner.run();
      console.log('[seed] done');
    } finally {
      await this.connection.disconnect();
    }
  }
}

try {
  await new SeedCommand().execute();
  process.exit(0);
} catch (error) {
  console.error(`[seed] failed: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
}
