/**
 * Deterministic pseudo-random source (mulberry32), used instead of
 * Math.random so `npm run seed` produces identical data on every run and a
 * failing case can be reproduced rather than merely re-rolled.
 */
export class SeededRandom {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.state = seed >>> 0;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Inclusive of both bounds. */
  int(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  float(min, max) {
    return this.next() * (max - min) + min;
  }

  bool(p = 0.5) {
    return this.next() < p;
  }

  pick(items) {
    return items[this.int(0, items.length - 1)];
  }

  /** Fisher-Yates; does not mutate the input. */
  shuffle(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}
