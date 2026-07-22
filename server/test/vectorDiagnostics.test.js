import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import { Config } from '../src/config/Config.js';
import { ModelVersion, SupersededModelVersion, VECTOR_DIMS } from '../src/domain/Constants.js';
import { EnrichmentService } from '../src/enrichment/EnrichmentService.js';
import { HttpError } from '../src/http/HttpError.js';
import { Entry } from '../src/models/Entry.js';
import { EntryVectors } from '../src/models/EntryVectors.js';
import { EntryRepository } from '../src/repositories/EntryRepository.js';
import { EntryVectorsRepository } from '../src/repositories/EntryVectorsRepository.js';
import { VectorDiagnosticsService } from '../src/services/VectorDiagnosticsService.js';

/**
 * GET /api/entries/:id/vectors - the read behind the diagnostics modal. It is
 * additive, so its contract (200 shape, 409 while unenriched, 400/404 on bad
 * input, stale flag) is pinned here.
 */

const repository = new EntryRepository();
const vectorsRepository = new EntryVectorsRepository();
const enrichmentService = new EnrichmentService({
  entryRepository: repository,
  entryVectorsRepository: vectorsRepository,
  delayMs: 0
});
const service = new VectorDiagnosticsService({
  entryRepository: repository,
  entryVectorsRepository: vectorsRepository
});

const CURRENT = Object.freeze({
  risk: ModelVersion.RISK,
  anomaly: ModelVersion.ANOMALY,
  vector: ModelVersion.VECTOR,
  complianceRuleset: ModelVersion.COMPLIANCE_RULESET
});
const SUPERSEDED = Object.freeze({
  risk: SupersededModelVersion.RISK,
  anomaly: SupersededModelVersion.ANOMALY,
  vector: SupersededModelVersion.VECTOR,
  complianceRuleset: SupersededModelVersion.COMPLIANCE_RULESET
});

let seq = 0;
function entry(overrides = {}) {
  seq += 1;
  return {
    postingDate: new Date('2026-06-03T10:00:00Z'),
    entryNo: `JE-V${seq}`,
    name: 'Diagnostics Vendor Ltd',
    description: 'Routine monthly utilities settlement',
    amount: 1200,
    debit: 1200,
    credit: 0,
    currency: 'INR',
    glNumber: '400120',
    postingBy: 'user_diag',
    companyId: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    sourceId: 'upload_diag',
    uploadId: 'file_diag',
    uploadSourceType: 1,
    ...overrides
  };
}

async function expectHttpError(promise, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HttpError, `expected HttpError, got ${error.constructor.name}`);
    assert.equal(error.status, status);
    return true;
  });
}

describe('vector diagnostics', () => {
  before(async () => {
    const { mongoUri } = Config.load();
    mongoose.set('bufferCommands', false);
    await mongoose.connect(mongoUri, {
      dbName: 'smartaudit_test_vectors',
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

  it('returns all three spaces with norms, dims and the current model version', async () => {
    const inserted = await repository.insert(entry());
    await enrichmentService.enrichDirect(inserted, { versions: CURRENT });

    const result = await service.getForEntry(String(inserted._id));

    assert.equal(result.entryId, String(inserted._id));
    assert.equal(result.dims, VECTOR_DIMS);
    assert.equal(result.modelVersion, ModelVersion.VECTOR);
    assert.equal(result.stale, false);
    assert.ok(typeof result.sourceHash === 'string' && result.sourceHash.length > 0);

    for (const space of ['semantic', 'financial', 'entity']) {
      assert.ok(Array.isArray(result.spaces[space].values), `${space} values`);
      assert.equal(result.spaces[space].values.length, VECTOR_DIMS, `${space} length`);
      assert.equal(typeof result.spaces[space].norm, 'number', `${space} norm`);
    }
  });

  it('flags vectors at a superseded model version as stale', async () => {
    const inserted = await repository.insert(entry());
    await enrichmentService.enrichDirect(inserted, { versions: SUPERSEDED });

    const result = await service.getForEntry(String(inserted._id));

    assert.equal(result.modelVersion, SupersededModelVersion.VECTOR);
    assert.equal(result.stale, true);
  });

  it('returns 409 while the entry exists but has no vectors yet', async () => {
    const inserted = await repository.insert(entry()); // born pending, never enriched
    await expectHttpError(service.getForEntry(String(inserted._id)), 409);
  });

  it('returns 404 for an unknown entry id', async () => {
    await expectHttpError(service.getForEntry(String(new mongoose.Types.ObjectId())), 404);
  });

  it('returns 400 for a malformed id', async () => {
    await expectHttpError(service.getForEntry('not-an-object-id'), 400);
  });
});
