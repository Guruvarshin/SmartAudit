import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AnomalyType, RiskTier } from '../src/domain/Constants.js';
import { RiskScorer } from '../src/enrichment/RiskScorer.js';

/**
 * Core intelligence feature 1 - Context-Aware Risk Scoring.
 *
 * Spec: a multi-factor score in [0.0, 1.0] with a low/medium/high tier;
 * "transactions where debit does not equal credit, or ... posted at highly
 * unusual timestamps ... must programmatically trigger higher risk
 * elevations." These tests pin exactly those claims.
 *
 * The scorer is pure (signals in, score out), so no database is involved.
 */

const scorer = new RiskScorer();
const signal = (type, score = 1) => ({ type, score });

describe('risk scoring', () => {
  it('an unbalanced line (debit != credit) elevates risk to at least medium', () => {
    const { score, tier } = scorer.score([signal(AnomalyType.BALANCE_MISMATCH)]);
    assert.ok(score >= 0.4, `expected elevated score, got ${score}`);
    assert.equal(tier, RiskTier.MEDIUM);
  });

  it('a highly unusual timestamp alone elevates risk to at least medium', () => {
    const { tier } = scorer.score([signal(AnomalyType.TEMPORAL_ANOMALY)]);
    assert.equal(tier, RiskTier.MEDIUM);
  });

  it('co-occurring factors outrank any single one and cross into high', () => {
    const single = scorer.score([signal(AnomalyType.BALANCE_MISMATCH)]);
    const combined = scorer.score([
      signal(AnomalyType.BALANCE_MISMATCH),
      signal(AnomalyType.TEMPORAL_ANOMALY)
    ]);
    assert.ok(combined.score > single.score, 'combined must outrank single');
    assert.equal(combined.tier, RiskTier.HIGH);
  });

  it('is multi-factor: every contributing signal is returned with weight and contribution', () => {
    const { factors } = scorer.score([
      signal(AnomalyType.BALANCE_MISMATCH),
      signal(AnomalyType.SEMANTIC_ANOMALY)
    ]);
    assert.equal(factors.length, 2);
    for (const factor of factors) {
      assert.ok(typeof factor.weight === 'number');
      assert.ok(typeof factor.contribution === 'number');
      assert.ok(factor.code && factor.label);
    }
    // Sorted by contribution, strongest first.
    assert.ok(factors[0].contribution >= factors[1].contribution);
  });

  it('stays within [0.0, 1.0] and clamps when signals pile up', () => {
    const { score } = scorer.score([
      signal(AnomalyType.BALANCE_MISMATCH),
      signal(AnomalyType.TEMPORAL_ANOMALY),
      signal(AnomalyType.NUMERIC_OUTLIER),
      signal(AnomalyType.ROUNDING_PATTERN),
      signal(AnomalyType.SEMANTIC_ANOMALY)
    ]);
    assert.ok(score <= 1, `score must clamp at 1.0, got ${score}`);
    assert.equal(score, 1);
  });

  it('a clean entry with no signals scores 0.0 / low', () => {
    const { score, tier } = scorer.score([]);
    assert.equal(score, 0);
    assert.equal(tier, RiskTier.LOW);
  });

  it('ignores unknown signal types rather than throwing', () => {
    const { score } = scorer.score([{ type: 'not_a_real_type', score: 1 }]);
    assert.equal(score, 0);
  });
});
