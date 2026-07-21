import mongoose from 'mongoose';
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
  constructor({ entryRepository }) {
    this.entryRepository = entryRepository;
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
