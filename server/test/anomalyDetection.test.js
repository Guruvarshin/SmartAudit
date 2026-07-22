import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AnomalyType } from '../src/domain/Constants.js';
import { AnomalyDetector } from '../src/enrichment/AnomalyDetector.js';

/**
 * Core intelligence feature 2 - Granular Anomaly Detection.
 *
 * Spec: evaluate specific fields independently and append signal objects that
 * identify the type AND the field, e.g. "a numeric_outlier on the amount
 * field, or a semantic_anomaly on the description field." These tests pin each
 * signal type to the field the spec names.
 *
 * The detector is pure (entry + pre-fetched baseline in, signals out), so no
 * database is involved.
 */

const detector = new AnomalyDetector();

function entry(overrides = {}) {
  return {
    postingDate: new Date('2026-07-15T10:00:00Z'), // a weekday, business hours
    entryNo: 'JE-A1',
    name: 'Vendor Ltd',
    description: 'Purchase of raw materials for production',
    amount: 45000,
    debit: 45000,
    credit: 0,
    currency: 'INR',
    glNumber: '400120',
    ...overrides
  };
}

const find = (signals, type) => signals.find((s) => s.type === type);

describe('anomaly detection', () => {
  it("the spec's own reference entry (single-sided) raises no balance_mismatch", () => {
    // amount 125000, debit 125000, credit 0 - the canonical NORMAL entry.
    const signals = detector.detect(entry({ amount: 125000, debit: 125000, credit: 0 }));
    assert.equal(find(signals, AnomalyType.BALANCE_MISMATCH), undefined);
  });

  it('a line with both debit and credit populated raises balance_mismatch on the debit field', () => {
    const signals = detector.detect(entry({ amount: 45000, debit: 45000, credit: 1500 }));
    const s = find(signals, AnomalyType.BALANCE_MISMATCH);
    assert.ok(s, 'expected a balance_mismatch signal');
    assert.equal(s.field, 'debit');
  });

  it('an off-hours weekend posting raises temporal_anomaly on the postingDate field', () => {
    const weekend = new Date('2026-07-19T02:00:00Z'); // Sunday, 02:00 UTC
    assert.ok([0, 6].includes(weekend.getUTCDay()), 'fixture date must be a weekend');
    const s = find(detector.detect(entry({ postingDate: weekend })), AnomalyType.TEMPORAL_ANOMALY);
    assert.ok(s, 'expected a temporal_anomaly signal');
    assert.equal(s.field, 'postingDate');
  });

  it('an extreme amount raises numeric_outlier on the amount field', () => {
    // Baseline: this GL account normally posts around 10^3; this entry is 10^6.
    const baseline = { count: 20, medianLog: 3, sigmaLog: 0.1 };
    const s = find(
      detector.detect(entry({ amount: 5_000_000 }), baseline),
      AnomalyType.NUMERIC_OUTLIER
    );
    assert.ok(s, 'expected a numeric_outlier signal');
    assert.equal(s.field, 'amount');
  });

  it('an evasive narrative raises semantic_anomaly on the description field', () => {
    const s = find(
      detector.detect(entry({ description: 'misc adjustment' })),
      AnomalyType.SEMANTIC_ANOMALY
    );
    assert.ok(s, 'expected a semantic_anomaly signal');
    assert.equal(s.field, 'description');
  });

  it('every signal carries a type, a field, a bounded score and a detail string', () => {
    const signals = detector.detect(entry({ amount: 45000, debit: 45000, credit: 1500 }));
    assert.ok(signals.length > 0);
    for (const s of signals) {
      assert.ok(s.type && s.field, 'type and field are required');
      assert.ok(s.score >= 0 && s.score <= 1, 'score in [0,1]');
      assert.equal(typeof s.detail, 'string');
    }
  });

  it('a clean, balanced, weekday entry raises no signals', () => {
    assert.deepEqual(detector.detect(entry()), []);
  });
});
