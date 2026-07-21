import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import { Config } from '../src/config/Config.js';
import { EnrichmentStatus } from '../src/domain/Constants.js';
import { Entry } from '../src/models/Entry.js';
import { EntryRepository } from '../src/repositories/EntryRepository.js';

/**
 * The queue's race-condition mitigation: atomic claim, lease, fenced
 * completion. Runs against a real MongoDB in a separate test database -
 * the mechanism under test is MongoDB's single-document atomicity, so
 * mocking the database would test nothing.
 */

const LEASE_MS = 60000;
const repository = new EntryRepository();

const COMPANY_ID = new mongoose.Types.ObjectId('6650a1f4c3d2e19999999901');

let entrySequence = 0;

function pendingEntry() {
  entrySequence += 1;
  return {
    postingDate: new Date('2026-06-01T10:00:00Z'),
    entryNo: `JE-T${entrySequence}`,
    name: 'Test Vendor Ltd',
    description: 'Claim contention fixture entry',
    amount: 1000,
    debit: 1000,
    credit: 0,
    currency: 'INR',
    glNumber: '400120',
    postingBy: 'user_test',
    companyId: COMPANY_ID,
    userId: new mongoose.Types.ObjectId(),
    sourceId: 'upload_test',
    uploadId: 'file_test',
    uploadSourceType: 1
  };
}

describe('enrichment job claiming', () => {
  before(async () => {
    const { mongoUri } = Config.load();
    mongoose.set('bufferCommands', false);
    await mongoose.connect(mongoUri, { dbName: 'smartaudit_test', serverSelectionTimeoutMS: 8000 });
  });

  beforeEach(async () => {
    await Entry.deleteMany({});
  });

  after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('concurrent claims are pairwise disjoint and each job is claimed exactly once', async () => {
    const JOBS = 20;
    const CLAIMANTS = 40; // deliberately more claimants than jobs

    await Entry.insertMany(Array.from({ length: JOBS }, pendingEntry));

    const claims = await Promise.all(
      Array.from({ length: CLAIMANTS }, () => repository.claimNextJob({ leaseMs: LEASE_MS }))
    );

    const claimedIds = claims.filter(Boolean).map((claim) => String(claim._id));
    assert.equal(claimedIds.length, JOBS, 'every job claimed, surplus claimants got null');
    assert.equal(new Set(claimedIds).size, JOBS, 'no document claimed twice');

    const processed = await Entry.find({
      'analytics.enrichment.status': EnrichmentStatus.PROCESSING
    }).lean();
    assert.equal(processed.length, JOBS);
    for (const entry of processed) {
      assert.equal(entry.analytics.enrichment.attempts, 1, 'exactly one claim per job');
    }
  });

  it('a processing job inside its lease is not claimable', async () => {
    await Entry.insertMany([pendingEntry()]);
    const first = await repository.claimNextJob({ leaseMs: LEASE_MS });
    assert.ok(first);

    const second = await repository.claimNextJob({ leaseMs: LEASE_MS });
    assert.equal(second, null, 'live claim must not be stolen');
  });

  it('a processing job whose lease expired is reclaimed, incrementing attempts', async () => {
    await Entry.insertMany([pendingEntry()]);
    const first = await repository.claimNextJob({ leaseMs: LEASE_MS });

    // Simulate the claimant crashing and the lease running out.
    await Entry.updateOne(
      { _id: first._id },
      { $set: { 'analytics.enrichment.claimedAt': new Date(Date.now() - LEASE_MS - 5000) } },
      { timestamps: false }
    );

    const second = await repository.claimNextJob({ leaseMs: LEASE_MS });
    assert.ok(second, 'expired claim is claimable again');
    assert.equal(String(second._id), String(first._id));
    assert.equal(second.analytics.enrichment.attempts, 2);
  });

  it('a zombie claimant cannot complete, release, or fail a job it lost', async () => {
    await Entry.insertMany([pendingEntry()]);
    const zombie = await repository.claimNextJob({ leaseMs: LEASE_MS });
    const zombieClaim = {
      claimedAt: zombie.analytics.enrichment.claimedAt,
      attempts: zombie.analytics.enrichment.attempts
    };

    // Lease expires; a healthy worker reclaims the job.
    await Entry.updateOne(
      { _id: zombie._id },
      { $set: { 'analytics.enrichment.claimedAt': new Date(Date.now() - LEASE_MS - 5000) } },
      { timestamps: false }
    );
    const healthy = await repository.claimNextJob({ leaseMs: LEASE_MS });
    const healthyClaim = {
      claimedAt: healthy.analytics.enrichment.claimedAt,
      attempts: healthy.analytics.enrichment.attempts
    };

    const payload = {
      risk: { score: 0.1, tier: 'low', factors: [], modelVersion: 'risk-v1', computedAt: new Date() },
      compliance: { status: 'pass', flags: [], rulesetVersion: 'ifrs-ruleset-v1', evaluatedAt: new Date() },
      anomalies: [],
      anomalyModelVersion: 'anomaly-v1'
    };

    // The zombie wakes up and tries every terminal write it knows.
    assert.equal(await repository.completeEnrichment(zombie._id, zombieClaim, payload), false);
    assert.equal(await repository.releaseForRetry(zombie._id, zombieClaim, new Error('x')), false);
    assert.equal(await repository.failEnrichment(zombie._id, zombieClaim, new Error('x')), false);

    // Nothing moved: the job still belongs to the healthy claim.
    const untouched = await Entry.findById(zombie._id).lean();
    assert.equal(untouched.analytics.enrichment.status, EnrichmentStatus.PROCESSING);
    assert.equal(untouched.analytics.enrichment.attempts, 2);

    // The rightful owner's commit lands.
    assert.equal(await repository.completeEnrichment(healthy._id, healthyClaim, payload), true);
    const completed = await Entry.findById(healthy._id).lean();
    assert.equal(completed.analytics.enrichment.status, EnrichmentStatus.COMPLETE);
  });
});
