import mongoose from 'mongoose';
import {
  AnomalySeverity,
  AnomalyType,
  Collections,
  ComplianceStatus,
  EnrichmentReason,
  EnrichmentStatus,
  RiskTier,
  WorkflowStatus
} from '../domain/Constants.js';

const { Schema } = mongoose;

/**
 * One contributing factor behind a risk score. SPEC.md §3.1 requires the score
 * be *multi-factor*; persisting the individual contributions is what makes that
 * demonstrable rather than asserted, and it is what the Day 4 diagnostics modal
 * renders as a breakdown.
 */
const RiskFactorSchema = new Schema(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    weight: { type: Number, required: true },
    contribution: { type: Number, required: true }
  },
  { _id: false }
);

/**
 * A granular anomaly signal. SPEC.md §3.2 requires each signal to identify both
 * its type and the specific field it was raised against.
 */
const AnomalySignalSchema = new Schema(
  {
    type: { type: String, enum: Object.values(AnomalyType), required: true },
    field: { type: String, required: true },
    severity: {
      type: String,
      enum: Object.values(AnomalySeverity),
      default: AnomalySeverity.WARNING
    },
    score: { type: Number, min: 0, max: 1, required: true },
    detail: { type: String, default: '' },
    detectedAt: { type: Date, required: true }
  },
  { _id: false }
);

const ComplianceFlagSchema = new Schema(
  {
    code: { type: String, required: true },
    standard: { type: String, default: 'IFRS' },
    severity: {
      type: String,
      enum: Object.values(AnomalySeverity),
      default: AnomalySeverity.WARNING
    },
    message: { type: String, default: '' }
  },
  { _id: false }
);

/**
 * The cheap half of the analytical layer — scalars and small arrays that the
 * dashboard reads on every list request. The expensive half (the three vector
 * spaces) lives in its own collection; see models/EntryVectors.js for why.
 */
const AnalyticsSchema = new Schema(
  {
    risk: {
      score: { type: Number, min: 0, max: 1, default: null },
      tier: { type: String, enum: [...Object.values(RiskTier), null], default: null },
      factors: { type: [RiskFactorSchema], default: [] },
      modelVersion: { type: String, default: null },
      computedAt: { type: Date, default: null }
    },
    compliance: {
      status: {
        type: String,
        enum: [...Object.values(ComplianceStatus), null],
        default: null
      },
      flags: { type: [ComplianceFlagSchema], default: [] },
      rulesetVersion: { type: String, default: null },
      evaluatedAt: { type: Date, default: null }
    },
    anomalies: { type: [AnomalySignalSchema], default: [] },
    anomalyModelVersion: { type: String, default: null },
    enrichment: {
      status: {
        type: String,
        enum: Object.values(EnrichmentStatus),
        default: EnrichmentStatus.PENDING
      },
      reason: {
        type: String,
        enum: [...Object.values(EnrichmentReason), null],
        default: EnrichmentReason.CREATE
      },
      attempts: { type: Number, default: 0 },
      claimedAt: { type: Date, default: null },
      completedAt: { type: Date, default: null },
      lastError: { type: String, default: null }
    }
  },
  { _id: false }
);

const CommentSchema = new Schema(
  {
    author: { type: String, required: true },
    text: { type: String, required: true },
    at: { type: Date, required: true }
  },
  { _id: false }
);

/**
 * Auditor workflow state. SPEC.md Scenario E: changes here carry no financial
 * substance, so they are written synchronously and never enter the queue.
 */
const AuditMetaSchema = new Schema(
  {
    workflowStatus: {
      type: String,
      enum: Object.values(WorkflowStatus),
      default: WorkflowStatus.UNREVIEWED
    },
    comments: { type: [CommentSchema], default: [] },
    lastMetadataUpdate: { type: Date, default: null }
  },
  { _id: false }
);

const EntrySchema = new Schema(
  {
    // -----------------------------------------------------------------------
    // Baseline ingested fields — SPEC.md §2.
    // These names and this structure are fixed by the specification. Do not
    // rename, nest, or add to this block.
    // -----------------------------------------------------------------------
    postingDate: { type: Date, required: true },
    transactionType: { type: String, required: true, default: 'Journal Entry' },
    entryNo: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    debit: { type: Number, required: true, default: 0, min: 0 },
    credit: { type: Number, required: true, default: 0, min: 0 },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    glNumber: { type: String, required: true, trim: true },
    postingBy: { type: String, required: true, trim: true },
    companyId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    sourceId: { type: String, required: true },
    uploadId: { type: String, required: true },
    // `created` / `updated` are managed by the timestamps option below, which is
    // configured to use the spec's field names rather than Mongoose defaults.
    systemCreated: { type: Boolean, required: true, default: false },
    uploadSourceType: { type: Number, required: true, default: 1 },

    // -----------------------------------------------------------------------
    // Appended analytical metadata — my design, sibling to the baseline block
    // so the baseline field set above stays byte-identical to the spec.
    // -----------------------------------------------------------------------
    analytics: { type: AnalyticsSchema, default: () => ({}) },
    auditMeta: { type: AuditMetaSchema, default: () => ({}) }
  },
  {
    collection: Collections.ENTRIES,
    // The spec fixes these two field names; without this Mongoose would add its
    // own createdAt/updatedAt alongside them.
    timestamps: { createdAt: 'created', updatedAt: 'updated' },
    strict: true,
    minimize: false,
    versionKey: false
  }
);

// Dashboard default listing: a company's ledger, most recent first.
EntrySchema.index({ companyId: 1, postingDate: -1 }, { name: 'company_ledger' });

// Risk filtering and sorting — the dashboard's "show me the high-risk entries"
// path, and the colour-coding query.
EntrySchema.index(
  { companyId: 1, 'analytics.risk.tier': 1, 'analytics.risk.score': -1 },
  { name: 'risk_triage' }
);

// The worker's claim scan. Partial so the index contains only in-flight jobs
// rather than an entry for every historical record — on a ledger where almost
// everything is already enriched, this keeps the hot path index tiny.
EntrySchema.index(
  { 'analytics.enrichment.status': 1, _id: 1 },
  {
    name: 'claimable_jobs',
    partialFilterExpression: {
      'analytics.enrichment.status': {
        $in: [EnrichmentStatus.PENDING, EnrichmentStatus.PROCESSING]
      }
    }
  }
);

// Scenario C: keyset pagination over records stamped at a superseded model
// version. Compound with _id so the migration pages on the sort key directly.
EntrySchema.index(
  { 'analytics.risk.modelVersion': 1, _id: 1 },
  { name: 'risk_model_version_scan' }
);

// Entry numbers identify a journal entry within a company's ledger.
EntrySchema.index({ companyId: 1, entryNo: 1 }, { name: 'company_entry_no', unique: true });

export const Entry = mongoose.model('Entry', EntrySchema);
