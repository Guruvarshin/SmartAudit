import { App } from './app/App.js';
import { Config } from './config/Config.js';
import { MongoConnection } from './db/MongoConnection.js';
import { WorkerFactory } from './worker/WorkerFactory.js';

/**
 * Entry point for `npm run start:server`. Process concerns only — the
 * application itself lives in App.
 *
 * With RUN_WORKER_IN_PROCESS set, this process also runs the enrichment
 * worker. That is a deployment accommodation for single-process hosting, not
 * a change of architecture: the worker is the same class, assembled by the
 * same factory, and `npm run start:worker` still runs it standalone.
 */
class ServerCommand {
  constructor() {
    this.config = Config.load();
    this.connection = new MongoConnection(this.config.mongoUri);
    this.httpServer = null;
    this.worker = null;
  }

  async execute() {
    await this.connection.connect();

    const app = new App();
    this.httpServer = await app.listen(this.config.port);

    if (this.config.runWorkerInProcess) {
      this.worker = WorkerFactory.create(this.config, { name: `inproc${process.pid}` });
      this.worker.start();
    }

    this.#trapSignals();
  }

  #trapSignals() {
    let shuttingDown = false;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[server] ${signal} received, shutting down`);
        await new Promise((resolve) => this.httpServer?.close(resolve));
        await this.worker?.stop();
        await this.connection.disconnect();
        process.exit(0);
      });
    }
  }
}

try {
  await new ServerCommand().execute();
} catch (error) {
  console.error(`[server] failed to start: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
}
