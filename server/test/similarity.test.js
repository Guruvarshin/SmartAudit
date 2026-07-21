import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import { Config } from '../src/config/Config.js';
import { ModelVersion } from '../src/domain/Constants.js';
import { EnrichmentService } from '../src/enrichment/EnrichmentService.js';
import { HttpError } from '../src/http/HttpError.js';
import { Entry } from '../src/models/Entry.js';
import { EntryVectors } from '../src/models/EntryVectors.js';
import { EntryRepository } from '../src/repositories/EntryRepository.js';
import { EntryVectorsRepository } from '../src/repositories/EntryVectorsRepository.js';
import { SimilaritySearchService } from '../src/services/SimilaritySearchService.js';

/**
 * Tests for POST /api/entries/search/similar. The fixture plants a
 * near-duplicate cluster (same vendor, amount, day; cosmetically varied
 * descriptions) among unrelated background entries — the deterministic
 * feature-hashed vectors must place the cluster together in cosine space, so
 * the search's job is to find the planted neighbours, not noise.
 */

const CURRENT_VERSIONS = Object.freeze({
  risk: ModelVersion.RISK,
  anomaly: ModelVersion.ANOMALY,
  vector: ModelVersion.VECTOR,
  complianceRuleset: ModelVersion.COMPLIANCE_RULESET
});

const COMPANY_ID = new mongoose.Types.ObjectId('6650a1f4c3d2e19999999903');
const OTHER_COMPANY_ID = new mongoose.Types.ObjectId('6650a1f4c3d2e19999999904');

const repository = new EntryRepository();
const vectorsRepository = new EntryVectorsRepository();
const enrichmentService = new EnrichmentService({
  entryRepository: repository,
  entryVectorsRepository: vectorsRepository,
  delayMs: 0
});
const service = new SimilaritySearchService({
  entryRepository: repository,
  entryVectorsRepository: vectorsRepository
});

let entrySequence = 0;

function entry(overrides = {}) {
  entrySequence += 1;
  return {
    postingDate: new Date('2026-06-03T10:00:00Z'),
    entryNo: `JE-S${entrySequence}`,
    name: 'Background Vendor Ltd',
    description: 'Routine monthly utilities settlement',
    amount: 1200,
    debit: 1200,
    credit: 0,
    currency: 'INR',
    glNumber: '400120',
    postingBy: 'user_sim',
    companyId: COMPANY_ID,
    userId: new mongoose.Types.ObjectId(),
    sourceId: 'upload_sim',
    uploadId: 'file_sim',
    uploadSourceType: 1,
    ...overrides
  };
}

/** The planted near-duplicate cluster: same vendor, amount, day. */
const CLUSTER = [
  { name: 'Meridian Freight Pvt Ltd', description: 'Freight charges Mumbai to Pune consignment 4471', amount: 84500 },
  { name: 'Meridian Freight Pvt Ltd', description: 'Freight charges Mumbai to Pune consignment 4471 ', amount: 84500 },
  { name: 'Meridian Freight Pvt Ltd', description: 'FREIGHT CHARGES Mumbai to Pune consignment no 4471', amount: 84500 },
  { name: 'Meridian Freight Pvt Ltd', description: 'Freight charge Mumbai-Pune consignment 4471 (dup?)', amount: 84500 }
];

const BACKGROUND = [
  { name: 'Apex Stationers', description: 'Office stationery replenishment Q2', amount: 4200 },
  { name: 'Northline Catering', description: 'Staff cafeteria services June invoice', amount: 61000 },
  { name: 'Vertex Legal LLP', description: 'Retainer fee corporate advisory June', amount: 150000, glNumber: '500210' },
  { name: 'Slate & Co Auditors', description: 'Statutory audit interim billing', amount: 88000, glNumber: '500210' },
  { name: 'Ridgeway Logistics', description: 'Warehouse rental Bhiwandi facility', amount: 210000, glNumber: '600310' }
];

async function insertEnriched(fields) {
  const inserted = await repository.insert(entry(fields));
  await enrichmentService.enrichDirect(inserted, { versions: CURRENT_VERSIONS });
  return inserted;
}

async function expectHttpError(promise, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HttpError, `expected HttpError, got ${error.constructor.name}`);
    assert.equal(error.status, status);
    return true;
  });
}

describe('similarity search', () => {
  let clusterIds;

  before(async () => {
    const { mongoUri } = Config.load();
    mongoose.set('bufferCommands', false);
    await mongoose.connect(mongoUri, {
      dbName: 'smartaudit_test_similarity',
      serverSelectionTimeoutMS: 8000
    });
  });

  beforeEach(async () => {
    await Entry.deleteMany({});
    await EntryVectors.deleteMany({});
    clusterIds = [];
    for (const fields of CLUSTER) {
      clusterIds.push(String((await insertEnriched(fields))._id));
    }
    for (const fields of BACKGROUND) {
      await insertEnriched(fields);
    }
  });

  after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('semantic strategy surfaces the planted near-duplicate cluster', async () => {
    const { results, strategy } = await service.search({
      entryId: clusterIds[0],
      strategy: 'semantic'
    });

    assert.equal(strategy, 'semantic');
    assert.equal(results.length, 5);
    const topThree = results.slice(0, 3).map((hit) => hit.entryId);
    assert.deepEqual(
      [...topThree].sort(),
      [...clusterIds.slice(1)].sort(),
      'the three sibling duplicates outrank every background entry'
    );
    assert.ok(results[0].similarity > 0.9, 'cosmetic variants land extremely close');
  });

  it('entity strategy also groups the cluster (same vendor, GL, poster)', async () => {
    const { results } = await service.search({ entryId: clusterIds[0], strategy: 'entity' });
    const topThree = results.slice(0, 3).map((hit) => hit.entryId);
    assert.deepEqual([...topThree].sort(), [...clusterIds.slice(1)].sort());
  });

  it('results are capped at 5, descending, self-excluded, and hydrated', async () => {
    const { results } = await service.search({ entryId: clusterIds[0], strategy: 'financial' });

    assert.ok(results.length <= 5);
    assert.ok(!results.some((hit) => hit.entryId === clusterIds[0]), 'query entry excluded');
    for (let i = 1; i < results.length; i += 1) {
      assert.ok(results[i - 1].similarity >= results[i].similarity, 'descending order');
    }
    for (const hit of results) {
      assert.ok(hit.entry?.entryNo, 'each result carries its hydrated entry');
      assert.equal(hit.stale, false, 'freshly enriched candidates are not stale');
    }
  });

  it('search is tenant-scoped: another company\'s twin entry is never returned', async () => {
    const foreign = await insertEnriched({
      ...CLUSTER[0],
      companyId: OTHER_COMPANY_ID,
      entryNo: 'JE-FOREIGN-1'
    });

    const { results } = await service.search({ entryId: clusterIds[0], strategy: 'semantic' });
    assert.ok(
      !results.some((hit) => hit.entryId === String(foreign._id)),
      'tenant isolation holds even for a byte-identical twin'
    );
  });

  it('flags candidates left at a superseded vector version as stale', async () => {
    await EntryVectors.updateOne(
      { _id: new mongoose.Types.ObjectId(clusterIds[1]) },
      { $set: { modelVersion: 'vec-v0' } },
      { timestamps: false }
    );

    const { results } = await service.search({ entryId: clusterIds[0], strategy: 'semantic' });
    const flagged = results.find((hit) => hit.entryId === clusterIds[1]);
    assert.ok(flagged, 'still comparable');
    assert.equal(flagged.stale, true);
  });

  it('rejects an unknown strategy with 400 and an unknown entry with 404', async () => {
    await expectHttpError(service.search({ entryId: clusterIds[0], strategy: 'vibes' }), 400);
    await expectHttpError(service.search({ entryId: clusterIds[0], strategy: null }), 400);
    await expectHttpError(
      service.search({ entryId: '6650a1f4c3d2e19999999999', strategy: 'semantic' }),
      404
    );
  });

  it('returns 409 for an entry that has not been enriched yet', async () => {
    const unenriched = await repository.insert(entry({ entryNo: 'JE-PENDING-1' }));
    await expectHttpError(
      service.search({ entryId: String(unenriched._id), strategy: 'semantic' }),
      409
    );
  });
});
