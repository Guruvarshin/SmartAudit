import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/**
 * Reads the repo-root .env once and fails loudly on a missing required value
 * rather than letting `undefined` reach a connection string.
 */
export class Config {
  /** @type {Config | null} */
  static #instance = null;

  constructor(env = process.env) {
    this.mongoUri = this.#required(env, 'MONGODB_URI');
    this.port = this.#int(env, 'PORT', 4000);
    this.workerPollIntervalMs = this.#int(env, 'WORKER_POLL_INTERVAL_MS', 1000);
    this.workerConcurrency = this.#int(env, 'WORKER_CONCURRENCY', 4);
    this.workerLeaseMs = this.#int(env, 'WORKER_LEASE_MS', 60000);
    this.workerMaxAttempts = this.#int(env, 'WORKER_MAX_ATTEMPTS', 3);
    this.enrichmentDelayMs = this.#int(env, 'ENRICHMENT_DELAY_MS', 400);
    this.migrationBatchSize = this.#int(env, 'MIGRATION_BATCH_SIZE', 100);
    this.seedCount = this.#int(env, 'SEED_COUNT', 500);
    this.seedRandomSeed = this.#int(env, 'SEED_RANDOM_SEED', 20260720);
    Object.freeze(this);
  }

  /**
   * Loads .env from the repo root — the server runs from server/ and the
   * scripts from anywhere, so the path cannot be relative to cwd.
   */
  static load() {
    if (!Config.#instance) {
      dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });
      Config.#instance = new Config();
    }
    return Config.#instance;
  }

  static get repoRoot() {
    return REPO_ROOT;
  }

  #required(env, key) {
    const value = env[key];
    if (!value || String(value).trim() === '') {
      throw new Error(
        `Missing required environment variable ${key}. ` +
          `Copy .env.example to .env at the repo root and fill it in.`
      );
    }
    return String(value).trim();
  }

  #int(env, key, fallback) {
    const raw = env[key];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Environment variable ${key} must be an integer, got "${raw}".`);
    }
    return parsed;
  }
}
