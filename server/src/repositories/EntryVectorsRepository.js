import { EntryVectors } from '../models/EntryVectors.js';

/**
 * All access to the `entry_vectors` collection.
 *
 * The risk-update path must never import this class - that import boundary is
 * what guarantees a risk-only update cannot touch vectors.
 */
export class EntryVectorsRepository {
  /** Upsert-replace so a retry or recomputation lands the same way as a first run. */
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
   * Projected to a single space plus its norm, so a scan reads about a third
   * of each document and memory stays bounded by the cursor batch.
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
   * Replaces vectors only while they are still stamped at a superseded
   * version, so the migration can never overwrite a worker's newer result.
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
