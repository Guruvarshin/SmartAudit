import { Config } from '../config/Config.js';
import { MongoConnection } from '../db/MongoConnection.js';
import { EnrichmentService } from '../enrichment/EnrichmentService.js';
import { PartialEvaluationService } from '../enrichment/PartialEvaluationService.js';
import { EntryRepository } from '../repositories/EntryRepository.js';
import { EntryVectorsRepository } from '../repositories/EntryVectorsRepository.js';
import { CliArguments } from '../util/CliArguments.js';
import { EnrichmentWorker } from './EnrichmentWorker.js';

/**
 * Entry point for `npm run start:worker`. Accepts --name (to label logs when
 * running several) and --concurrency.
 *
 * Running more than one process at once is safe; the atomic claim in
 * EntryRepository is what guarantees it.
 */
class WorkerCommand {
  constructor() {
    this.config = Config.load();
    this.args = new CliArguments();
    this.connection = new MongoConnection(this.config.mongoUri);
    this.worker = null;
  }

  async execute() {
    await this.connection.connect();

    const entryRepository = new EntryRepository();
    const entryVectorsRepository = new EntryVectorsRepository();
    // Shared: partial jobs run this directly and the full pipeline composes
    // it, so there is one scoring implementation rather than two that drift.
    const partialEvaluationService = new PartialEvaluationService({
      entryRepository,
      delayMs: this.config.enrichmentDelayMs
    });
    const enrichmentService = new EnrichmentService({
      entryRepository,
      entryVectorsRepository,
      partialEvaluationService,
      delayMs: this.config.enrichmentDelayMs
    });

    this.worker = new EnrichmentWorker({
      entryRepository,
      enrichmentService,
      partialEvaluationService,
      pollIntervalMs: this.config.workerPollIntervalMs,
      leaseMs: this.config.workerLeaseMs,
      concurrency: this.args.int('concurrency', this.config.workerConcurrency),
      maxAttempts: this.config.workerMaxAttempts,
      name: this.args.string('name', `pid${process.pid}`)
    });

    this.worker.start();
    this.#trapSignals();
  }

  #trapSignals() {
    let shuttingDown = false;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[worker] ${signal} received — finishing in-flight jobs`);
        await this.worker.stop();
        await this.connection.disconnect();
        process.exit(0);
      });
    }
  }
}

try {
  await new WorkerCommand().execute();
} catch (error) {
  console.error(`[worker] failed to start: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
}
