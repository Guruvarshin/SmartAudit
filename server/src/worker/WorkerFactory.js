import { EnrichmentService } from '../enrichment/EnrichmentService.js';
import { PartialEvaluationService } from '../enrichment/PartialEvaluationService.js';
import { EntryRepository } from '../repositories/EntryRepository.js';
import { EntryVectorsRepository } from '../repositories/EntryVectorsRepository.js';
import { EnrichmentWorker } from './EnrichmentWorker.js';

/**
 * Builds a fully wired worker. Shared by the standalone `start:worker` process
 * and by the server's in-process mode, so the two cannot drift apart.
 */
export class WorkerFactory {
  static create(config, { name, concurrency } = {}) {
    const entryRepository = new EntryRepository();
    const entryVectorsRepository = new EntryVectorsRepository();

    // Shared: partial jobs run this directly and the full pipeline composes
    // it, so there is one scoring implementation rather than two that drift.
    const partialEvaluationService = new PartialEvaluationService({
      entryRepository,
      delayMs: config.enrichmentDelayMs
    });
    const enrichmentService = new EnrichmentService({
      entryRepository,
      entryVectorsRepository,
      partialEvaluationService,
      delayMs: config.enrichmentDelayMs
    });

    return new EnrichmentWorker({
      entryRepository,
      enrichmentService,
      partialEvaluationService,
      pollIntervalMs: config.workerPollIntervalMs,
      leaseMs: config.workerLeaseMs,
      concurrency: concurrency ?? config.workerConcurrency,
      maxAttempts: config.workerMaxAttempts,
      name: name ?? `pid${process.pid}`
    });
  }
}
