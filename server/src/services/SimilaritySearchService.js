import mongoose from 'mongoose';
import { ModelVersion, VECTOR_SPACES } from '../domain/Constants.js';
import { HttpError } from '../http/HttpError.js';

/** SPEC.md §3.3 fixes the result size: "the top 5 closest matching transactions". */
const TOP_K = 5;

/**
 * POST /api/entries/search/similar — cosine top-5 in one of the three vector
 * spaces. One implementation serves all three strategies: the strategy only
 * selects which stored array (and precomputed norm) participates.
 *
 * Computation is an application-side streaming scan over the tenant's
 * `entry_vectors`, projected down to ONE space per candidate (a third of the
 * document), with cosine reduced to dot ÷ (two stored norms) — the reason the
 * norms were precomputed at enrichment time. Memory is bounded by the cursor
 * batch plus a fixed 5-slot result table; nothing accumulates with collection
 * size. At this scale that beats the alternatives on their own terms:
 * aggregation-pipeline dot products ($zip/$reduce) cannot keep a running
 * top-k and are unreadable, and $vectorSearch requires Atlas while Day 1
 * committed to local-Docker parity. `entry_vectors` remains the documented
 * seam where a real vector store would replace this scan wholesale.
 */
export class SimilaritySearchService {
  constructor({ entryRepository, entryVectorsRepository }) {
    this.entryRepository = entryRepository;
    this.entryVectorsRepository = entryVectorsRepository;
  }

  /**
   * @param {{ entryId?: string, strategy?: string }} body
   * @returns {Promise<{ entryId: string, strategy: string, results: object[] }>}
   */
  async search(body) {
    const { entryId, strategy } = this.#validate(body);

    const entry = await this.entryRepository.findById(entryId);
    if (!entry) throw HttpError.notFound(`no entry with id ${entryId}`);

    const queryVectors = await this.entryVectorsRepository.findByEntryId(entryId);
    if (!queryVectors) {
      throw HttpError.conflict(
        `entry ${entryId} has not been enriched yet (status: ` +
          `${entry.analytics?.enrichment?.status ?? 'unknown'}) — retry once the worker completes it`
      );
    }

    const queryArray = queryVectors[strategy];
    const queryNorm = queryVectors.norms[strategy];
    if (!queryNorm) {
      // A zero vector (e.g. an empty description's semantic space) is similar
      // to nothing; degenerate input, not an error.
      return { entryId: String(entryId), strategy, results: [] };
    }

    const top = await this.#scan(entry.companyId, entryId, strategy, queryArray, queryNorm);
    return {
      entryId: String(entryId),
      strategy,
      results: await this.#hydrate(top)
    };
  }

  /** Streams the tenant's vectors, keeping a fixed-size top-K table. */
  async #scan(companyId, selfId, strategy, queryArray, queryNorm) {
    const top = []; // ascending insertion into ≤5 slots; a heap is ceremony at k=5
    const cursor = this.entryVectorsRepository.streamCompanySpace(companyId, strategy);

    for await (const candidate of cursor) {
      if (String(candidate._id) === String(selfId)) continue;

      const norm = candidate.norms?.[strategy];
      if (!norm) continue; // zero vector: similar to nothing, skip

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

  /** One $in fetch for the winners, re-ordered by similarity. */
  async #hydrate(top) {
    const entries = await this.entryRepository.findByIds(top.map((hit) => hit.entryId));
    const byId = new Map(entries.map((entry) => [String(entry._id), entry]));

    return top.map((hit) => ({
      entryId: String(hit.entryId),
      similarity: Math.round(hit.similarity * 10000) / 10000,
      // Surfaced so a pre-migration (Scenario C) candidate is visibly stale
      // rather than silently comparable.
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
