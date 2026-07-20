import mongoose from 'mongoose';
import { Collections, VECTOR_DIMS } from '../domain/Constants.js';

const { Schema } = mongoose;

/**
 * The expensive half of the analytical layer, deliberately held in its own
 * collection rather than embedded on the entry.
 *
 * Why this is separate (see DECISIONS.md, Day 1):
 *
 *  1. Scenario D requires that a risk/compliance update leave the vectors
 *     "entirely untouched". With the vectors in a different collection that is
 *     a structural guarantee, not a coding convention someone has to remember —
 *     the risk-update path holds no handle to this model at all, so no `$set`
 *     can reach these fields even by accident.
 *  2. Read patterns diverge sharply. Vectors are consumed by exactly two
 *     things: the similarity endpoint and the diagnostics modal. The dashboard
 *     list — the hot path — never wants them, and embedding would drag ~1.5KB
 *     of doubles per row through every query that forgot to project them out.
 *  3. WiredTiger rewrites a whole document on any update, including a targeted
 *     `$set`. Scenario D is a bulk re-scoring pass; rewriting ~400-byte entry
 *     documents instead of ~2KB ones is the substance behind the spec's
 *     "avoid entire root document rewrites".
 *  4. This collection is the seam where a real vector store (Atlas Vector
 *     Search, pgvector, Pinecone) would later drop in without the ledger
 *     schema changing at all.
 */
const EntryVectorsSchema = new Schema(
  {
    // Deliberately the *same* ObjectId as the entry it describes. The 1:1
    // relationship is then enforced by the primary key itself — duplicates are
    // impossible and the join is a primary-key hit, needing no extra index.
    _id: { type: Schema.Types.ObjectId, required: true },

    // Denormalised so a similarity scan can be scoped to a single tenant
    // without joining back to the entries collection.
    companyId: { type: Schema.Types.ObjectId, required: true },

    // The three vector spaces required by SPEC.md §3.3.
    semantic: { type: [Number], required: true },
    financial: { type: [Number], required: true },
    entity: { type: [Number], required: true },

    dims: { type: Number, required: true, default: VECTOR_DIMS },

    // Precomputed L2 norms. Cosine similarity then reduces to a dot product
    // divided by the product of two stored scalars, so the per-candidate cost
    // during a search scan is one pass instead of three.
    norms: {
      semantic: { type: Number, required: true },
      financial: { type: Number, required: true },
      entity: { type: Number, required: true }
    },

    // Hash of the core entry fields these vectors were derived from. Makes
    // Scenario B concrete: edit `amount`, the hash changes, and the vectors are
    // demonstrably — not just presumably — recomputed.
    sourceHash: { type: String, required: true },

    // Scenario C migrates this from one version to the next.
    modelVersion: { type: String, required: true }
  },
  {
    collection: Collections.ENTRY_VECTORS,
    // `updated` is the witness for Scenario D: if a risk-only update ever
    // touched this document, this timestamp would move. It must not.
    timestamps: { createdAt: 'computedAt', updatedAt: 'updated' },
    strict: true,
    minimize: false,
    versionKey: false,
    _id: false // supplied explicitly from the entry's _id, never generated
  }
);

// Scenario C: keyset pagination over vectors stamped at a superseded model
// version — the migration pages on _id within a fixed modelVersion.
EntryVectorsSchema.index({ modelVersion: 1, _id: 1 }, { name: 'vector_model_version_scan' });

// Tenant-scoped similarity scans.
EntryVectorsSchema.index({ companyId: 1 }, { name: 'company_vectors' });

export const EntryVectors = mongoose.model('EntryVectors', EntryVectorsSchema);
