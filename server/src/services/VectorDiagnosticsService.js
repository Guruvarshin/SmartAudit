import mongoose from 'mongoose';
import { ModelVersion, VECTOR_SPACES } from '../domain/Constants.js';
import { HttpError } from '../http/HttpError.js';

/**
 * GET /api/entries/:id/vectors — the read-only vector view behind the
 * diagnostics modal's multi-vector panel (the second of the two consumers
 * Day 1 named for `entry_vectors`, alongside the similarity endpoint).
 *
 * A separate class rather than a method on EntryService on purpose:
 * EntryService owns the PUT path, whose Scenario D route must never hold a
 * handle to the vectors collection. Keeping this read in its own service
 * preserves that import boundary — EntryService still imports nothing
 * vector-shaped.
 */
export class VectorDiagnosticsService {
  constructor({ entryRepository, entryVectorsRepository }) {
    this.entryRepository = entryRepository;
    this.entryVectorsRepository = entryVectorsRepository;
  }

  /**
   * @returns {Promise<{ entryId: string, modelVersion: string, stale: boolean,
   *   sourceHash: string, dims: number,
   *   spaces: Record<string, { values: number[], norm: number }> }>}
   */
  async getForEntry(id) {
    const entryId = this.#objectId(id);

    const entry = await this.entryRepository.findById(entryId);
    if (!entry) throw HttpError.notFound(`no entry with id ${id}`);

    const vectors = await this.entryVectorsRepository.findByEntryId(entryId);
    if (!vectors) {
      throw HttpError.conflict(
        `entry ${id} has not been enriched yet (status: ` +
          `${entry.analytics?.enrichment?.status ?? 'unknown'}) — retry once the worker completes it`
      );
    }

    const spaces = {};
    for (const space of VECTOR_SPACES) {
      spaces[space] = { values: vectors[space], norm: vectors.norms[space] };
    }

    return {
      entryId: String(entryId),
      modelVersion: vectors.modelVersion,
      stale: vectors.modelVersion !== ModelVersion.VECTOR,
      sourceHash: vectors.sourceHash,
      dims: vectors.dims,
      spaces
    };
  }

  #objectId(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw HttpError.badRequest(`"${id}" is not a valid entry id`);
    }
    return new mongoose.Types.ObjectId(id);
  }
}
