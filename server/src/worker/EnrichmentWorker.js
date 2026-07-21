import { setTimeout as sleep } from 'node:timers/promises';

/**
 * The background enrichment worker — SPEC.md Scenario A's asynchronous
 * processing layer.
 *
 * Design (see DECISIONS.md Day 2): there is no queue infrastructure to talk
 * to. The worker runs `concurrency` independent lanes, each looping:
 * atomically claim the next claimable entry via the repository's
 * findOneAndUpdate (the race-condition mitigation — two lanes, or two whole
 * worker processes, can never claim the same document), process it, commit
 * through the fenced write. When a claim comes back empty the lane sleeps
 * `pollIntervalMs` and looks again — poll-and-drain, correct on standalone
 * mongod and Atlas alike, no change streams required.
 */
export class EnrichmentWorker {
  constructor({
    entryRepository,
    enrichmentService,
    pollIntervalMs,
    leaseMs,
    concurrency,
    maxAttempts,
    logger = console,
    name = `pid${process.pid}`
  }) {
    this.entryRepository = entryRepository;
    this.enrichmentService = enrichmentService;
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

    this.logger.log(
      `${tag} claimed ${entry._id} (${entry.entryNo}, reason=${enrichment.reason}, attempt=${claim.attempts})`
    );

    try {
      const { outcome, artifacts } = await this.enrichmentService.process(entry);
      const ms = Date.now() - startedAt;

      if (outcome === 'discarded') {
        // Our lease expired mid-run and another worker took the job; the fence
        // rejected our commit. Their result stands, ours is dropped — correct.
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
    // If neither write matched, the fence rejected us: the job is someone
    // else's now, and their run — not our bookkeeping — decides its fate.
  }
}
