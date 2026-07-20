import mongoose from 'mongoose';

/**
 * Owns the Mongoose connection lifecycle.
 *
 * Every entry point (server, worker, seed, migration CLI) goes through this
 * class so connection options, index synchronisation, and shutdown behave
 * identically regardless of which process is running.
 */
export class MongoConnection {
  constructor(uri, { logger = console } = {}) {
    this.uri = uri;
    this.logger = logger;
    this.connection = null;
  }

  async connect() {
    if (this.connection) return this.connection;

    // Fail fast rather than buffering commands for 30s when Mongo is not up —
    // the most common local failure is simply forgetting `docker compose up`,
    // and a prompt, clear error is worth more than a retry here.
    mongoose.set('bufferCommands', false);
    mongoose.set('strictQuery', true);

    await mongoose.connect(this.uri, {
      serverSelectionTimeoutMS: 8000,
      maxPoolSize: 20
    });

    this.connection = mongoose.connection;
    const { host, port, name } = this.connection;
    this.logger.log(`[mongo] connected to ${host}:${port}/${name}`);
    return this.connection;
  }

  /**
   * Brings the deployed indexes in line with the schema definitions, dropping
   * any that are no longer declared. Called by the seed script; the server and
   * worker rely on indexes already being in place rather than building them on
   * every boot.
   */
  async syncIndexes(models) {
    for (const model of models) {
      await model.syncIndexes();
      this.logger.log(`[mongo] indexes synced: ${model.collection.collectionName}`);
    }
  }

  async disconnect() {
    if (!this.connection) return;
    await mongoose.disconnect();
    this.connection = null;
  }
}
