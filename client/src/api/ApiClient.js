/**
 * Error thrown for any non-2xx API response, carrying the HTTP status and the
 * backend's `{ error, details }` body so components can branch on status
 * (e.g. the 409 CAS-conflict reload path) without string-matching messages.
 */
export class ApiError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

/**
 * The client's single HTTP seam. All URLs are relative (/api/...) — the Vite
 * dev server proxies them to the Express API, so the browser stays
 * same-origin and the backend needs no CORS.
 */
export class ApiClient {
  /** GET /api/entries?limit&tier&status → Entry[] */
  async listEntries({ limit = 200, tier = null, status = null } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (tier) params.set('tier', tier);
    if (status) params.set('status', status);
    return this.#request(`/api/entries?${params}`);
  }

  /** GET /api/entries/:id → Entry */
  async getEntry(id) {
    return this.#request(`/api/entries/${id}`);
  }

  /** POST /api/entries → 201 Entry (born enrichment.status 'pending') */
  async createEntry(fields) {
    return this.#request('/api/entries', { method: 'POST', body: fields });
  }

  /** PUT /api/entries/:id → { routing: { scenario, action, changedFields }, entry } */
  async updateEntry(id, changes) {
    return this.#request(`/api/entries/${id}`, { method: 'PUT', body: changes });
  }

  /** POST /api/entries/search/similar → { entryId, strategy, results } */
  async searchSimilar(entryId, strategy) {
    return this.#request('/api/entries/search/similar', {
      method: 'POST',
      body: { entryId, strategy }
    });
  }

  /** GET /api/entries/:id/vectors → { modelVersion, stale, sourceHash, dims, spaces } */
  async getVectors(id) {
    return this.#request(`/api/entries/${id}/vectors`);
  }

  async #request(url, { method = 'GET', body } = {}) {
    const options = { method, headers: {} };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Non-JSON body (proxy failure page, empty response) — fall through.
    }

    if (!response.ok) {
      throw new ApiError(
        response.status,
        payload?.error ?? `request failed with status ${response.status}`,
        payload?.details ?? null
      );
    }
    return payload;
  }
}
