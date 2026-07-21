import mongoose from 'mongoose';

/**
 * Every entry point goes through this class so connection options, index
 * synchronisation and shutdown behave identically in each process.
 */
export class MongoConnection {
  constructor(uri, { logger = console } = {}) {
    this.uri = uri;
    this.logger = logger;
    this.connection = null;
  }

  async connect() {
    if (this.connection) return this.connection;

    // Fail fast rather than buffering for 30s: the usual cause is simply
    // forgetting `docker compose up`, and a prompt error beats a retry.
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
   * Called by the seed script only; the server and worker rely on indexes
   * already existing rather than building them on every boot.
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
