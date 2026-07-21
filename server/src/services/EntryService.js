import mongoose from 'mongoose';
import { UpdateScenario } from '../domain/Constants.js';
import { HttpError } from '../http/HttpError.js';

/**
 * The spec's §2 baseline fields a client may supply on creation. `_id`,
 * `created`, `updated` are system-assigned; everything analytical is
 * system-computed and not writable through this door at all.
 */
const CREATABLE_FIELDS = Object.freeze([
  'postingDate',
  'transactionType',
  'entryNo',
  'name',
  'description',
  'amount',
  'debit',
  'credit',
  'currency',
  'glNumber',
  'postingBy',
  'companyId',
  'userId',
  'sourceId',
  'uploadId',
  'systemCreated',
  'uploadSourceType'
]);

/**
 * Application logic for journal entries. Controllers translate HTTP; this
 * class decides what a valid operation is; repositories talk to MongoDB.
 */
export class EntryService {
  constructor({ entryRepository, updatePlanner }) {
    this.entryRepository = entryRepository;
    this.updatePlanner = updatePlanner;
  }

  /**
   * Scenario A entry point. Persists the baseline record — which, because a
   * new entry is born at enrichment.status 'pending' (the claimable state),
   * is *also* the enqueue: one write, no separate queue insertion, no window
   * where an entry exists but its enrichment job does not. The API returns
   * immediately; a worker picks the job up asynchronously.
   */
  async create(payload) {
    const fields = this.#pickCreatable(payload);
    try {
      return await this.entryRepository.insert(fields);
    } catch (error) {
      if (error?.code === 11000) {
        throw HttpError.conflict(
          `entryNo ${fields.entryNo} already exists for this company`
        );
      }
      if (error instanceof mongoose.Error.ValidationError) {
        throw HttpError.badRequest('entry failed validation', this.#validationDetails(error));
      }
      throw error;
    }
  }

  /**
   * PUT /api/entries/:id — the delta-routed update (Scenarios B / D / E).
   *
   * Flow: fresh read → UpdatePlanner classifies the diff → one atomic
   * CAS-guarded write executes the whole plan. A CAS miss means a concurrent
   * content write landed between our read and write; we re-plan once from a
   * fresh read (the second attempt usually discovers the "conflict" was an
   * identical double-click and diffs to a no-op), then give up with 409.
   *
   * Returns { routing, entry } — the routing block states which scenario was
   * detected and what was done, so the demo shows the decision explicitly.
   */
  async update(id, payload) {
    const entryId = this.#objectId(id);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const entry = await this.entryRepository.findById(entryId);
      if (!entry) throw HttpError.notFound(`no entry with id ${id}`);

      const plan = this.updatePlanner.plan(entry, payload);
      if (plan.scenario === UpdateScenario.NO_OP) {
        return { routing: plan.routing, entry };
      }

      let applied;
      try {
        applied = await this.entryRepository.applyUpdatePlan(entryId, entry.updated, plan);
      } catch (error) {
        if (error instanceof mongoose.Error.ValidationError) {
          throw HttpError.badRequest('update failed validation', this.#validationDetails(error));
        }
        throw error;
      }
      if (applied) {
        return { routing: plan.routing, entry: await this.entryRepository.findById(entryId) };
      }
    }

    throw HttpError.conflict(
      'entry was modified concurrently; re-read it and retry the update'
    );
  }

  async getById(id) {
    const entry = await this.entryRepository.findById(this.#objectId(id));
    if (!entry) throw HttpError.notFound(`no entry with id ${id}`);
    return entry;
  }

  async list(query) {
    const limit = Math.min(Number.parseInt(query.limit ?? '50', 10) || 50, 200);
    return this.entryRepository.list({
      limit,
      tier: query.tier ?? null,
      status: query.status ?? null
    });
  }

  /**
   * Whitelist, not blacklist: unknown keys — including any attempt to write
   * `analytics`, `auditMeta`, or a forged `_id` — are simply never copied.
   */
  #pickCreatable(payload) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw HttpError.badRequest('request body must be a JSON object');
    }
    const fields = {};
    for (const key of CREATABLE_FIELDS) {
      if (payload[key] !== undefined) fields[key] = payload[key];
    }
    return fields;
  }

  #objectId(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw HttpError.badRequest(`"${id}" is not a valid entry id`);
    }
    return new mongoose.Types.ObjectId(id);
  }

  #validationDetails(error) {
    return Object.fromEntries(
      Object.entries(error.errors).map(([path, detail]) => [path, detail.message])
    );
  }
}
