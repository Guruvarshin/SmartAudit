import express from 'express';

/**
 * Binds /api/entries routes to controller methods, wrapping each so a
 * rejected promise reaches the error middleware instead of hanging.
 *
 * POST /, PUT /:id and POST /search/similar are the spec-fixed paths; the
 * GETs are additive conveniences for the dashboard and for verification.
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
    // Before the parameterised routes so 'search' is never captured as an :id.
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
