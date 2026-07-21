import mongoose from 'mongoose';
import { Collections, VECTOR_DIMS } from '../domain/Constants.js';

const { Schema } = mongoose;

/**
 * The expensive half of the analytical layer, held in its own collection
 * rather than embedded on the entry.
 *
 * Separating it makes "a risk update leaves vectors untouched" a structural
 * fact rather than a convention: the risk-update path holds no handle to this
 * model, so no $set can reach these fields even by accident. It also keeps
 * ~1.5KB of doubles per row off the dashboard's hot path, and leaves a clean
 * seam for a real vector store to drop in later.
 */
const EntryVectorsSchema = new Schema(
  {
    // The same ObjectId as the entry it describes, so the 1:1 relationship is
    // enforced by the primary key and the join is a PK hit.
    _id: { type: Schema.Types.ObjectId, required: true },

    // Denormalised so a similarity scan can be tenant-scoped without a join.
    companyId: { type: Schema.Types.ObjectId, required: true },

    semantic: { type: [Number], required: true },
    financial: { type: [Number], required: true },
    entity: { type: [Number], required: true },

    dims: { type: Number, required: true, default: VECTOR_DIMS },

    // Precomputed so cosine reduces to a dot product over two stored scalars.
    norms: {
      semantic: { type: Number, required: true },
      financial: { type: Number, required: true },
      entity: { type: Number, required: true }
    },

    // Hash of the core fields these vectors were derived from.
    sourceHash: { type: String, required: true },

    modelVersion: { type: String, required: true }
  },
  {
    collection: Collections.ENTRY_VECTORS,
    // `updated` is the witness that a risk-only update did not touch this
    // document: it must not move during one.
    timestamps: { createdAt: 'computedAt', updatedAt: 'updated' },
    strict: true,
    minimize: false,
    versionKey: false,
    _id: false // supplied from the entry's _id, never generated
  }
);

// Keyset pagination for the model migration.
EntryVectorsSchema.index({ modelVersion: 1, _id: 1 }, { name: 'vector_model_version_scan' });

EntryVectorsSchema.index({ companyId: 1 }, { name: 'company_vectors' });

export const EntryVectors = mongoose.model('EntryVectors', EntryVectorsSchema);
