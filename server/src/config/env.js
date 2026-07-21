import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * Side-effect module: loads the repo-root .env into process.env.
 *
 * Imported first by both Config and the domain constants, because some
 * constants (model versions, risk thresholds) are environment-tunable and are
 * evaluated at module load - before any entry point could call a loader
 * function. ES module imports execute in source order, so importing this file
 * first guarantees the values are present.
 *
 * dotenv does not override variables already set in the real environment, so
 * a host's dashboard configuration always wins over a stray local .env.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });
