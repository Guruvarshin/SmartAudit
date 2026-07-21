import mongoose from 'mongoose';
import { ModelVersion, VECTOR_SPACES } from '../domain/Constants.js';
import { HttpError } from '../http/HttpError.js';

/** Fixed by the spec: "the top 5 closest matching transactions". */
const TOP_K = 5;

/**
 * Cosine top-5 in one of the three vector spaces, as a tenant-scoped
 * streaming scan. The strategy only selects which stored array and norm
 * participate, so all three share one implementation.
 *
 * Cosine reduces to dot / (two stored norms) because the norms are computed
 * at enrichment time. Memory stays bounded by the cursor batch plus a fixed
 * 5-slot table, regardless of collection size.
 */
export class SimilaritySearchService {
  constructor({ entryRepository, entryVectorsRepository }) {
    this.entryRepository = entryRepository;
    this.entryVectorsRepository = entryVectorsRepository;
  }

  async search(body) {
    const { entryId, strategy } = this.#validate(body);

    const entry = await this.entryRepository.findById(entryId);
    if (!entry) throw HttpError.notFound(`no entry with id ${entryId}`);

    const queryVectors = await this.entryVectorsRepository.findByEntryId(entryId);
    if (!queryVectors) {
      throw HttpError.conflict(
        `entry ${entryId} has not been enriched yet (status: ` +
          `${entry.analytics?.enrichment?.status ?? 'unknown'}) - retry once the worker completes it`
      );
    }

    const queryArray = queryVectors[strategy];
    const queryNorm = queryVectors.norms[strategy];
    if (!queryNorm) {
      // A zero vector is similar to nothing - degenerate input, not an error.
      return { entryId: String(entryId), strategy, results: [] };
    }

    const top = await this.#scan(entry.companyId, entryId, strategy, queryArray, queryNorm);
    return {
      entryId: String(entryId),
      strategy,
      results: await this.#hydrate(top)
    };
  }

  async #scan(companyId, selfId, strategy, queryArray, queryNorm) {
    const top = []; // insertion into <=5 slots; a heap is ceremony at k=5
    const cursor = this.entryVectorsRepository.streamCompanySpace(companyId, strategy);

    for await (const candidate of cursor) {
      if (String(candidate._id) === String(selfId)) continue;

      const norm = candidate.norms?.[strategy];
      if (!norm) continue;

      const similarity = this.#dot(queryArray, candidate[strategy]) / (queryNorm * norm);
      if (top.length === TOP_K && similarity <= top[TOP_K - 1].similarity) continue;

      top.push({
        entryId: candidate._id,
        similarity,
        modelVersion: candidate.modelVersion
      });
      top.sort((a, b) => b.similarity - a.similarity);
      if (top.length > TOP_K) top.pop();
    }
    return top;
  }

  async #hydrate(top) {
    const entries = await this.entryRepository.findByIds(top.map((hit) => hit.entryId));
    const byId = new Map(entries.map((entry) => [String(entry._id), entry]));

    return top.map((hit) => ({
      entryId: String(hit.entryId),
      similarity: Math.round(hit.similarity * 10000) / 10000,
      // Surfaced so a pre-migration candidate is visibly stale rather than
      // silently comparable.
      stale: hit.modelVersion !== ModelVersion.VECTOR,
      entry: byId.get(String(hit.entryId)) ?? null
    }));
  }

  #validate(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw HttpError.badRequest('request body must be a JSON object');
    }
    const { entryId, strategy } = body;

    if (!mongoose.Types.ObjectId.isValid(entryId)) {
      throw HttpError.badRequest(`"${entryId}" is not a valid entry id`);
    }
    const normalisedStrategy = String(strategy ?? '').toLowerCase();
    if (!VECTOR_SPACES.includes(normalisedStrategy)) {
      throw HttpError.badRequest(`strategy must be one of: ${VECTOR_SPACES.join(', ')}`, {
        allowed: VECTOR_SPACES
      });
    }
    return {
      entryId: new mongoose.Types.ObjectId(entryId),
      strategy: normalisedStrategy
    };
  }

  #dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
    return sum;
  }
}
