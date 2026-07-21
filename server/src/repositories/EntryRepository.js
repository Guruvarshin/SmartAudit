import { EnrichmentStatus } from '../domain/Constants.js';
import { Entry } from '../models/Entry.js';

/**
 * All reads and mutations against the `entries` collection.
 *
 * Every mutation uses direct, targeted update operators ($set / $inc) on
 * explicit paths — never a whole-document save() — per the spec's constraint
 * on avoiding root document rewrites. This class is also where the queue
 * lives: the entry document *is* the job record (see DECISIONS.md Day 2), so
 * claim / complete / release / fail are repository methods like any other
 * mutation.
 */
export class EntryRepository {
  /**
   * Creating an entry and enqueueing its enrichment are the same single write:
   * the schema defaults land it at enrichment.status 'pending', which is the
   * claimable state. No separate enqueue step means no "created but never
   * queued" window to defend.
   */
  async insert(fields) {
    const document = await Entry.create(fields);
    return document.toObject();
  }

  async findById(id) {
    return Entry.findById(id).lean();
  }

  async list({ limit = 50, tier = null, status = null } = {}) {
    const filter = {};
    if (tier) filter['analytics.risk.tier'] = tier;
    if (status) filter['analytics.enrichment.status'] = status;
    return Entry.find(filter).sort({ postingDate: -1 }).limit(limit).lean();
  }

  /**
   * Executes an UpdatePlanner plan as ONE targeted updateOne — baseline
   * $sets, auditMeta $set/$push, and (for Scenarios B/D) the re-enqueue flip,
   * all in the same atomic write. There is no window where the new field
   * values exist but the recompute isn't queued.
   *
   * Concurrency, layered:
   *  - the filter on `updated` is optimistic concurrency (CAS): it races only
   *    against genuine content writes, because queue bookkeeping deliberately
   *    never bumps `updated` (Day 2). A miss returns false and the service
   *    re-plans from a fresh read.
   *  - the re-enqueue $set drops status back to `pending` even if a worker is
   *    mid-run on the OLD values. That deliberately breaks the running claim's
   *    fence (status no longer `processing`), so the stale result is discarded
   *    and the job is re-claimed with the new content — Day 2's fence working
   *    in a new direction, not a new mechanism.
   *  - `attempts` resets to 0: a re-enqueue is a fresh job generation with a
   *    fresh retry budget (otherwise historical failures permanently erode
   *    WORKER_MAX_ATTEMPTS). A zombie's fence still fails on status +
   *    claimedAt; colliding would need a reclaim in the same millisecond.
   *
   * @returns {Promise<boolean>} false when the CAS filter missed
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

  // ---------------------------------------------------------------------------
  // Job queue — atomic claim, lease, fenced completion.
  // ---------------------------------------------------------------------------

  /**
   * Atomically claims the next enrichable entry, or returns null when none is
   * claimable.
   *
   * This single findOneAndUpdate IS the race-condition mitigation for
   * concurrent claims: MongoDB executes the filter-and-update atomically on a
   * single document, so of N workers (or in-process lanes) racing, one gets
   * the document and the rest match a different document or nothing. No lock,
   * no coordinator, no double-claim.
   *
   * The second $or branch is crash recovery: a claim older than `leaseMs`
   * whose status never advanced belongs to a worker presumed dead, and the job
   * becomes claimable again (lease / visibility-timeout pattern). Every
   * pipeline write is idempotent, so re-running over a dead worker's partial
   * writes is safe.
   *
   * The claim stamps (claimedAt, attempts) travel with the job as its fence
   * token — see #fence below.
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
      // timestamps: false — claiming is queue bookkeeping, not a record edit;
      // it must not masquerade as one by bumping the spec's `updated` field.
      { sort: { _id: 1 }, returnDocument: 'after', lean: true, timestamps: false }
    );
  }

  /**
   * Fence filter: the terminal write of a job only lands if the claim is still
   * *ours*. If this worker outlived its lease and the job was reclaimed,
   * claimedAt/attempts have moved on, the filter matches nothing, and the
   * zombie's write is discarded. `attempts` increments on every claim, so it
   * is a monotonic fencing token; claimedAt alone could only collide across a
   * full lease interval, which the attempts check closes anyway.
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
   * Writes the computed analytics and flips the entry to complete, in one
   * targeted, fenced $set. This is the job's commit point (DECISIONS.md Day 1:
   * ordering, not transactions): vectors were already upserted, and nothing is
   * readable as complete until this write lands.
   *
   * Touches analytics.* paths only — auditMeta and every baseline field are
   * structurally outside this update, and vectors live in another collection
   * entirely.
   *
   * @returns {boolean} false when the fence rejected the write (claim lost)
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

  /**
   * Returns a failed job to the queue for another attempt (fenced, so a
   * zombie cannot release a job it no longer owns).
   */
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

  /** Poison-job cutoff: parks the entry as failed instead of retrying forever. */
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
   * Unfenced enrichment write for paths that run outside the queue entirely —
   * today that is only the seed's --enrich-historical backfill, which runs
   * before any worker exists and therefore has no claim to fence against.
   * Not for worker use: workers must go through completeEnrichment's fence.
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
      // Historical backfill must not stamp today's date onto records that are
      // meant to read as months-old ledger history.
      { timestamps: false }
    );
  }

  // ---------------------------------------------------------------------------
  // Reads in service of enrichment
  // ---------------------------------------------------------------------------

  /**
   * Amounts posted to the same GL account within the same company — the
   * population the numeric-outlier detector measures against.
   */
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
