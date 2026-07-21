import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import { Config } from '../src/config/Config.js';
import { ModelVersion, SupersededModelVersion } from '../src/domain/Constants.js';
import { EnrichmentService } from '../src/enrichment/EnrichmentService.js';
import { PartialEvaluationService } from '../src/enrichment/PartialEvaluationService.js';
import { Entry } from '../src/models/Entry.js';
import { EntryVectors } from '../src/models/EntryVectors.js';
import { EntryRepository } from '../src/repositories/EntryRepository.js';
import { EntryVectorsRepository } from '../src/repositories/EntryVectorsRepository.js';
import { ModelMigrationService } from '../src/scripts/ModelMigrationService.js';
import { RiskReEvaluationService } from '../src/scripts/RiskReEvaluationService.js';

/**
 * Tests for the Scenario C migration (keyset pagination, guarded writes,
 * idempotent re-runs) and the Scenario D bulk re-evaluation (analytics
 * re-scored, vectors provably frozen).
 */

const CURRENT_VERSIONS = Object.freeze({
  risk: ModelVersion.RISK,
  anomaly: ModelVersion.ANOMALY,
  vector: ModelVersion.VECTOR,
  complianceRuleset: ModelVersion.COMPLIANCE_RULESET
});

const STALE_VERSIONS = Object.freeze({
  risk: SupersededModelVersion.RISK,
  anomaly: SupersededModelVersion.ANOMALY,
  vector: SupersededModelVersion.VECTOR,
  complianceRuleset: SupersededModelVersion.COMPLIANCE_RULESET
});

const COMPANY_ID = new mongoose.Types.ObjectId('6650a1f4c3d2e19999999905');

const repository = new EntryRepository();
const vectorsRepository = new EntryVectorsRepository();
const enrichmentService = new EnrichmentService({
  entryRepository: repository,
  entryVectorsRepository: vectorsRepository,
  delayMs: 0
});
const quietLogger = { log() {}, error() {} };

let entrySequence = 0;

function entry(overrides = {}) {
  entrySequence += 1;
  return {
    postingDate: new Date('2026-02-10T11:00:00Z'),
    entryNo: `JE-M${entrySequence}`,
    name: 'Migration Fixtures Ltd',
    description: 'Historical raw material purchase for plant maintenance',
    amount: 5000 + entrySequence,
    debit: 5000 + entrySequence,
    credit: 0,
    currency: 'INR',
    glNumber: '400120',
    postingBy: 'user_mig',
    companyId: COMPANY_ID,
    userId: new mongoose.Types.ObjectId(),
    sourceId: 'upload_mig',
    uploadId: 'file_mig',
    uploadSourceType: 1,
    ...overrides
  };
}

async function insertEnrichedAt(versions, overrides = {}) {
  const inserted = await repository.insert(entry(overrides));
  await enrichmentService.enrichDirect(inserted, { versions });
  return repository.findById(inserted._id);
}

function migrationService(batchSize = 2) {
  return new ModelMigrationService({
    entryRepository: repository,
    enrichmentService,
    batchSize,
    logger: quietLogger
  });
}

describe('Scenario C migration and Scenario D bulk re-evaluation', () => {
  before(async () => {
    const { mongoUri } = Config.load();
    mongoose.set('bufferCommands', false);
    await mongoose.connect(mongoUri, {
      dbName: 'smartaudit_test_migration',
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

  it('migrates every stale entry across multiple keyset pages, exactly once', async () => {
    const stale = [];
    for (let i = 0; i < 7; i += 1) stale.push(await insertEnrichedAt(STALE_VERSIONS));
    const fresh = await insertEnrichedAt(CURRENT_VERSIONS);

    // batchSize 2 forces 4 pages (2+2+2+1) through the keyset loop.
    const report = await migrationService(2).run();

    assert.equal(report.migrated, 7, 'each stale entry migrated exactly once');
    assert.equal(report.skipped, 0);
    assert.deepEqual(Object.keys(report.versions), [SupersededModelVersion.RISK]);

    for (const doc of stale) {
      const migrated = await repository.findById(doc._id);
      assert.equal(migrated.analytics.risk.modelVersion, ModelVersion.RISK);
      assert.equal(migrated.analytics.anomalyModelVersion, ModelVersion.ANOMALY);
      assert.equal(
        migrated.analytics.compliance.rulesetVersion,
        ModelVersion.COMPLIANCE_RULESET
      );
      const vectors = await EntryVectors.findById(doc._id).lean();
      assert.equal(vectors.modelVersion, ModelVersion.VECTOR);

      // A model upgrade is analytics churn, not a ledger edit: the spec's
      // `updated` field must not move (the witness is risk.computedAt).
      assert.deepEqual(migrated.updated, doc.updated, 'ledger `updated` untouched');
      assert.ok(migrated.analytics.risk.computedAt > doc.analytics.risk.computedAt);
    }

    // Already-current entries were never part of the scan.
    const untouched = await repository.findById(fresh._id);
    assert.deepEqual(untouched.analytics.risk.computedAt, fresh.analytics.risk.computedAt);
  });

  it('re-running the migration is a no-op (the version stamp is the checkpoint)', async () => {
    for (let i = 0; i < 3; i += 1) await insertEnrichedAt(STALE_VERSIONS);

    const first = await migrationService().run();
    const second = await migrationService().run();

    assert.equal(first.migrated, 3);
    assert.equal(second.migrated, 0);
    assert.deepEqual(second.versions, {}, 'nothing scans as stale any more');
  });

  it('guarded writes never clobber a concurrent worker restamp', async () => {
    const doc = await insertEnrichedAt(STALE_VERSIONS);

    // Simulate a live worker completing a fresher recompute between the
    // migration's page read and its writes: both stamps move to current.
    await enrichmentService.enrichDirect(doc, { versions: CURRENT_VERSIONS });
    const workerAnalytics = (await repository.findById(doc._id)).analytics;
    const workerVectors = await EntryVectors.findById(doc._id).lean();

    // The migration still holds the stale page entry and tries to migrate it.
    const { vectorsUpdated, analyticsUpdated } = await enrichmentService.migrateStale(doc, {
      fromRiskVersion: SupersededModelVersion.RISK
    });

    assert.equal(vectorsUpdated, false, 'vector guard missed - worker result stands');
    assert.equal(analyticsUpdated, false, 'analytics guard missed - worker result stands');
    assert.deepEqual((await repository.findById(doc._id)).analytics, workerAnalytics);
    assert.deepEqual(await EntryVectors.findById(doc._id).lean(), workerVectors);
  });

  it('dry run reports stale counts without writing anything', async () => {
    const doc = await insertEnrichedAt(STALE_VERSIONS);

    const report = await new ModelMigrationService({
      entryRepository: repository,
      enrichmentService,
      batchSize: 2,
      dryRun: true,
      logger: quietLogger
    }).run();

    assert.equal(report.versions[SupersededModelVersion.RISK].found, 1);
    assert.equal(report.migrated, 0);
    const untouched = await repository.findById(doc._id);
    assert.equal(untouched.analytics.risk.modelVersion, SupersededModelVersion.RISK);
  });

  it('bulk re-evaluation re-scores analytics while the vector collection is frozen', async () => {
    const docs = [];
    for (let i = 0; i < 5; i += 1) docs.push(await insertEnrichedAt(CURRENT_VERSIONS));
    const vectorsBefore = await EntryVectors.find({}).sort({ _id: 1 }).lean();

    const report = await new RiskReEvaluationService({
      entryRepository: repository,
      partialEvaluationService: new PartialEvaluationService({ entryRepository: repository }),
      batchSize: 2,
      logger: quietLogger
    }).run();

    assert.equal(report.reEvaluated, 5);
    assert.equal(report.skipped, 0);

    for (const doc of docs) {
      const reEvaluated = await repository.findById(doc._id);
      assert.ok(
        reEvaluated.analytics.risk.computedAt > doc.analytics.risk.computedAt,
        'analytics genuinely re-derived'
      );
      assert.deepEqual(reEvaluated.updated, doc.updated, 'ledger `updated` untouched');
    }

    // The Scenario D witness: the entire vector collection is byte-identical,
    // timestamps included.
    const vectorsAfter = await EntryVectors.find({}).sort({ _id: 1 }).lean();
    assert.deepEqual(vectorsAfter, vectorsBefore, 'vectors entirely untouched');
  });
});
