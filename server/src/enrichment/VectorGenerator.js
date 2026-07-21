import { createHash } from 'node:crypto';
import { CORE_FINANCIAL_FIELDS, VECTOR_DIMS } from '../domain/Constants.js';

/**
 * Simulated multi-space embedding engine.
 *
 * Deterministic feature hashing rather than an RNG, because similar entries
 * must produce nearby vectors - random vectors would make similarity search a
 * lottery regardless of how well-formed the endpoint was.
 *
 * Each space encodes a different notion of similarity: semantic from
 * description text, financial from magnitude and timing, entity from vendor,
 * GL account and poster.
 */
export class VectorGenerator {
  generate(entry) {
    const semantic = this.#embed(this.#semanticFeatures(entry));
    const financial = this.#embed(this.#financialFeatures(entry));
    const entity = this.#embed(this.#entityFeatures(entry));

    return {
      semantic,
      financial,
      entity,
      dims: VECTOR_DIMS,
      norms: {
        semantic: this.#norm(semantic),
        financial: this.#norm(financial),
        entity: this.#norm(entity)
      },
      sourceHash: this.#sourceHash(entry)
    };
  }

  /**
   * Hash of exactly the core financial fields, stored beside the vectors so
   * that "these vectors describe that content" stays checkable after an edit.
   */
  #sourceHash(entry) {
    const material = CORE_FINANCIAL_FIELDS.map((field) => {
      const value = entry[field];
      return value instanceof Date ? value.toISOString() : String(value);
    }).join('|');
    return createHash('sha256').update(material).digest('hex');
  }

  // Each feature is a (key, value) pair; keys are hashed into dimensions.

  #semanticFeatures(entry) {
    const text = String(entry.description ?? '').toLowerCase().trim();
    const features = [];

    const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
    for (const token of tokens) features.push([`w:${token}`, 1]);

    // Trigrams make cosmetic variants overlap even when whole words differ.
    const squashed = tokens.join(' ');
    for (let i = 0; i <= squashed.length - 3; i += 1) {
      features.push([`t:${squashed.slice(i, i + 3)}`, 0.5]);
    }
    return features;
  }

  #financialFeatures(entry) {
    const posting = new Date(entry.postingDate);
    const logAmount = Math.log10(Math.max(1, entry.amount));
    const sum = entry.debit + entry.credit;

    return [
      ['f:logAmount', logAmount],
      ['f:magnitudeBand', 1 + Math.floor(logAmount)],
      ['f:roundness', this.#trailingZeros(entry.amount)],
      [`f:side:${entry.debit > 0 ? 'debit' : 'credit'}`, 1],
      ['f:imbalance', entry.amount > 0 ? Math.min(1, Math.abs(sum - entry.amount) / entry.amount) : 0],
      [`f:hour:${posting.getUTCHours()}`, 1],
      [`f:dow:${posting.getUTCDay()}`, 1],
      [`f:currency:${entry.currency}`, 1]
    ];
  }

  #entityFeatures(entry) {
    const vendor = String(entry.name ?? '').toLowerCase().trim();
    const features = [
      [`e:vendor:${vendor}`, 2],
      [`e:gl:${entry.glNumber}`, 1.5],
      [`e:user:${entry.postingBy}`, 1],
      [`e:company:${String(entry.companyId)}`, 1],
      [`e:system:${entry.systemCreated ? 1 : 0}`, 0.5]
    ];
    for (const token of vendor.split(/[^a-z0-9]+/).filter(Boolean)) {
      features.push([`e:vt:${token}`, 0.75]);
    }
    return features;
  }

  // ---------------------------------------------------------------------------
  // Feature hashing
  // ---------------------------------------------------------------------------

  /** Accumulates (key, value) features into a dense VECTOR_DIMS array. */
  #embed(features) {
    const vector = new Array(VECTOR_DIMS).fill(0);
    for (const [key, value] of features) {
      const hash = this.#fnv1a(key);
      const index = hash % VECTOR_DIMS;
      // A hash bit supplies the sign so colliding features cancel rather than
      // pile up - the standard hashing-trick construction.
      const sign = (hash >>> 8) & 1 ? 1 : -1;
      vector[index] += sign * value;
    }
    return vector.map((component) => Math.round(component * 10000) / 10000);
  }

  #fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  }

  #norm(vector) {
    const sumOfSquares = vector.reduce((sum, component) => sum + component * component, 0);
    return Math.round(Math.sqrt(sumOfSquares) * 10000) / 10000;
  }

  #trailingZeros(amount) {
    const integer = Math.abs(Math.round(amount));
    if (integer === 0) return 0;
    let zeros = 0;
    let value = integer;
    while (value % 10 === 0) {
      zeros += 1;
      value /= 10;
    }
    return zeros;
  }
}
