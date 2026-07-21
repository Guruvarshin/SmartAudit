import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import { Config } from '../src/config/Config.js';
import {
  EnrichmentReason,
  EnrichmentStatus,
  ModelVersion,
  UpdateScenario,
  WorkflowStatus
} from '../src/domain/Constants.js';
import { EnrichmentService } from '../src/enrichment/EnrichmentService.js';
import { PartialEvaluationService } from '../src/enrichment/PartialEvaluationService.js';
import { HttpError } from '../src/http/HttpError.js';
import { Entry } from '../src/models/Entry.js';
import { EntryVectors } from '../src/models/EntryVectors.js';
import { EntryRepository } from '../src/repositories/EntryRepository.js';
import { EntryVectorsRepository } from '../src/repositories/EntryVectorsRepository.js';
import { EntryService } from '../src/services/EntryService.js';
import { UpdatePlanner } from '../src/services/UpdatePlanner.js';

/**
 * Tests for the PUT delta router — Scenario B (core field → full recompute),
 * D (balance side → partial re-eval, vectors untouched), E (metadata-only →
 * no queue). Real MongoDB, in its own database, for the same reason as
 * claim.test.js: the mechanisms under test (atomic combined write, CAS,
 * fence interaction) ARE MongoDB behaviours.
 */

const LEASE_MS = 60000;
const CURRENT_VERSIONS = Object.freeze({
  risk: ModelVersion.RISK,
  anomaly: ModelVersion.ANOMALY,
  vector: ModelVersion.VECTOR,
  complianceRuleset: ModelVersion.COMPLIANCE_RULESET
});

const COMPANY_ID = new mongoose.Types.ObjectId('6650a1f4c3d2e19999999902');

const repository = new EntryRepository();
const vectorsRepository = new EntryVectorsRepository();
const planner = new UpdatePlanner();
const service = new EntryService({ entryRepository: repository, updatePlanner: planner });
const partialService = new PartialEvaluationService({ entryRepository: repository, delayMs: 0 });
const enrichmentService = new EnrichmentService({
  entryRepository: repository,
  entryVectorsRepository: vectorsRepository,
  partialEvaluationService: partialService,
  delayMs: 0
});

let entrySequence = 0;

function baseEntry() {
  entrySequence += 1;
  return {
    postingDate: new Date('2026-06-03T10:00:00Z'), // Wednesday, business hours
    entryNo: `JE-D${entrySequence}`,
    name: 'Delta Fixtures Pvt Ltd',
    description: 'Quarterly office supplies procurement for Pune site',
    amount: 1000,
    debit: 1000,
    credit: 0,
    currency: 'INR',
    glNumber: '400120',
    postingBy: 'user_delta',
    companyId: COMPANY_ID,
    userId: new mongoose.Types.ObjectId(),
    sourceId: 'upload_delta',
    uploadId: 'file_delta',
    uploadSourceType: 1
  };
}

/** Inserts and fully enriches one entry at current model versions. */
async function enrichedEntry() {
  const inserted = await repository.insert(baseEntry());
  await enrichmentService.enrichDirect(inserted, { versions: CURRENT_VERSIONS });
  return repository.findById(inserted._id);
}

async function expectHttpError(promise, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HttpError, `expected HttpError, got ${error.constructor.name}`);
    assert.equal(error.status, status);
    return true;
  });
}

describe('PUT delta routing', () => {
  before(async () => {
    const { mongoUri } = Config.load();
    mongoose.set('bufferCommands', false);
    await mongoose.connect(mongoUri, {
      dbName: 'smartaudit_test_delta',
      serverSelectionTimeoutMS: 8000
    });
  });

  beforeEach(async () => {
    await Entry.deleteMany({});
    await EntryVectors.deleteMany({});
  });

  after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  describe('classification (UpdatePlanner)', () => {
    it('routes a core financial field change to Scenario B', async () => {
      const entry = await enrichedEntry();
      const plan = planner.plan(entry, { amount: 2000 });
      assert.equal(plan.scenario, UpdateScenario.CORE_FIELD_CHANGE);
      assert.deepEqual(plan.enqueue, { reason: EnrichmentReason.CORE_FIELD_CHANGE });
    });

    it('routes a balance-side change to Scenario D', async () => {
      const entry = await enrichedEntry();
      const plan = planner.plan(entry, { debit: 400 });
      assert.equal(plan.scenario, UpdateScenario.RISK_CONTEXT_CHANGE);
      assert.deepEqual(plan.enqueue, { reason: EnrichmentReason.CONTEXT_SHIFT });
    });

    it('routes a metadata-only edit to Scenario E with no enqueue', async () => {
      const entry = await enrichedEntry();
      const plan = planner.plan(entry, {
        auditMeta: { workflowStatus: WorkflowStatus.IN_REVIEW }
      });
      assert.equal(plan.scenario, UpdateScenario.METADATA_ONLY);
      assert.equal(plan.enqueue, null);
    });

    it('a mixed update takes the strongest scenario (B) while keeping the metadata writes', async () => {
      const entry = await enrichedEntry();
      const plan = planner.plan(entry, {
        description: 'Restated supplier invoice',
        auditMeta: { comment: { author: 'auditor1', text: 'restated per email' } }
      });
      assert.equal(plan.scenario, UpdateScenario.CORE_FIELD_CHANGE);
      assert.ok(plan.commentPush, 'comment append still part of the same plan');
    });

    it('is diff-based: re-sending stored values is a no-op', async () => {
      const entry = await enrichedEntry();
      const plan = planner.plan(entry, {
        amount: entry.amount,
        debit: entry.debit,
        postingDate: entry.postingDate.toISOString()
      });
      assert.equal(plan.scenario, UpdateScenario.NO_OP);
      assert.equal(plan.enqueue, null);
    });

    it('rejects fields outside the closed taxonomy with 400', async () => {
      const entry = await enrichedEntry();
      assert.throws(() => planner.plan(entry, { name: 'Другой Vendor' }), (error) => {
        assert.equal(error.status, 400);
        return true;
      });
      assert.throws(() => planner.plan(entry, { analytics: { risk: { score: 0 } } }), (error) => {
        assert.equal(error.status, 400);
        return true;
      });
    });

    it('a D-route enqueue never downgrades a pending full recompute', async () => {
      const entry = await enrichedEntry();
      await service.update(String(entry._id), { amount: 5000 }); // → pending, core_field_change
      const pending = await repository.findById(entry._id);
      const plan = planner.plan(pending, { credit: 123 });
      assert.equal(plan.scenario, UpdateScenario.RISK_CONTEXT_CHANGE);
      assert.deepEqual(plan.enqueue, { reason: EnrichmentReason.CORE_FIELD_CHANGE });
    });
  });

  describe('Scenario B — core field change', () => {
    it('applies the edit and re-enqueues a full recompute in one write', async () => {
      const entry = await enrichedEntry();
      const { routing, entry: updated } = await service.update(String(entry._id), {
        amount: 2500,
        description: 'Revised procurement amount'
      });

      assert.equal(routing.scenario, 'B');
      assert.equal(updated.amount, 2500);
      assert.equal(updated.analytics.enrichment.status, EnrichmentStatus.PENDING);
      assert.equal(updated.analytics.enrichment.reason, EnrichmentReason.CORE_FIELD_CHANGE);
      assert.equal(updated.analytics.enrichment.attempts, 0, 'fresh retry budget');
      assert.ok(updated.updated > entry.updated, 'content change bumps updated');
    });

    it('supersedes an in-flight claim: the old run is fenced out', async () => {
      const entry = await enrichedEntry();
      // Re-enqueue and let a worker claim the OLD content.
      await service.update(String(entry._id), { amount: 7000 });
      const claimed = await repository.claimNextJob({ leaseMs: LEASE_MS });
      assert.equal(String(claimed._id), String(entry._id));
      const staleClaim = {
        claimedAt: claimed.analytics.enrichment.claimedAt,
        attempts: claimed.analytics.enrichment.attempts
      };

      // Auditor edits again while the worker is mid-run.
      await service.update(String(entry._id), { amount: 9000 });

      // The stale run's commit is rejected by the fence...
      const artifacts = await enrichmentService.compute(claimed, { simulateModelDelay: false });
      const committed = await repository.completeEnrichment(
        claimed._id,
        staleClaim,
        partialService.analyticsPayload(artifacts, {
          risk: ModelVersion.RISK,
          anomaly: ModelVersion.ANOMALY,
          complianceRuleset: ModelVersion.COMPLIANCE_RULESET
        })
      );
      assert.equal(committed, false, 'stale result discarded');

      // ...and the job is claimable again, carrying the newest content.
      const reclaimed = await repository.claimNextJob({ leaseMs: LEASE_MS });
      assert.equal(String(reclaimed._id), String(entry._id));
      assert.equal(reclaimed.amount, 9000);
    });
  });

  describe('Scenario D — balance change, vectors untouched', () => {
    it('queues a partial re-evaluation and the vector document never moves', async () => {
      const entry = await enrichedEntry();
      const vectorsBefore = await EntryVectors.findById(entry._id).lean();
      assert.ok(vectorsBefore, 'fixture is enriched');

      // Unbalance the line: debit 400 vs amount 1000.
      const { routing } = await service.update(String(entry._id), { debit: 400 });
      assert.equal(routing.scenario, 'D');

      const queued = await repository.findById(entry._id);
      assert.equal(queued.analytics.enrichment.status, EnrichmentStatus.PENDING);
      assert.equal(queued.analytics.enrichment.reason, EnrichmentReason.CONTEXT_SHIFT);

      // A worker claims it; the partial pipeline runs and commits.
      const claimed = await repository.claimNextJob({ leaseMs: LEASE_MS });
      const { outcome, artifacts } = await partialService.process(claimed);
      assert.equal(outcome, 'complete');
      assert.ok(
        artifacts.anomalies.some((signal) => signal.type === 'balance_mismatch'),
        'new balance state is re-detected'
      );

      const after = await repository.findById(entry._id);
      assert.equal(after.analytics.enrichment.status, EnrichmentStatus.COMPLETE);
      assert.ok(
        after.analytics.risk.score > entry.analytics.risk.score,
        'risk re-scored upward for the unbalanced line'
      );

      // The witness: the vector document is byte-identical, timestamp included.
      const vectorsAfter = await EntryVectors.findById(entry._id).lean();
      assert.deepEqual(vectorsAfter, vectorsBefore, 'vectors entirely untouched');
    });
  });

  describe('Scenario E — metadata only', () => {
    it('saves synchronously and never touches queue state or vectors', async () => {
      const entry = await enrichedEntry();
      const vectorsBefore = await EntryVectors.findById(entry._id).lean();

      const { routing, entry: updated } = await service.update(String(entry._id), {
        auditMeta: {
          workflowStatus: WorkflowStatus.ESCALATED,
          comment: { author: 'auditor1', text: 'escalating for partner review' }
        }
      });

      assert.equal(routing.scenario, 'E');
      assert.equal(updated.auditMeta.workflowStatus, WorkflowStatus.ESCALATED);
      assert.equal(updated.auditMeta.comments.length, 1);
      assert.ok(updated.auditMeta.lastMetadataUpdate);

      // Queue state untouched: still complete, same reason, no attempts churn.
      assert.equal(updated.analytics.enrichment.status, EnrichmentStatus.COMPLETE);
      assert.deepEqual(
        updated.analytics.risk,
        entry.analytics.risk,
        'analytics not recomputed'
      );
      assert.deepEqual(await EntryVectors.findById(entry._id).lean(), vectorsBefore);
    });

    it('rejects an invalid workflow status with 400', async () => {
      const entry = await enrichedEntry();
      await expectHttpError(
        service.update(String(entry._id), { auditMeta: { workflowStatus: 'approved!!' } }),
        400
      );
    });
  });

  describe('concurrency and idempotence', () => {
    it('a double-clicked save is a no-op the second time', async () => {
      const entry = await enrichedEntry();
      const first = await service.update(String(entry._id), { amount: 3333 });
      const second = await service.update(String(entry._id), { amount: 3333 });

      assert.equal(first.routing.scenario, 'B');
      assert.equal(second.routing.scenario, UpdateScenario.NO_OP);
      // Nothing changed on the second call, including `updated`.
      assert.deepEqual(second.entry.updated, first.entry.updated);
    });

    it('the CAS filter misses when `updated` has moved on', async () => {
      const entry = await enrichedEntry();
      const plan = planner.plan(entry, { amount: 4444 });
      const applied = await repository.applyUpdatePlan(
        entry._id,
        new Date(entry.updated.getTime() - 1000), // stale expectation
        plan
      );
      assert.equal(applied, false);
      const untouched = await repository.findById(entry._id);
      assert.equal(untouched.amount, entry.amount);
    });

    it('the service surfaces 409 when every CAS attempt loses', async () => {
      const entry = await enrichedEntry();
      const losingRepository = new (class extends EntryRepository {
        async applyUpdatePlan() {
          return false; // simulate a competing writer winning every race
        }
      })();
      const racingService = new EntryService({
        entryRepository: losingRepository,
        updatePlanner: planner
      });
      await expectHttpError(racingService.update(String(entry._id), { amount: 5555 }), 409);
    });
  });
});
