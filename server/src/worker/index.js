import { Config } from '../config/Config.js';
import { MongoConnection } from '../db/MongoConnection.js';
import { CliArguments } from '../util/CliArguments.js';
import { WorkerFactory } from './WorkerFactory.js';

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
    this.connection = new MongoConnection(this.config.mongoUri, {
      serverSelectionTimeoutMS: this.config.mongoServerSelectionTimeoutMs
    });
    this.worker = null;
  }

  async execute() {
    await this.connection.connect();

    this.worker = WorkerFactory.create(this.config, {
      name: this.args.string('name', `pid${process.pid}`),
      concurrency: this.args.int('concurrency', this.config.workerConcurrency)
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
