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

  /**
   * Streaming cursor over one tenant's vectors, projected down to a SINGLE
   * space (plus its norm and the model version) — a similarity scan reads a
   * third of each document, and memory stays bounded by the cursor batch no
   * matter how large the collection grows.
   */
  streamCompanySpace(companyId, space) {
    return EntryVectors.find(
      { companyId },
      { [space]: 1, [`norms.${space}`]: 1, modelVersion: 1 }
    )
      .lean()
      .cursor({ batchSize: 200 });
  }

  /**
   * Scenario C's vector write: replaces the stored vectors ONLY while they
   * are still stamped at a superseded version. If a live worker already wrote
   * current-version vectors (necessarily computed from content at least as
   * fresh as the migration's read), the guard misses and that write stands —
   * the migration can never overwrite a newer computation with an older one.
   *
   * @returns {Promise<boolean>} false when the guard rejected the write
   */
  async replaceIfStale(entryId, companyId, vectors, currentModelVersion) {
    const result = await EntryVectors.replaceOne(
      { _id: entryId, modelVersion: { $ne: currentModelVersion } },
      {
        companyId,
        semantic: vectors.semantic,
        financial: vectors.financial,
        entity: vectors.entity,
        dims: vectors.dims,
        norms: vectors.norms,
        sourceHash: vectors.sourceHash,
        modelVersion: currentModelVersion
      }
    );
    return result.matchedCount === 1;
  }

  async count() {
    return EntryVectors.countDocuments();
  }
}
