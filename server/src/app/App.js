import express from 'express';
import { EntryController } from '../controllers/EntryController.js';
import { HttpError } from '../http/HttpError.js';
import { EntryRepository } from '../repositories/EntryRepository.js';
import { EntryVectorsRepository } from '../repositories/EntryVectorsRepository.js';
import { EntryRouter } from '../routers/EntryRouter.js';
import { EntryService } from '../services/EntryService.js';
import { SimilaritySearchService } from '../services/SimilaritySearchService.js';
import { UpdatePlanner } from '../services/UpdatePlanner.js';

/**
 * Composition root for the HTTP application. Wires repository → service →
 * controller → router, mounts middleware, and owns the express instance.
 * server.js (the bin) handles process concerns; this class handles the app.
 */
export class App {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.express = express();

    const entryRepository = new EntryRepository();
    const entryVectorsRepository = new EntryVectorsRepository();
    const updatePlanner = new UpdatePlanner();
    const entryService = new EntryService({ entryRepository, updatePlanner });
    const similaritySearchService = new SimilaritySearchService({
      entryRepository,
      entryVectorsRepository
    });
    const entryController = new EntryController({ entryService, similaritySearchService });
    this.entryRouter = new EntryRouter({ entryController });

    this.#mount();
  }

  #mount() {
    this.express.disable('x-powered-by');
    this.express.use(express.json({ limit: '256kb' }));
    this.express.use(this.#requestLog());

    this.express.get('/health', (req, res) => res.json({ ok: true }));
    this.express.use('/api/entries', this.entryRouter.router);

    this.express.use(this.#notFound());
    this.express.use(this.#errorHandler());
  }

  listen(port) {
    return new Promise((resolve) => {
      const server = this.express.listen(port, () => {
        this.logger.log(`[server] listening on http://localhost:${port}`);
        resolve(server);
      });
    });
  }

  #requestLog() {
    return (req, res, next) => {
      const startedAt = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        this.logger.log(
          `[server] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms.toFixed(1)}ms)`
        );
      });
      next();
    };
  }

  #notFound() {
    return (req, res) => {
      res.status(404).json({ error: `no route for ${req.method} ${req.originalUrl}` });
    };
  }

  #errorHandler() {
    // eslint-disable-next-line no-unused-vars -- express identifies error middleware by arity
    return (error, req, res, next) => {
      if (error instanceof HttpError) {
        const body = { error: error.message };
        if (error.details) body.details = error.details;
        res.status(error.status).json(body);
        return;
      }
      if (error?.type === 'entity.parse.failed') {
        res.status(400).json({ error: 'request body is not valid JSON' });
        return;
      }
      this.logger.error('[server] unhandled error:', error);
      res.status(500).json({ error: 'internal server error' });
    };
  }
}
