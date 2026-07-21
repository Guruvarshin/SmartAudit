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

/** Persisting individual contributions is what makes the score inspectable. */
const RiskFactorSchema = new Schema(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    weight: { type: Number, required: true },
    contribution: { type: Number, required: true }
  },
  { _id: false }
);

/** Each signal identifies both its type and the field it was raised against. */
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
 * The cheap half of the analytical layer, read on every list request. The
 * vector spaces live in their own collection — see EntryVectors.js.
 *
 * `enrichment` doubles as the job record: there is no separate queue.
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
 * Auditor workflow state. Changes here carry no financial substance, so they
 * are written synchronously and never enter the queue.
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
    // Baseline ingested fields. These names and this structure are fixed by
    // the specification — do not rename, nest, or add to this block.
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
    // `created` / `updated` come from the timestamps option below.
    systemCreated: { type: Boolean, required: true, default: false },
    uploadSourceType: { type: Number, required: true, default: 1 },

    // Appended analytical metadata, sibling to the baseline block so that
    // block stays identical to the spec.
    analytics: { type: AnalyticsSchema, default: () => ({}) },
    auditMeta: { type: AuditMetaSchema, default: () => ({}) }
  },
  {
    collection: Collections.ENTRIES,
    // The spec fixes these names; otherwise Mongoose adds createdAt/updatedAt.
    timestamps: { createdAt: 'created', updatedAt: 'updated' },
    strict: true,
    minimize: false,
    versionKey: false
  }
);

EntrySchema.index({ companyId: 1, postingDate: -1 }, { name: 'company_ledger' });

EntrySchema.index(
  { companyId: 1, 'analytics.risk.tier': 1, 'analytics.risk.score': -1 },
  { name: 'risk_triage' }
);

// The worker's claim scan. Partial so the index holds only in-flight jobs
// rather than every historical record, keeping this hot path tiny.
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

// Compound with _id so the model migration pages on the sort key directly.
EntrySchema.index(
  { 'analytics.risk.modelVersion': 1, _id: 1 },
  { name: 'risk_model_version_scan' }
);

EntrySchema.index({ companyId: 1, entryNo: 1 }, { name: 'company_entry_no', unique: true });

export const Entry = mongoose.model('Entry', EntrySchema);
