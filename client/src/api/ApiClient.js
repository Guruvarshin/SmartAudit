/**
 * Carries the HTTP status so components can branch on it - notably the 409
 * conflict reload path - without string-matching error messages.
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
 * URLs are relative because the Vite dev server proxies /api to the Express
 * API, keeping the browser same-origin so the backend needs no CORS.
 */
export class ApiClient {
  async listEntries({ limit = 200, tier = null, status = null } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (tier) params.set('tier', tier);
    if (status) params.set('status', status);
    return this.#request(`/api/entries?${params}`);
  }

  async getEntry(id) {
    return this.#request(`/api/entries/${id}`);
  }

  async createEntry(fields) {
    return this.#request('/api/entries', { method: 'POST', body: fields });
  }

  /** Responds { routing, entry }. */
  async updateEntry(id, changes) {
    return this.#request(`/api/entries/${id}`, { method: 'PUT', body: changes });
  }

  async searchSimilar(entryId, strategy) {
    return this.#request('/api/entries/search/similar', {
      method: 'POST',
      body: { entryId, strategy }
    });
  }

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
      // Non-JSON body (proxy failure page, empty response).
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
