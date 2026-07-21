/**
 * Shared domain vocabulary.
 *
 * Frozen value objects rather than classes because they carry no behaviour —
 * they are the enumerated vocabulary the schemas, worker and scripts all
 * validate against. The strict-OO requirement applies to anything carrying
 * logic; declarative data like this is not wrapped in a ceremonial class.
 */

export const RiskTier = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
});

/**
 * Lives here, not inline in the scorer, because a regulatory or threshold
 * shift mutates exactly these and the re-evaluation script needs to address
 * them.
 */
export const RiskThresholds = Object.freeze({
  MEDIUM: 0.4,
  HIGH: 0.7
});

export const AnomalyType = Object.freeze({
  NUMERIC_OUTLIER: 'numeric_outlier',
  SEMANTIC_ANOMALY: 'semantic_anomaly',
  BALANCE_MISMATCH: 'balance_mismatch',
  TEMPORAL_ANOMALY: 'temporal_anomaly',
  ROUNDING_PATTERN: 'rounding_pattern'
});

export const AnomalySeverity = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical'
});

export const EnrichmentStatus = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETE: 'complete',
  FAILED: 'failed'
});

/** Why an entry was queued — drives which pipeline the worker runs. */
export const EnrichmentReason = Object.freeze({
  CREATE: 'create',
  CORE_FIELD_CHANGE: 'core_field_change',
  CONTEXT_SHIFT: 'context_shift',
  MODEL_MIGRATION: 'model_migration'
});

/**
 * Reasons whose jobs run the full pipeline. `context_shift` is deliberately
 * absent: it runs the partial pipeline, which has no handle to the vectors
 * collection. The delta router must never let a partial enqueue overwrite one
 * of these, since that would drop a recompute the entry is still owed.
 */
export const FULL_RECOMPUTE_REASONS = Object.freeze([
  EnrichmentReason.CREATE,
  EnrichmentReason.CORE_FIELD_CHANGE,
  EnrichmentReason.MODEL_MIGRATION
]);

export const ComplianceStatus = Object.freeze({
  PASS: 'pass',
  REVIEW: 'review',
  FAIL: 'fail'
});

export const WorkflowStatus = Object.freeze({
  UNREVIEWED: 'unreviewed',
  IN_REVIEW: 'in_review',
  CLEARED: 'cleared',
  ESCALATED: 'escalated'
});

/** These string values are the search strategies accepted by the similarity endpoint. */
export const VectorSpace = Object.freeze({
  SEMANTIC: 'semantic',
  FINANCIAL: 'financial',
  ENTITY: 'entity'
});

export const VECTOR_SPACES = Object.freeze([
  VectorSpace.SEMANTIC,
  VectorSpace.FINANCIAL,
  VectorSpace.ENTITY
]);

/**
 * Chosen so the analytical layer is genuinely heavier than the baseline record
 * (3 x 64 doubles vs a few hundred bytes), which is what makes isolating it
 * into its own collection a real optimisation rather than a decorative one.
 */
export const VECTOR_DIMS = 64;

/**
 * An internal approval limit; amounts clustering just beneath it are the
 * classic structuring pattern. Lives here rather than in the seed's reference
 * data because a threshold shift mutates exactly this, and because the
 * detector must never import seed data — reading the answer key is not
 * detection. The seed imports this constant so planted data and detection
 * cannot drift apart.
 */
export const APPROVAL_THRESHOLD = 100000;

export const ModelVersion = Object.freeze({
  RISK: 'risk-v1',
  ANOMALY: 'anomaly-v1',
  VECTOR: 'vec-v1',
  COMPLIANCE_RULESET: 'ifrs-ruleset-v1'
});

/**
 * The versions those superseded, so the seed can stamp records as enriched by
 * a previous model generation and give the migration genuinely stale data.
 */
export const SupersededModelVersion = Object.freeze({
  RISK: 'risk-v0',
  ANOMALY: 'anomaly-v0',
  VECTOR: 'vec-v0',
  COMPLIANCE_RULESET: 'ifrs-ruleset-v0'
});

/**
 * Editing any of these invalidates every computed artefact and triggers a full
 * recomputation. Defined here so exactly one definition of "core field" exists.
 */
export const CORE_FINANCIAL_FIELDS = Object.freeze([
  'amount',
  'description',
  'glNumber',
  'postingDate'
]);

/**
 * Deliberately not core fields: the spec enumerates its invalidation set
 * exhaustively and leaves debit/credit outside it. Editing a side changes the
 * balance signal, so risk and compliance must be re-evaluated, but by that
 * list it does not invalidate the vectors.
 */
export const BALANCE_FIELDS = Object.freeze(['debit', 'credit']);

/** Returned in the PUT response so the routing decision is observable. */
export const UpdateScenario = Object.freeze({
  CORE_FIELD_CHANGE: 'B',
  RISK_CONTEXT_CHANGE: 'D',
  METADATA_ONLY: 'E',
  NO_OP: 'no_op'
});

export const Collections = Object.freeze({
  ENTRIES: 'entries',
  ENTRY_VECTORS: 'entry_vectors'
});
