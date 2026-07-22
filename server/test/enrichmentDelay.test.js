import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Config } from '../src/config/Config.js';
import { PartialEvaluationService } from '../src/enrichment/PartialEvaluationService.js';

/**
 * Scenario A - the enrichment pipeline "simulates a machine learning model
 * execution with an explicit delay (mock this with a 400ms delay)."
 *
 * Split into the two claims so neither is brittle:
 *   1. the configured value is 400ms (a config default);
 *   2. the delay is actually applied, and only when the async pipeline asks
 *      for it - asserted with a small injected delay so the test stays fast
 *      and stable rather than waiting a real 400ms.
 */

// A repository stub so compute() needs no database: the amount baseline is the
// only I/O the pipeline performs, and an empty population is a valid answer.
const stubRepository = { amountsForAccount: async () => [] };

function entry() {
  return {
    postingDate: new Date('2026-07-15T10:00:00Z'),
    description: 'Routine monthly utilities settlement',
    amount: 45000,
    debit: 45000,
    credit: 0,
    glNumber: '400120',
    companyId: 'company-x'
  };
}

async function timed(fn) {
  const start = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - start) / 1e6; // ms
}

describe('enrichment delay (Scenario A)', () => {
  it('the configured simulated-model delay defaults to 400ms', () => {
    const config = new Config({ MONGODB_URI: 'mongodb://localhost:27017/x' });
    assert.equal(config.enrichmentDelayMs, 400);
  });

  it('applies the delay when the async pipeline requests it', async () => {
    const service = new PartialEvaluationService({ entryRepository: stubRepository, delayMs: 40 });
    const elapsed = await timed(() => service.compute(entry(), { simulateModelDelay: true }));
    assert.ok(elapsed >= 35, `expected the injected delay to apply, took ${elapsed.toFixed(1)}ms`);
  });

  it('skips the delay on the non-async paths (migration / bulk re-evaluation)', async () => {
    const service = new PartialEvaluationService({ entryRepository: stubRepository, delayMs: 40 });
    const elapsed = await timed(() => service.compute(entry())); // simulateModelDelay defaults false
    assert.ok(elapsed < 30, `expected no delay off the async path, took ${elapsed.toFixed(1)}ms`);
  });
});
