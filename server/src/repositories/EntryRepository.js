import { EnrichmentStatus } from '../domain/Constants.js';
import { Entry } from '../models/Entry.js';

export class EntryRepository {
  async insert(fields) {
    const document = await Entry.create(fields);
    return document.toObject();
  }

  async findById(id) {
    return Entry.findById(id).lean();
  }

  async findByIds(ids) {
    if (ids.length === 0) return [];
    return Entry.find({ _id: { $in: ids } }).lean();
  }

  async list({ limit = 50, tier = null, status = null } = {}) {
    const filter = {};
    if (tier) filter['analytics.risk.tier'] = tier;
    if (status) filter['analytics.enrichment.status'] = status;
    return Entry.find(filter).sort({ postingDate: -1 }).limit(limit).lean();
  }

  /**
   * Field updates and the re-enqueue flip land in ONE write, so there is no
   * window where new values exist but the recompute is not queued.
   *
   * The `updated` filter is optimistic concurrency: it races only against
   * content writes, since queue bookkeeping never bumps `updated`. Returns
   * false on a miss so the caller can re-plan from a fresh read.
   *
   * Dropping status back to `pending` mid-run deliberately breaks the running
   * claim's fence, so a stale in-flight result is discarded rather than
   * committed over the new content. `attempts` resets because a re-enqueue is
   * a new job generation and deserves a fresh retry budget.
   */
  async applyUpdatePlan(entryId, expectedUpdated, plan) {
    const $set = { ...plan.baselineSet, ...plan.auditMetaSet };
    if (plan.enqueue) {
      $set['analytics.enrichment.status'] = EnrichmentStatus.PENDING;
      $set['analytics.enrichment.reason'] = plan.enqueue.reason;
      $set['analytics.enrichment.attempts'] = 0;
      $set['analytics.enrichment.claimedAt'] = null;
      $set['analytics.enrichment.completedAt'] = null;
      $set['analytics.enrichment.lastError'] = null;
    }

    const update = { $set };
    if (plan.commentPush) {
      update.$push = { 'auditMeta.comments': plan.commentPush };
    }

    const result = await Entry.updateOne(
      { _id: entryId, updated: expectedUpdated },
      update,
      { runValidators: true }
    );
    return result.matchedCount === 1;
  }

  /**
   * Atomic claim: MongoDB applies this filter-and-update to a single document
   * indivisibly, so racing workers cannot claim the same job.
   *
   * The second $or branch is crash recovery — a claim older than the lease
   * belongs to a presumed-dead worker and becomes claimable again. Safe
   * because every pipeline write is idempotent.
   */
  async claimNextJob({ leaseMs }) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - leaseMs);

    return Entry.findOneAndUpdate(
      {
        $or: [
          { 'analytics.enrichment.status': EnrichmentStatus.PENDING },
          {
            'analytics.enrichment.status': EnrichmentStatus.PROCESSING,
            'analytics.enrichment.claimedAt': { $lt: staleBefore }
          }
        ]
      },
      {
        $set: {
          'analytics.enrichment.status': EnrichmentStatus.PROCESSING,
          'analytics.enrichment.claimedAt': now
        },
        $inc: { 'analytics.enrichment.attempts': 1 }
      },
      // Claiming is queue bookkeeping, not a record edit — it must not bump `updated`.
      { sort: { _id: 1 }, returnDocument: 'after', lean: true, timestamps: false }
    );
  }

  /**
   * Restricts a terminal write to the worker that still holds the claim. A
   * worker that outlived its lease will find claimedAt/attempts moved on, so
   * its write matches nothing and is discarded instead of clobbering the
   * rightful owner's result.
   */
  #fence(entryId, claim) {
    return {
      _id: entryId,
      'analytics.enrichment.status': EnrichmentStatus.PROCESSING,
      'analytics.enrichment.claimedAt': claim.claimedAt,
      'analytics.enrichment.attempts': claim.attempts
    };
  }

  /**
   * The job's commit point. Vectors are already written; nothing is readable
   * as complete until this lands. Touches analytics.* paths only.
   */
  async completeEnrichment(entryId, claim, { risk, compliance, anomalies, anomalyModelVersion }) {
    const result = await Entry.updateOne(this.#fence(entryId, claim), {
      $set: {
        'analytics.risk': risk,
        'analytics.compliance': compliance,
        'analytics.anomalies': anomalies,
        'analytics.anomalyModelVersion': anomalyModelVersion,
        'analytics.enrichment.status': EnrichmentStatus.COMPLETE,
        'analytics.enrichment.completedAt': new Date(),
        'analytics.enrichment.lastError': null
      }
    });
    return result.matchedCount === 1;
  }

  async releaseForRetry(entryId, claim, error) {
    const result = await Entry.updateOne(
      this.#fence(entryId, claim),
      {
        $set: {
          'analytics.enrichment.status': EnrichmentStatus.PENDING,
          'analytics.enrichment.lastError': String(error?.message ?? error)
        }
      },
      { timestamps: false }
    );
    return result.matchedCount === 1;
  }

  async failEnrichment(entryId, claim, error) {
    const result = await Entry.updateOne(
      this.#fence(entryId, claim),
      {
        $set: {
          'analytics.enrichment.status': EnrichmentStatus.FAILED,
          'analytics.enrichment.lastError': String(error?.message ?? error)
        }
      },
      { timestamps: false }
    );
    return result.matchedCount === 1;
  }

  /**
   * Unfenced write for the seed's historical backfill, which runs before any
   * worker exists and so has no claim to fence against. Workers must use
   * completeEnrichment instead.
   */
  async forceEnrichmentResult(entryId, { risk, compliance, anomalies, anomalyModelVersion }) {
    await Entry.updateOne(
      { _id: entryId },
      {
        $set: {
          'analytics.risk': risk,
          'analytics.compliance': compliance,
          'analytics.anomalies': anomalies,
          'analytics.anomalyModelVersion': anomalyModelVersion,
          'analytics.enrichment.status': EnrichmentStatus.COMPLETE,
          'analytics.enrichment.completedAt': new Date(),
          'analytics.enrichment.lastError': null
        }
      },
      // Backfilled records must keep their historical dates.
      { timestamps: false }
    );
  }

  async distinctRiskModelVersions() {
    return Entry.distinct('analytics.risk.modelVersion');
  }

  async countByRiskModelVersion(version) {
    return Entry.countDocuments({
      'analytics.risk.modelVersion': version,
      'analytics.enrichment.status': EnrichmentStatus.COMPLETE
    });
  }

  /**
   * Keyset page: equality on the version plus a range on _id rides the
   * risk_model_version_scan index, so no rows are scanned and discarded and
   * memory stays bounded by the batch. Deliberately not `.skip()`.
   *
   * Only settled entries page in; an in-flight one gets current stamps from
   * whichever worker completes it.
   */
  async pageByRiskModelVersion(version, afterId, batchSize) {
    const filter = {
      'analytics.risk.modelVersion': version,
      'analytics.enrichment.status': EnrichmentStatus.COMPLETE
    };
    if (afterId) filter._id = { $gt: afterId };
    return Entry.find(filter).sort({ _id: 1 }).limit(batchSize).lean();
  }

  async pageCompleteEntries(afterId, batchSize) {
    const filter = { 'analytics.enrichment.status': EnrichmentStatus.COMPLETE };
    if (afterId) filter._id = { $gt: afterId };
    return Entry.find(filter).sort({ _id: 1 }).limit(batchSize).lean();
  }

  /**
   * Guarded on the stale version still being in place, so a worker that
   * re-stamped this entry after the migration read it keeps its fresher
   * result. `timestamps: false` because a model upgrade is analytics churn,
   * not a ledger edit; analytics.risk.computedAt is the witness that it ran.
   */
  async applyMigratedAnalytics(entryId, fromRiskVersion, { risk, compliance, anomalies, anomalyModelVersion }) {
    const result = await Entry.updateOne(
      {
        _id: entryId,
        'analytics.risk.modelVersion': fromRiskVersion,
        'analytics.enrichment.status': EnrichmentStatus.COMPLETE
      },
      {
        $set: {
          'analytics.risk': risk,
          'analytics.compliance': compliance,
          'analytics.anomalies': anomalies,
          'analytics.anomalyModelVersion': anomalyModelVersion
        }
      },
      { timestamps: false }
    );
    return result.matchedCount === 1;
  }

  /**
   * Guarded only on the entry being settled — an in-flight recompute owns the
   * entry and will apply current thresholds itself. Touches analytics.* only;
   * nothing on this path can reach the vectors collection.
   */
  async applyReEvaluatedAnalytics(entryId, { risk, compliance, anomalies, anomalyModelVersion }) {
    const result = await Entry.updateOne(
      { _id: entryId, 'analytics.enrichment.status': EnrichmentStatus.COMPLETE },
      {
        $set: {
          'analytics.risk': risk,
          'analytics.compliance': compliance,
          'analytics.anomalies': anomalies,
          'analytics.anomalyModelVersion': anomalyModelVersion
        }
      },
      { timestamps: false }
    );
    return result.matchedCount === 1;
  }

  /** The population the numeric-outlier detector measures an amount against. */
  async amountsForAccount(companyId, glNumber, { limit = 1000 } = {}) {
    const rows = await Entry.find({ companyId, glNumber }, { amount: 1, _id: 0 })
      .limit(limit)
      .lean();
    return rows.map((row) => row.amount);
  }

  async countByEnrichmentStatus() {
    const rows = await Entry.aggregate([
      { $group: { _id: '$analytics.enrichment.status', n: { $sum: 1 } } }
    ]);
    return Object.fromEntries(rows.map((row) => [row._id, row.n]));
  }
}
