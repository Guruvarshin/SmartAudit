import express from 'express';

/**
 * Route table for /api/entries. Owns an express.Router and binds each path to
 * a controller method, wrapping every handler so a rejected promise reaches
 * the error middleware instead of hanging the request.
 *
 * Spec-fixed paths (names are contractual):
 *   POST /api/entries                 — Scenario A ingestion        (Day 2)
 *   PUT  /api/entries/:id             — delta-routed update         (Day 3)
 *   POST /api/entries/search/similar  — vector similarity           (Day 3)
 *
 * GET list/detail/vectors are additive conveniences for the dashboard and for
 * verification; the spec does not mandate them (noted in DECISIONS.md).
 */
export class EntryRouter {
  constructor({ entryController }) {
    this.controller = entryController;
    this.router = express.Router();
    this.#mount();
  }

  #mount() {
    this.router.post('/', this.#handle(this.controller.create));
    this.router.get('/', this.#handle(this.controller.list));
    // Mounted before the parameterised routes so 'search' can never be
    // captured as an :id.
    this.router.post('/search/similar', this.#handle(this.controller.searchSimilar));
    this.router.get('/:id/vectors', this.#handle(this.controller.getVectors));
    this.router.get('/:id', this.#handle(this.controller.getById));
    this.router.put('/:id', this.#handle(this.controller.update));
  }

  #handle(method) {
    const bound = method.bind(this.controller);
    return (req, res, next) => Promise.resolve(bound(req, res)).catch(next);
  }
}
