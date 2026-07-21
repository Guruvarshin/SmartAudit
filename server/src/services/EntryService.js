import mongoose from 'mongoose';
import { UpdateScenario } from '../domain/Constants.js';
import { HttpError } from '../http/HttpError.js';

/** Baseline fields a client may supply; everything else is system-assigned. */
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

export class EntryService {
  constructor({ entryRepository, updatePlanner }) {
    this.entryRepository = entryRepository;
    this.updatePlanner = updatePlanner;
  }

  /**
   * A new entry is born `pending`, the claimable state, so persisting it is
   * also the enqueue — there is no window where an entry exists but its
   * enrichment job does not.
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
   * Fresh read → classify the diff → one CAS-guarded write. A CAS miss means
   * a concurrent content write landed in between, so we re-plan once from a
   * fresh read before giving up with 409.
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

  /** Whitelist, not blacklist: unknown keys are never copied rather than stripped. */
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
