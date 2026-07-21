import { App } from './app/App.js';
import { Config } from './config/Config.js';
import { MongoConnection } from './db/MongoConnection.js';

/**
 * Entry point for `npm run start:server`. Process concerns only — the
 * application itself lives in App.
 */
class ServerCommand {
  constructor() {
    this.config = Config.load();
    this.connection = new MongoConnection(this.config.mongoUri);
    this.httpServer = null;
  }

  async execute() {
    await this.connection.connect();
    const app = new App();
    this.httpServer = await app.listen(this.config.port);
    this.#trapSignals();
  }

  #trapSignals() {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        console.log(`[server] ${signal} received, shutting down`);
        this.httpServer?.close(async () => {
          await this.connection.disconnect();
          process.exit(0);
        });
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
