import mongoose from 'mongoose';
import { SeededRandom } from '../util/SeededRandom.js';
import {
  APPROVAL_THRESHOLD,
  COHORT_MIX,
  COMPANIES,
  CURRENCIES,
  Cohort,
  GL_ACCOUNTS,
  HISTORY_DAYS,
  POSTING_USERS,
  REFERENCE_DATE,
  SUSPICIOUS_DESCRIPTIONS,
  USER_IDS,
  VENDORS
} from './LedgerReferenceData.js';

const MS_PER_DAY = 86400000;

/**
 * Generates a ledger with deliberately planted audit signal, so detection has
 * something real to find — uniformly clean data would let a risk scorer that
 * returns a constant look correct.
 *
 * Cohort tags are tracked alongside the documents, never written onto them:
 * detection is the worker's job, and the tags exist only to report what was
 * planted so the two can be compared.
 */
export class EntryFactory {
  constructor({ seed, count }) {
    this.rng = new SeededRandom(seed);
    this.count = count;
    this.entryCounters = new Map();
    this.objectIdCounter = 0;
    this.seedHex = (seed >>> 0).toString(16).padStart(8, '0').slice(-8);
  }

  /** Returns documents in insertion order plus a parallel array of cohort tags. */
  build() {
    const documents = [];
    const tags = [];
    const plan = this.#buildCohortPlan();

    // Near-duplicates only mean anything as a group, so they are budgeted as a
    // document count and emitted as whole clusters. Pulled out of the plan
    // first because expanding in place would let a cluster consume the slots
    // of whatever cohorts followed it.
    const nearDuplicateBudget = plan.filter((c) => c === Cohort.NEAR_DUPLICATE).length;
    const singles = plan.filter((c) => c !== Cohort.NEAR_DUPLICATE);

    for (const cohort of singles) {
      const { document, appliedTags } = this.#createEntry(cohort);
      documents.push(document);
      tags.push(appliedTags);
    }

    let remaining = nearDuplicateBudget;
    while (remaining > 0) {
      // A cluster of one is not a duplicate of anything; absorb the remainder
      // rather than emitting a singleton.
      const clusterSize = remaining <= 4 ? remaining : this.rng.int(3, 4);
      for (const doc of this.#createNearDuplicateCluster(clusterSize)) {
        documents.push(doc);
        tags.push([Cohort.NEAR_DUPLICATE]);
      }
      remaining -= clusterSize;
    }

    return { documents, tags };
  }


  #buildCohortPlan() {
    const plan = [];
    for (const { cohort, share } of COHORT_MIX) {
      const n = Math.round(this.count * share);
      for (let i = 0; i < n; i += 1) plan.push(cohort);
    }
    // Rounding can leave the plan a little over or under the requested count.
    while (plan.length < this.count) plan.push(Cohort.CLEAN);
    while (plan.length > this.count) plan.pop();
    return this.rng.shuffle(plan);
  }


  #createEntry(cohort) {
    const appliedTags = [cohort];
    const account = this.rng.pick(GL_ACCOUNTS);
    const company = this.#pickCompany();

    let description = this.rng.pick(account.descriptions);
    let amount = this.#typicalAmount(account);
    let postingDate = this.#businessHoursDate();

    switch (cohort) {
      case Cohort.OFF_HOURS:
        postingDate = this.#offHoursDate();
        break;

      case Cohort.NUMERIC_OUTLIER: {
        const midpoint = (account.min + account.max) / 2;
        amount = this.#round(midpoint * this.rng.int(50, 200));
        break;
      }

      case Cohort.ROUNDING:
        amount = this.rng.bool(0.5)
          ? this.rng.pick([250000, 500000, 1000000, 2000000])
          : // Clustering just under an internal approval limit — the classic
            // structuring pattern.
            APPROVAL_THRESHOLD - this.rng.pick([100, 500, 1000, 2000]);
        break;

      case Cohort.SEMANTIC:
        description = this.rng.pick(SUSPICIOUS_DESCRIPTIONS);
        break;

      default:
        break;
    }

    // A meaningful share of unbalanced entries are also posted off-hours, so
    // risk scoring has to genuinely combine factors rather than branch on one.
    if (cohort === Cohort.UNBALANCED && this.rng.bool(0.3)) {
      postingDate = this.#offHoursDate();
      appliedTags.push(Cohort.OFF_HOURS);
    }

    const sides =
      cohort === Cohort.UNBALANCED
        ? this.#unbalancedSides(amount)
        : this.#balancedSides(amount, account);

    return {
      document: this.#assemble({ account, company, description, amount, postingDate, sides }),
      appliedTags
    };
  }

  #createNearDuplicateCluster(size) {
    const account = this.rng.pick(GL_ACCOUNTS);
    const company = this.#pickCompany();
    const vendor = this.rng.pick(VENDORS);
    const amount = this.#typicalAmount(account);
    const postingDate = this.#businessHoursDate();
    const baseDescription = this.rng.pick(account.descriptions);
    const sides = this.#balancedSides(amount, account);

    // Same vendor, same amount, same day — the kind of duplicated posting an
    // auditor would want surfaced. Descriptions vary only cosmetically.
    const variants = [
      baseDescription,
      `${baseDescription} `,
      baseDescription.toUpperCase(),
      `${baseDescription} - resubmitted`
    ];

    const documents = [];
    for (let i = 0; i < size; i += 1) {
      documents.push(
        this.#assemble({
          account,
          company,
          vendor,
          description: variants[i % variants.length],
          amount,
          postingDate: new Date(postingDate.getTime() + i * 7 * 60000),
          sides
        })
      );
    }
    return documents;
  }

  #assemble({ account, company, vendor, description, amount, postingDate, sides }) {
    const systemCreated = this.rng.bool(0.12);
    const created = new Date(postingDate.getTime() + this.rng.int(5, 180) * 60000);
    const uploadNo = this.rng.int(1, 30);

    return {
      _id: this.#nextObjectId(),
      postingDate,
      transactionType: 'Journal Entry',
      entryNo: this.#nextEntryNo(company._id),
      name: vendor ?? this.rng.pick(VENDORS),
      description,
      amount,
      debit: sides.debit,
      credit: sides.credit,
      currency: this.rng.pick(CURRENCIES),
      glNumber: account.glNumber,
      postingBy: systemCreated ? 'system_batch' : this.rng.pick(POSTING_USERS.slice(0, 5)),
      companyId: new mongoose.Types.ObjectId(company._id),
      userId: new mongoose.Types.ObjectId(this.rng.pick(USER_IDS)),
      sourceId: `upload_${uploadNo}`,
      uploadId: `file_${uploadNo}`,
      created,
      updated: created,
      systemCreated,
      uploadSourceType: this.#uploadSourceType()
      // `analytics` and `auditMeta` are omitted so schema defaults leave
      // enrichment at `pending` — the state the worker needs to find.
    };
  }

  // Each row is a single-sided ledger line, balanced when debit + credit
  // equals amount with exactly one side non-zero. That reading keeps the
  // spec's own example entry clean.

  #balancedSides(amount, account) {
    // Revenue (6xxxxx) and liability (2xxxxx) accounts are credited; asset and
    // expense accounts are debited.
    const firstDigit = account.glNumber.charAt(0);
    const isCreditSide = firstDigit === '6' || firstDigit === '2';
    return isCreditSide ? { debit: 0, credit: amount } : { debit: amount, credit: 0 };
  }

  #unbalancedSides(amount) {
    const variant = this.rng.int(1, 3);
    if (variant === 1) {
      // Both sides populated and unequal.
      return { debit: amount, credit: this.#round(amount * this.rng.float(0.1, 0.4)) };
    }
    if (variant === 2) {
      // Sides fall short of the stated amount.
      return { debit: this.#round(amount * this.rng.float(0.6, 0.9)), credit: 0 };
    }
    // Sides overshoot the stated amount.
    return { debit: this.#round(amount * this.rng.float(1.05, 1.35)), credit: 0 };
  }

  // ---------------------------------------------------------------------------
  // Dates
  // ---------------------------------------------------------------------------

  /** A weekday posting during business hours — the unremarkable case. */
  #businessHoursDate() {
    let date;
    do {
      date = this.#dateAtOffset(this.rng.int(0, HISTORY_DAYS - 1));
    } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);

    date.setUTCHours(this.rng.int(9, 17), this.rng.int(0, 59), 0, 0);
    return date;
  }

  /**
   * A posting at a time no one legitimately books ledger entries. SPEC.md §3.1
   * names "2:00 AM on a Sunday" specifically, so weekend small-hours postings
   * are the dominant shape here.
   */
  #offHoursDate() {
    let date;

    if (this.rng.bool(0.6)) {
      // Weekend, small hours.
      do {
        date = this.#dateAtOffset(this.rng.int(0, HISTORY_DAYS - 1));
      } while (date.getUTCDay() !== 0 && date.getUTCDay() !== 6);
      date.setUTCHours(this.rng.int(1, 4), this.rng.int(0, 59), 0, 0);
      return date;
    }

    // Weekday, small hours.
    do {
      date = this.#dateAtOffset(this.rng.int(0, HISTORY_DAYS - 1));
    } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
    date.setUTCHours(this.rng.int(2, 4), this.rng.int(0, 59), 0, 0);
    return date;
  }

  #dateAtOffset(daysAgo) {
    return new Date(REFERENCE_DATE.getTime() - daysAgo * MS_PER_DAY);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  #typicalAmount(account) {
    return this.#round(this.rng.float(account.min, account.max));
  }

  #round(value) {
    return Math.round(value / 10) * 10;
  }

  #pickCompany() {
    return this.rng.bool(COMPANIES[0].weight) ? COMPANIES[0] : COMPANIES[1];
  }

  /**
   * Derives the document id from the seed and a counter rather than letting
   * Mongo generate one.
   *
   * Without this, re-seeding produces byte-identical *content* under new ids,
   * so anything that references an entry by id — a README curl example for
   * POST /api/entries/search/similar, which takes an entry id as its input, or
   * a saved request collection — silently breaks the moment the reviewer
   * re-runs the seed. Deriving the id from the seed makes `npm run seed`
   * reproducible in identity as well as in content.
   */
  #nextObjectId() {
    this.objectIdCounter += 1;
    const suffix = this.objectIdCounter.toString(16).padStart(8, '0').slice(-8);
    return new mongoose.Types.ObjectId(`${this.seedHex}00000000${suffix}`);
  }

  /** Entry numbers are unique within a company, so they are counted per tenant. */
  #nextEntryNo(companyId) {
    const next = (this.entryCounters.get(companyId) ?? 102992) + 1;
    this.entryCounters.set(companyId, next);
    return `JE-${next}`;
  }

  #uploadSourceType() {
    const roll = this.rng.next();
    if (roll < 0.7) return 1;
    if (roll < 0.9) return 2;
    return 3;
  }
}
