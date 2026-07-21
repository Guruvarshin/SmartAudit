import { EntryVectors } from '../models/EntryVectors.js';

/**
 * All access to the `entry_vectors` collection — the expensive half of the
 * analytical layer.
 *
 * Deliberately narrow: only enrichment (and, from Day 3, the similarity
 * search and model migration) may hold an instance. The Scenario D
 * risk-update path must never import this class — that import boundary is the
 * structural guarantee that a risk update cannot touch vectors.
 */
export class EntryVectorsRepository {
  /**
   * Idempotent write of an entry's vectors, keyed on the shared _id. An upsert
   * replace rather than an insert so a lease-expired retry, or a Scenario B
   * recomputation, lands the same way as a first run: exactly one vector
   * document per entry, reflecting the latest computation.
   */
  async upsertForEntry(entryId, companyId, vectors, modelVersion) {
    await EntryVectors.replaceOne(
      { _id: entryId },
      {
        companyId,
        semantic: vectors.semantic,
        financial: vectors.financial,
        entity: vectors.entity,
        dims: vectors.dims,
        norms: vectors.norms,
        sourceHash: vectors.sourceHash,
        modelVersion
      },
      { upsert: true }
    );
  }

  async findByEntryId(entryId) {
    return EntryVectors.findById(entryId).lean();
  }

  async count() {
    return EntryVectors.countDocuments();
  }
}
