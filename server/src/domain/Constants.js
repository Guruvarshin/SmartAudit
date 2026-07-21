/**
 * Shared domain vocabulary.
 *
 * These are frozen value objects rather than classes because they carry no
 * behaviour — they are the enumerated vocabulary the schemas, worker, and
 * scripts all validate against. Everything with logic in this codebase is a
 * class (see CLAUDE.md constraint #1).
 */

/** Risk severity tiers. SPEC.md §3.1. */
export const RiskTier = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
});

/**
 * Score thresholds separating the tiers. Lives here (not inline in the scorer)
 * because Scenario D — a regulatory/threshold shift — mutates exactly these,
 * and they need to be addressable from the partial-evaluation script.
 */
export const RiskThresholds = Object.freeze({
  MEDIUM: 0.4,
  HIGH: 0.7
});

/**
 * Granular anomaly signal types. SPEC.md §3.2 requires signals that identify
 * both a type and the specific field they were raised against.
 */
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

/** Lifecycle of the asynchronous enrichment pipeline for a single entry. */
export const EnrichmentStatus = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETE: 'complete',
  FAILED: 'failed'
});

/** Why an entry was queued — drives which pipelines the worker runs. */
export const EnrichmentReason = Object.freeze({
  CREATE: 'create',
  CORE_FIELD_CHANGE: 'core_field_change',
  CONTEXT_SHIFT: 'context_shift',
  MODEL_MIGRATION: 'model_migration'
});

/** Compliance evaluation outcome. */
export const ComplianceStatus = Object.freeze({
  PASS: 'pass',
  REVIEW: 'review',
  FAIL: 'fail'
});

/** Auditor workflow states. Scenario E mutates these — metadata only. */
export const WorkflowStatus = Object.freeze({
  UNREVIEWED: 'unreviewed',
  IN_REVIEW: 'in_review',
  CLEARED: 'cleared',
  ESCALATED: 'escalated'
});

/**
 * The three vector spaces. SPEC.md §3.3 — semantic (text meaning), financial
 * (numeric patterns), entity (relational behaviour). These string values are
 * the "Search Strategy" accepted by POST /api/entries/search/similar.
 */
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
 * Vector dimensionality. Chosen so the analytical layer is genuinely heavier
 * than the baseline record (3 x 64 doubles ~= 1.5KB vs ~400 bytes), which is
 * what makes isolating it into its own collection a real optimisation rather
 * than a decorative one.
 */
export const VECTOR_DIMS = 64;

/**
 * An internal approval limit. Amounts clustering just beneath it are the
 * classic structuring pattern the rounding detector flags. Lives here — not in
 * the seed's reference data — because Scenario D ("internal thresholds shift")
 * mutates exactly this kind of value, and because the detector must never
 * import seed data: reading the answer key is not detection. The seed imports
 * *this* constant so planted data and detection stay aligned by construction.
 */
export const APPROVAL_THRESHOLD = 100000;

/**
 * Current model versions. Scenario C migrates historical records from an older
 * version to these.
 */
export const ModelVersion = Object.freeze({
  RISK: 'risk-v1',
  ANOMALY: 'anomaly-v1',
  VECTOR: 'vec-v1',
  COMPLIANCE_RULESET: 'ifrs-ruleset-v1'
});

/**
 * The versions those superseded. Exists so `npm run seed -- --enrich-historical`
 * can stamp records as enriched by the previous model generation, giving the
 * Scenario C migration genuinely stale data to page through.
 */
export const SupersededModelVersion = Object.freeze({
  RISK: 'risk-v0',
  ANOMALY: 'anomaly-v0',
  VECTOR: 'vec-v0',
  COMPLIANCE_RULESET: 'ifrs-ruleset-v0'
});

/**
 * Core financial fields. Editing any of these invalidates every computed
 * artefact and triggers a full recomputation — SPEC.md Scenario B. The delta
 * router (Day 3) reads this list; it is defined here so exactly one definition
 * of "core field" exists in the system.
 */
export const CORE_FINANCIAL_FIELDS = Object.freeze([
  'amount',
  'description',
  'glNumber',
  'postingDate'
]);

/** Collection names, centralised so scripts and models cannot drift apart. */
export const Collections = Object.freeze({
  ENTRIES: 'entries',
  ENTRY_VECTORS: 'entry_vectors'
});
