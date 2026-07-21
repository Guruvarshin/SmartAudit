import { setTimeout as sleep } from 'node:timers/promises';
import { EnrichmentReason, FULL_RECOMPUTE_REASONS } from '../domain/Constants.js';

/**
 * Runs `concurrency` independent lanes, each claiming one entry at a time and
 * sleeping `pollIntervalMs` when the queue is empty. Poll-and-drain rather
 * than change streams, so it is correct on standalone mongod as well as a
 * replica set. Multiple worker processes are safe to run side by side.
 */
export class EnrichmentWorker {
  constructor({
    entryRepository,
    enrichmentService,
    partialEvaluationService,
    pollIntervalMs,
    leaseMs,
    concurrency,
    maxAttempts,
    logger = console,
    name = `pid${process.pid}`
  }) {
    this.entryRepository = entryRepository;
    this.enrichmentService = enrichmentService;
    this.partialEvaluationService = partialEvaluationService;
    this.pollIntervalMs = pollIntervalMs;
    this.leaseMs = leaseMs;
    this.concurrency = concurrency;
    this.maxAttempts = maxAttempts;
    this.logger = logger;
    this.name = name;

    this.stopping = false;
    this.lanes = [];
    this.stats = { completed: 0, discarded: 0, retried: 0, failed: 0 };
  }

  start() {
    this.logger.log(
      `[worker ${this.name}] starting: ${this.concurrency} lanes, ` +
        `poll ${this.pollIntervalMs}ms, lease ${this.leaseMs}ms, max ${this.maxAttempts} attempts`
    );
    for (let lane = 0; lane < this.concurrency; lane += 1) {
      this.lanes.push(this.#runLane(lane));
    }
  }

  /** Stops claiming; resolves when every in-flight job has finished. */
  async stop() {
    this.stopping = true;
    await Promise.allSettled(this.lanes);
    const { completed, discarded, retried, failed } = this.stats;
    this.logger.log(
      `[worker ${this.name}] stopped. completed=${completed} discarded=${discarded} ` +
        `retried=${retried} failed=${failed}`
    );
  }

  async #runLane(lane) {
    while (!this.stopping) {
      let claim = null;
      try {
        claim = await this.entryRepository.claimNextJob({ leaseMs: this.leaseMs });
      } catch (error) {
        this.logger.error(`[worker ${this.name}:${lane}] claim failed: ${error.message}`);
      }

      if (!claim) {
        await sleep(this.pollIntervalMs);
        continue;
      }
      await this.#processClaim(lane, claim);
    }
  }

  async #processClaim(lane, entry) {
    const tag = `[worker ${this.name}:${lane}]`;
    const enrichment = entry.analytics.enrichment;
    const claim = { claimedAt: enrichment.claimedAt, attempts: enrichment.attempts };
    const startedAt = Date.now();

    // The reason selects the pipeline: full-recompute reasons run vectors +
    // risk, context_shift runs the partial service, which cannot reach vectors.
    const reason = enrichment.reason ?? EnrichmentReason.CREATE;
    const fullPipeline = FULL_RECOMPUTE_REASONS.includes(reason);
    const pipeline = fullPipeline ? this.enrichmentService : this.partialEvaluationService;

    this.logger.log(
      `${tag} claimed ${entry._id} (${entry.entryNo}, reason=${reason}, ` +
        `pipeline=${fullPipeline ? 'full' : 'partial'}, attempt=${claim.attempts})`
    );

    try {
      const { outcome, artifacts } = await pipeline.process(entry);
      const ms = Date.now() - startedAt;

      if (outcome === 'discarded') {
        // Our claim was superseded mid-run and the fence rejected the commit;
        // the other worker's result stands.
        this.stats.discarded += 1;
        this.logger.log(`${tag} DISCARDED ${entry._id} — claim superseded during run (${ms}ms)`);
        return;
      }

      this.stats.completed += 1;
      const anomalyCount = artifacts.anomalies.length;
      this.logger.log(
        `${tag} enriched ${entry._id} in ${ms}ms — ` +
          `risk=${artifacts.risk.score} (${artifacts.risk.tier}), ` +
          `compliance=${artifacts.compliance.status}, ` +
          `${anomalyCount} anomal${anomalyCount === 1 ? 'y' : 'ies'}`
      );
    } catch (error) {
      await this.#handleFailure(tag, entry, claim, error);
    }
  }

  async #handleFailure(tag, entry, claim, error) {
    this.logger.error(`${tag} attempt ${claim.attempts} failed on ${entry._id}: ${error.message}`);

    if (claim.attempts >= this.maxAttempts) {
      const parked = await this.entryRepository.failEnrichment(entry._id, claim, error);
      if (parked) {
        this.stats.failed += 1;
        this.logger.error(`${tag} PARKED ${entry._id} as failed after ${claim.attempts} attempts`);
      }
      return;
    }

    const released = await this.entryRepository.releaseForRetry(entry._id, claim, error);
    if (released) {
      this.stats.retried += 1;
      this.logger.log(`${tag} released ${entry._id} for retry`);
    }
    // If neither write matched, the fence rejected us and the job now belongs
    // to another worker, whose run decides its fate.
  }
}
