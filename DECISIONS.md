# Decision Log

Maintained by Claude Code, one entry per architectural decision, appended at the end of each day/phase per `DAY_PLAN.md`. Read this file at the start of every session, right after `SPEC.md`, before writing any code.

Purpose: a fresh session (or a fresh subagent) should be able to read this file alone and know every non-obvious choice already made, without re-deriving it or contradicting it. If you're about to make a call that touches something already logged here, reconcile with the existing entry explicitly — don't silently override it.

> **Note for reviewers:** entries below cite `SPEC.md` by section (e.g. "SPEC.md §3.3", "Scenario B"). That file is the verbatim assessment brief you provided; it is deliberately not committed to this repository, so those citations point into the brief itself rather than to a file in the clone.

Entry format:

```
## [Day N] <short decision title>

**Decision:** what was chosen, stated concretely (not "used a good queue design" — say what the design actually is).

**Alternatives considered:** what else was on the table.

**Why this one:** the actual reasoning — tie it back to what the spec is testing where relevant (e.g., "Scenario D requires provably not touching vectors, which pushed toward X").

**Affects:** which files/modules implement this, so a later phase knows where to look.
```

---

## [Day 1] Analytical layer split across two collections

**Decision:** Two collections. `entries` holds the 20 baseline fields from `SPEC.md` §2 verbatim, plus two sibling sub-documents of my own design: `analytics` (risk score/tier/factors, compliance status/flags, granular anomaly signals, and enrichment pipeline state) and `auditMeta` (workflow status and auditor comments — the Scenario E surface). `entry_vectors` is a separate collection holding only the three 64-dimension vector spaces, their precomputed L2 norms, a `sourceHash` of the fields they were derived from, and a `modelVersion`. Its `_id` **is** the entry's `_id`, so the 1:1 relationship is enforced by the primary key and the join is a PK hit.

**Alternatives considered:**
- *Everything embedded on the entry document.* Scenario D is achievable via dotted `$set`, but only by discipline — a single careless `$set: { analytics: {...} }` silently destroys the vectors.
- *All analytical data in one separate collection (risk and vectors together).* Relocates the same discipline problem rather than solving it, and forces a `$lookup` or second query on the dashboard's hottest path just to read a risk tier.

**Why this one:**
- **Scenario D becomes structurally impossible to violate.** "Leaves the large vector attributes entirely untouched" stops being a property maintained carefully in every update and becomes a property of the risk-update code path holding no handle to the vectors model at all. Verification is then a fact about `entry_vectors.updated` not moving, rather than a code review.
- **The spec's own language decomposes along exactly this line.** §3 says "append AI-driven metadata … to this baseline record" (embed); the preamble says "isolate core records from **high-cost** analytical layers" (separate). The high-cost layer is specifically the vectors — risk data is a handful of scalars. Both instructions are satisfied at once instead of one being traded against the other.
- **Write amplification is real.** WiredTiger rewrites the entire document on any update, including a targeted `$set`. Scenario D is a *bulk* re-scoring pass; rewriting ~400-byte entry documents rather than ~2KB ones is the substance behind "avoid entire root document rewrites."
- **Read patterns genuinely diverge.** Vectors are consumed by exactly two things — the similarity endpoint and the diagnostics modal. The dashboard list never wants them.
- `VECTOR_DIMS = 64` was chosen so this argument stays honest: 3 × 64 doubles ≈ 1.5KB against a ~400-byte baseline record. A token 8-float array would have made the separation decorative.
- `entry_vectors` is also the seam where a real vector store (Atlas Vector Search, pgvector) would later drop in without the ledger schema changing.

**Cost accepted:** enrichment now writes two documents with no cross-collection atomicity. Handled by ordering rather than transactions — see the topology entry below.

**Affects:** `server/src/models/Entry.js`, `server/src/models/EntryVectors.js`, `server/src/domain/Constants.js`. Day 2's worker and Day 3's delta router must both respect the boundary: the risk/compliance path must never import `EntryVectors`.

---

## [Day 1] MongoDB topology: Docker single-node replica set, but no dependency on it

**Decision:** `docker-compose.yml` runs `mongo:7` as a single-node replica set (`rs0`), with the member host pinned to `localhost:27017` and an idempotent `rs.initiate()` in the healthcheck. `.env.example` documents Atlas as a drop-in alternative. **No code path requires transactions.**

**Alternatives considered:** standalone container (simplest, but no transactions and a topology that differs from any real deployment); assuming a locally installed `mongod` (there is none on PATH here, so probably none on the reviewer's machine either); Atlas-only (adds a network dependency and credentials to a graded submission).

**Why this one:** a replica set costs nothing over standalone inside a container but makes local topology match Atlas, which removes a whole class of environment-skew bugs where transactions and change streams work in one environment and silently do not in the other. The member host is pinned to `localhost` deliberately: a replica set advertises its members' hostnames, and a container advertising its internal hostname produces the classic "connects fine, then hangs on first write" failure when driven from the host. Verified: `rs.status()` reports `PRIMARY` advertising `localhost:27017`, and the seed writes from the host succeed.

Transactions are nonetheless *available, not depended upon*. Enrichment will write vectors → analytics → flip `enrichment.status` to `complete`, with the status flip as the commit point and every write idempotent. A crash mid-way leaves the entry `processing` and re-claimable, and no partial state is ever readable as complete. This keeps the system correct on standalone `mongod` and free-tier Atlas alike.

**Affects:** `docker-compose.yml`, `.env.example`, `server/src/db/MongoConnection.js`. Constrains Day 2's worker design: it must not reach for a transaction to make the two-collection write atomic.

---

## [Day 1] Interpretation: what "unbalanced" means

**Decision:** A row is **balanced** when `debit + credit === amount` **and** exactly one side is non-zero. Anything else — both sides populated, or the sides not summing to `amount` — is unbalanced and must elevate risk.

**Alternatives considered:** the literal reading of `SPEC.md` §3.1, "transactions where debit does not equal credit."

**Why this one:** the literal reading contradicts the spec's own §2 reference entry, which has `debit: 125000, credit: 0` and would therefore be flagged high-risk as the canonical example of a *normal* entry. §1 explains double-entry bookkeeping at the level of the ledger as a whole ("total Debit must exactly equal total Credit"), while each stored row is a single-sided ledger line. The reading above is the only one under which the spec's own example is clean, which is plainly the intent.

**Flagged to the user at plan approval.** If the recruiter intends the literal reading, this changes the seed cohorts and the risk scorer — revisit before Day 2's scoring is written.

**Affects:** `server/src/seed/EntryFactory.js` (`#balancedSides` / `#unbalancedSides`), and Day 2's risk scoring rules.

---

## [Day 1] Seed strategy: deterministic, cohort-based, and it does not fabricate enrichment

**Decision:** `npm run seed` generates 500 entries (`--count`, `--seed` overridable) from a fixed-seed PRNG, drops and rebuilds both collections so re-runs are idempotent, builds indexes *before* insertion so the unique `(companyId, entryNo)` constraint validates the generated data, and inserts with `{ timestamps: false }` so the factory's historical `created`/`updated` values survive instead of being stamped with the current time. Composition: 65% clean, 8% unbalanced, 8% off-hours, 6% numeric outlier, 5% rounding/near-threshold, 5% semantic, 3% near-duplicate clusters — with a deliberate overlap where some unbalanced entries are *also* posted off-hours. Every entry lands at `enrichment.status: 'pending'`.

**Alternatives considered:** uniformly clean data (leaves the worker nothing to detect and would let a constant-returning risk scorer look correct); random rather than seeded generation (unreproducible for a graded submission); and seeding pre-enriched historical records now so Scenario C has stale data immediately.

**Why this one:**
- The planted-cohort report printed at the end of the run is the number Day 2's detection output gets compared against, so the seed states what it planted rather than leaving the reviewer to take detection on faith.
- The unbalanced/off-hours overlap exists specifically so risk scoring must genuinely combine factors rather than branch on one and still appear to work.
- Near-duplicates are emitted as whole clusters (same vendor, amount, and day; cosmetically varied descriptions) so Day 3's similarity endpoint has planted neighbours to find, instead of returning whichever entries happen to sit closest in a vector space.
- **Cohort tags are deliberately not written to the documents.** The entry schema is `strict` and contains the spec's baseline fields plus the analytical layer, nothing else. Detection is the worker's job; the tags exist only in the run report so planted and detected can be compared.
- **The seed does not fabricate analytics.** Scenario C needs historical records stamped at a superseded model version, but writing fake analytics today would create a second, divergent implementation of enrichment. The `--enrich-historical` mode lands in Day 2 and calls the real enrichment service with a `v1` stamp.

**Amendment (same day, after independent verification):** document `_id`s are now derived from the seed and a counter rather than generated by Mongo. The first implementation was reproducible in *content* but not in *identity* — a re-seed produced byte-identical entries under fresh `ObjectId`s. That would have silently broken anything referencing an entry by id across a re-run, and `POST /api/entries/search/similar` takes an entry id as its input, so the README will almost certainly carry such a reference. Verified stable across consecutive re-seeds.

**Affects:** `server/src/seed/*`, `server/src/util/SeededRandom.js`, `server/src/util/CliArguments.js`. Day 2 owes this file an `--enrich-historical` seed mode built on the real enrichment service.

---

## [Day 1] Runtime: ESM modules and the built-in Node test runner

**Decision:** ES modules (`"type": "module"`) throughout, Node ≥ 20, and `node --test` for the Day 3 tests. No Jest, no Babel, no TypeScript.

**Alternatives considered:** CommonJS with Jest — the more conventional pairing.

**Why this one:** ESM is the natural fit for a codebase built on ES6 classes and native `import`, and Jest with ESM requires experimental VM flags or a Babel transform. Node's built-in runner removes that whole toolchain for what will be a small, targeted test suite. Fewer moving parts on a reviewer's machine is worth more here than Jest's richer matchers.

**Note on `CLAUDE.md` constraint #1:** logic lives in classes (`Config`, `MongoConnection`, `EntryFactory`, `SeedRunner`, `SeededRandom`, `CliArguments`, and the Day 2+ controllers/services/repositories/workers). Mongoose **schema definitions**, the frozen vocabulary in `domain/Constants.js`, and the frozen reference data in `seed/LedgerReferenceData.js` are declarative data, not the "loose, procedural functional modules" the constraint forbids, so they are not wrapped in ceremonial classes. Flagged to the user at plan approval. *(Amended Day 2: the independent verification pass noted `LedgerReferenceData.js` was not literally named here despite being the same declarative character — now it is.)*

**Affects:** `package.json`, `server/package.json`, every source file.

---

## [Day 2] Async architecture: MongoDB-native queue with no queue collection — the entry document is the job record

**Decision:** No broker and no separate jobs collection. `analytics.enrichment` on the entry (`status`/`reason`/`attempts`/`claimedAt`/`completedAt`/`lastError`) *is* the queue state, served by Day 1's `claimable_jobs` partial index. Creating an entry and enqueueing its enrichment are one atomic insert — a new entry is born `pending`, the claimable state. Workers (`npm run start:worker`, N processes safe) run `WORKER_CONCURRENCY` poll-and-drain lanes, each claiming one job at a time via `EntryRepository.claimNextJob`.

**Alternatives considered:**
- *BullMQ + Redis.* Splits job truth across two stores with no arbiter (Redis says done, Mongo write failed); adds a second infrastructure dependency to a graded local run; and outsources the race-condition mechanism the spec names as a primary discussion point to a library, at a workload (400ms mock delay, hundreds of rows) orders of magnitude below where a broker pays rent.
- *Separate `enrichment_jobs` collection in Mongo.* The serious contender. Rejected because job state is inherently 1:1 with an entry, and a second collection reintroduces exactly the cross-collection consistency problem (orphaned or missing job docs) Day 1's design avoids — with no transaction permitted to patch it.

**Why this one:** one source of truth by construction; deduplication/coalescing for free — re-enqueue is an idempotent `$set` back to `pending`, so N rapid edits or double-clicked saves collapse into one recompute (Scenario B and the spec's Day 5-6 hardening example inherit this on Day 3); and the whole submission speaks the one language Scenarios C and D are already testing: targeted Mongo operators. Dispatch is poll-and-drain (sleep `WORKER_POLL_INTERVAL_MS` when empty) because change streams require a replica set and Day 1 committed to correctness on standalone `mongod`. **Cost accepted:** no per-run job history — only latest-attempt state plus `lastError`.

**Affects:** `server/src/repositories/EntryRepository.js` (the queue), `server/src/worker/EnrichmentWorker.js` (the lanes), `server/src/services/EntryService.js` (insert-is-enqueue), `.env.example`.

---

## [Day 2] Race-condition mitigation: atomic claim + lease + fenced terminal writes

**Decision:** three mechanisms, all in the repository layer:

1. **Atomic claim** — one `findOneAndUpdate` filtering `status: pending ∨ (processing ∧ claimedAt < now − WORKER_LEASE_MS)`, setting `processing`/`claimedAt` and `$inc`-ing `attempts`. MongoDB's single-document atomicity makes double-claims impossible; racing claimants get different documents or `null`.
2. **Lease (visibility timeout)** — the stale-claim clause is crash recovery: a dead worker's job re-enters the claimable pool after `WORKER_LEASE_MS`. Safe because every pipeline write is idempotent (vectors upsert by `_id`; analytics `$set`), honoring Day 1's ordering-not-transactions commitment: vectors first, then one fenced `$set` that lands analytics *and* flips status to `complete` — the commit point.
3. **Fenced terminal writes** — complete/release/fail all filter on `{status: processing, claimedAt: mine, attempts: mine}`. A zombie that outlived its lease misses the filter and its write is discarded; `attempts` is the monotonic fencing token (`claimedAt` alone could only collide a full lease apart, which the attempts check closes anyway). Plus a poison-job cutoff: `attempts ≥ WORKER_MAX_ATTEMPTS` parks the entry as `failed` with `lastError`.

**Alternatives considered:** transactions (ruled out Day 1); a `processing` flag without a lease (a crashed worker permanently strands its jobs); claim without fencing (a zombie whose job was reclaimed could clobber the rightful owner's result — the classic lost-update).

**Verified, not asserted:** `server/test/claim.test.js` (40 concurrent claimants over 20 jobs → pairwise-disjoint, every `attempts === 1`; zombie's complete/release/fail all rejected; rightful owner commits). Live demos: two 4-lane worker processes drained 500 seeded jobs — A=252 + B=248, zero overlap, `attempts: 1=500`; a hard-killed worker's 4 orphaned claims were reclaimed at `attempt=2` after lease expiry and completed by a second worker.

**Affects:** `server/src/repositories/EntryRepository.js`, `server/src/worker/EnrichmentWorker.js`, `server/test/claim.test.js`.

---

## [Day 2] Deterministic feature-hashed vectors; detection measured against robust per-account baselines

**Decision:** `VectorGenerator` uses the feature-hashing trick (FNV-1a into 64 dims, hash-bit sign), no RNG: semantic = description tokens + character trigrams; financial = magnitude/roundness/side/imbalance/timing features; entity = vendor/GL/poster/tenant features. The numeric-outlier detector measures log-amounts against a **median + MAD** baseline per `(companyId, glNumber)` (30s in-process cache) rather than mean/stddev. Anomaly heuristics live in the detector and import nothing from the seed — the planted-vs-detected comparison is only meaningful if the detector cannot read the answer key. `APPROVAL_THRESHOLD` moved to `domain/Constants.js` (it is Scenario D's kind of mutable context), re-exported to the seed so plant and detection cannot drift.

**Alternatives considered:** random vectors (deterministic per entry only if seeded by id — and then similarity search is a lottery: near-duplicates would land nowhere near each other, making Day 3's endpoint undemonstrable); mean/stddev outlier baseline (the 50-200× planted outliers inflate the spread they're measured against and mask themselves).

**Verified:** drain of the 500-entry seed detected `balance_mismatch` 40/40, `temporal` 48/48, `semantic` 25/25 exactly; `rounding` 27 vs 25 planted (two organic round-figure hits); `numeric_outlier` 47 vs 30 planted — the excess is the rounding cohort's 250k-2M amounts posted to small-range GL accounts, which genuinely are outliers there (multi-signal entries, by design). The spec's canonical POST (unbalanced + 2AM Sunday + "misc adjustment" + 1500 under threshold) scored 1.0/high/fail with all four factors itemised.

**Affects:** `server/src/enrichment/*`, `server/src/domain/Constants.js`, `server/src/seed/LedgerReferenceData.js`.

---

## [Day 2] Smaller calls, recorded so later phases don't relitigate them

- **GET `/api/entries` and GET `/api/entries/:id` are additive conveniences** for verification and the Day 4 dashboard. The spec fixes only `POST /api/entries`, `PUT /api/entries/:id`, and `POST /api/entries/search/similar`; it does not mandate the GETs. Confirmed with the user at Day 2 plan approval.
- **Queue bookkeeping does not bump `updated`.** Claim/release/fail write with `timestamps: false` — a claim is not a record edit, and the spec's `updated` field should reflect content changes, not worker churn. Completion (which lands new analytics) does bump it.
- **`--enrich-historical` runs the real `EnrichmentService`** (Day 1's debt, paid): same engines, superseded version stamps (`risk-v0`/`vec-v0` via `SupersededModelVersion`), no simulated delay, `timestamps: false` so months-old `created`/`updated` survive. Verified: 500/500 stamped v0 with historical timestamps intact. This is the Scenario C fixture.
- **Body-shaping is whitelist-only** (`EntryService.#pickCreatable`): a client cannot write `analytics`, `auditMeta`, or `_id` through `POST /api/entries` because unknown keys are never copied, not because they are stripped.

**Affects:** `server/src/routers/EntryRouter.js`, `server/src/repositories/EntryRepository.js`, `server/src/seed/SeedRunner.js`, `server/src/services/EntryService.js`.

---

## [Day 3] PUT delta routing: one classifier, a closed field taxonomy, one atomic CAS-guarded write

**Decision:** `UpdatePlanner` is the single place scenario detection lives. It classifies a PUT diff against a **closed** taxonomy defined in `domain/Constants.js` — `CORE_FINANCIAL_FIELDS` → Scenario B (full recompute enqueued, `reason: core_field_change`), `BALANCE_FIELDS` (`debit`/`credit`, new) → Scenario D (partial re-evaluation enqueued, `reason: context_shift`), `auditMeta.workflowStatus`/`comment` → Scenario E (synchronous, queue untouched) — and emits an immutable plan that `EntryRepository.applyUpdatePlan` executes as ONE `updateOne`: field `$set`s, auditMeta ops, and the re-enqueue flip together, filtered on `{ _id, updated: <at read> }` (optimistic CAS; one internal retry, then 409). Classification is diff-based: re-sending stored values is a no-op, which is what makes a double-clicked save free. Any other field — vendor `name`, `entryNo`, `currency`, every `analytics`/`_id` path — is a 400 naming the keys. Mixed updates take the strongest scenario (B ⊃ D; E's writes ride the same atomic update). The PUT response carries a `routing` block (`scenario`, `action`, `changedFields`) so the classification is API-observable, not inferred from logs.

**Alternatives considered:** per-scenario conditionals in the service/controller (scatters the definition of "what a change means" and cannot guarantee a total classification); presence-based rather than diff-based detection (double-clicks would re-trigger recomputes); an open whitelist passing unclassified fields through (hollows out the routing claim); `debit`/`credit` as Scenario B members (leaves the PUT with no detectable D class at all, contradicting `DAY_PLAN.md`'s explicit B/D/E routing deliverable).

**Why debit/credit are the D route (user-confirmed at plan approval):** SPEC.md Scenario B enumerates its invalidation set exhaustively ("amount, description, glNumber, or postingDate"); a balance edit changes the `balance_mismatch` signal — risk and compliance must move — but per the spec's own list does not invalidate vectors. That is exactly Scenario D's premise. *Acknowledged tradeoff, accepted explicitly:* the financial vector's side/imbalance features do read `debit`/`credit`, so after a D update the stored financial vector reflects the pre-edit balance; the spec's exhaustive list, not the feature extractor, defines the invalidation contract. Consistent with Day 2's `sourceHash`, which hashes only the four core fields.

**Concurrency notes (interactions with Day 2, all deliberate):**
- A B/D re-enqueue sets `status: pending` even mid-run, which breaks the running claim's fence — the stale result is discarded and the job re-claimed with new content. Day 2's fence working in a new direction, no new mechanism. Verified in `deltaRouting.test.js`.
- The CAS on `updated` races only against content writes because Day 2 decided queue bookkeeping never bumps `updated`.
- A D enqueue never downgrades a pending full-pipeline `reason` (`FULL_RECOMPUTE_REASONS` guard), decided from the CAS-protected snapshot.
- **Amendment to Day 2's fencing (user-approved):** re-enqueue resets `attempts: 0` — a fresh job generation deserves a fresh retry budget; otherwise historical failures permanently erode `WORKER_MAX_ATTEMPTS`. Fence safety then rests on `status` + `claimedAt`; a collision would need a reclaim within the same millisecond. Deliberate micro-tradeoff against the pure monotonic-token reading.

**Affects:** `server/src/services/UpdatePlanner.js`, `server/src/services/EntryService.js`, `server/src/repositories/EntryRepository.js` (`applyUpdatePlan`), `server/src/domain/Constants.js`, `server/test/deltaRouting.test.js`.

---

## [Day 3] Scenario D's execution path is structurally vector-free: PartialEvaluationService + reason-driven worker pipelines

**Decision:** the risk half of enrichment (baseline → anomalies → risk → compliance) was extracted into `PartialEvaluationService`, which imports neither the `EntryVectors` model nor its repository. `EnrichmentService` composes it for full runs — one scoring implementation, not two that drift. The worker selects the pipeline from the claimed job's `reason`: `FULL_RECOMPUTE_REASONS` → `EnrichmentService.process` (vectors + risk); `context_shift` → `PartialEvaluationService.process`, which commits through the same fenced `completeEnrichment` (already analytics-only). Partial jobs keep the 400ms simulated delay for a uniform async model in the worker logs. This makes Day 1's "the risk path holds no handle to vectors" literal for every D execution path — per-entry PUT jobs and the bulk script alike.

**Alternatives considered:** running D synchronously in the request (contrast is showy but contradicts Day 1's recorded intent that `EnrichmentReason` "drives which pipelines the worker runs", loses queue coalescing, and blocks the response on a 400ms simulation); a partial *method* on `EnrichmentService` (keeps a vectors handle in scope of the D path — the guarantee would be behavioural again, not structural).

**Verified, not asserted (live, user-required):** PUT `credit` on entry `JE-103069` → routing `D`, worker log `reason=context_shift, pipeline=partial`, risk re-scored 0 → 0.45/medium with `balance_mismatch` — and the `entry_vectors` document byte-identical before/after (`updated: 04:42:28.619Z`, same `sourceHash`). The immediately following PUT `description` → `pipeline=full` moved both (`updated: 04:43:49.612Z`, new hash): the boundary cuts exactly where claimed. Test-level witness: `deltaRouting.test.js` deep-equals the whole vector doc across a D run.

**Affects:** `server/src/enrichment/PartialEvaluationService.js`, `server/src/enrichment/EnrichmentService.js`, `server/src/worker/EnrichmentWorker.js`, `server/src/worker/index.js`.

---

## [Day 3] Similarity search: application-side streaming cosine over precomputed norms, one implementation for all three strategies

**Decision:** `SimilaritySearchService` implements `POST /api/entries/search/similar` as a tenant-scoped streaming scan of `entry_vectors`, projected to a SINGLE space per candidate (~⅓ of each document) plus its precomputed L2 norm and `modelVersion`. Cosine reduces to dot ÷ (two stored scalars); results keep a fixed 5-slot insertion table (spec fixes top-5; a heap is ceremony at k=5), then one `$in` hydration of the winners. The strategy string (validated against `VectorSpace`) only selects which array/norm participates — there are not three code paths. Errors: 400 bad strategy/id, 404 unknown entry, 409 not-yet-enriched; a zero-norm query returns empty (degenerate input, not an error), zero-norm candidates are skipped. Each result carries `stale: modelVersion !== current`, so pre-migration candidates are visibly stale rather than silently comparable.

**Alternatives considered:** aggregation-pipeline dot products via `$zip`/`$reduce` (no incremental top-k, unreadable, no offsetting win at this scale); Atlas `$vectorSearch` (violates Day 1's local-Docker parity). `entry_vectors` remains the documented seam where a real vector store would replace the scan wholesale.

**Verified:** planted near-duplicate clusters retrieved as the top block in semantic and entity spaces (`similarity.test.js`, similarity > 0.9 for cosmetic variants); tenant isolation holds for a byte-identical foreign-company twin; live endpoint returned 5 ordered results per strategy against the 500-entry seed.

**Affects:** `server/src/services/SimilaritySearchService.js`, `server/src/repositories/EntryVectorsRepository.js` (`streamCompanySpace`), `server/src/repositories/EntryRepository.js` (`findByIds`), `server/src/routers/EntryRouter.js`, `server/test/similarity.test.js`.

---

## [Day 3] Scenario C migration: keyset pages per stale version, guarded idempotent writes, the version stamp as checkpoint

**Decision:** `npm run migrate:models` (`ModelMigrationService`) collects `distinct` risk model versions, and for each stale version pages with `{ modelVersion: v, status: complete, _id > last }` sorted `_id` ascending — equality + range riding Day 1's `risk_model_version_scan` compound index with zero skipped-and-scanned rows, exactly the shape that index was built for. Per entry it recomputes via the existing `EnrichmentService.compute` (no delay — the 400ms simulation belongs to the async worker, per the `--enrich-historical` precedent) and lands two **guarded** writes: vectors `replaceOne` filtered `modelVersion: { $ne: current }`, then analytics `$set` filtered on the stale version still being in place. A concurrent worker restamp therefore can never be clobbered (its content is at least as fresh), a crash between the writes re-converges on rerun, and rerunning the whole migration is a no-op — the stamp itself is the checkpoint, no state file. Batch size defaults to `MIGRATION_BATCH_SIZE` (100, `--batch-size` override): bounds memory to one page of lean docs, amortises round-trips, and logs progress at a readable cadence. `--dry-run` reports per-version counts. Only `status: complete` entries migrate — in-flight ones get current stamps from whichever worker completes them.

**Alternatives considered:** one long-lived `find().cursor()` stream (also literally "cursor pagination", but can time out mid-migration and is not resumable; stateless keyset batches are the stronger answer to "without exhausting database memory limits"); `.skip()` (spec-prohibited, and O(n²) scan work); driving the migration through the queue with `reason: model_migration` (500 status flips would churn the claimable index and demote settled entries to `pending` for no benefit — the reason value remains available for future use).

**Timestamp refinement of Day 2 (flagged, not silently overridden):** migration writes use `timestamps: false` — a model upgrade is analytics churn, not a ledger content change, and months-old entries must not surface as freshly edited. Day 2's "completion bumps `updated`" stands for enrichment that follows a genuine content change; `analytics.risk.computedAt` is the migration witness. Asserted in `migration.test.js`.

**Verified:** live run migrated the full 500-entry `--enrich-historical` fixture `risk-v0 → risk-v1` in five batches of 100 (4.0s); tests cover multi-page exactness (batch 2 over 7 docs, each migrated exactly once), rerun no-op, dry-run, and the no-clobber guards under a simulated concurrent restamp.

**Affects:** `server/src/scripts/migrateModels.js`, `server/src/scripts/ModelMigrationService.js`, `server/src/util/KeysetPager.js`, `server/src/repositories/EntryRepository.js` (page/count/guarded-write methods), `server/src/repositories/EntryVectorsRepository.js` (`replaceIfStale`), `server/test/migration.test.js`.

---

## [Day 3] Scenario D's bulk script: reevaluate:risk, added to Day 3 scope

**Decision:** `npm run reevaluate:risk` (`RiskReEvaluationService`) is the "partial evaluation script" SPEC.md Scenario D literally requires: after shifting `RiskThresholds` / `APPROVAL_THRESHOLD` (centralised in `Constants.js` on Day 2 for exactly this), it keyset-pages all settled entries, re-derives anomalies + risk + compliance via `PartialEvaluationService`, and applies a targeted `$set` on `analytics.*` guarded on `status: complete` (an in-flight recompute owns its entry and will apply current thresholds itself). Anomalies are recomputed too, not just the scalars — the score is a function of the signals and threshold shifts change which signals fire; the spec's real boundary is cheap analytics vs expensive vectors. The script imports no vectors handle; `timestamps: false` for the same reason as the migration. Reports re-evaluated/tier-changed/skipped counts. Script name is my choice (the spec fixes only its five named commands); scope addition to Day 3 was approved at plan review — it shares `KeysetPager` with Scenario C and `PartialEvaluationService` with the PUT's D route, and Day 4 has no room for a spec-mandated artifact.

**Verified (live):** 500 entries re-scored in 1.6s across five keyset batches with the newest `entry_vectors.updated` timestamp identical before and after the run — the collection-wide freeze witnessed, not asserted. Test-level: `migration.test.js` deep-equals the entire vector collection across a run.

**Affects:** `server/src/scripts/reevaluateRisk.js`, `server/src/scripts/RiskReEvaluationService.js`, `server/src/repositories/EntryRepository.js` (`pageCompleteEntries`, `applyReEvaluatedAnalytics`), `package.json` + `server/package.json` (`reevaluate:risk`).

---

## [Day 3] Smaller calls, recorded so later phases don't relitigate them

- **The PUT response shape is `{ routing, entry }`.** The Day 4 dashboard should read `routing.scenario` to decide UI behaviour (e.g. show "recomputing…" only for B/D) rather than re-deriving the classification client-side.
- **Scenario E does bump the ledger `updated`** (a comment/workflow change is a genuine record update, unlike worker churn or model churn) and stamps `auditMeta.lastMetadataUpdate`; it touches no queue field and no analytics.
- **A comment is append-only through PUT** (`$push`); there is no comment edit/delete surface — out of scope for the spec's audit-log scenario.
- **Similarity results include `stale`** so the Day 4 diagnostics modal can badge pre-migration candidates instead of hiding them.
- **`.env.example` needed no Day 3 additions** — batch size was already `MIGRATION_BATCH_SIZE`, and the scripts take `--batch-size`/`--dry-run` flags.

**Affects:** `server/src/controllers/EntryController.js`, `server/src/services/UpdatePlanner.js`, `server/src/services/SimilaritySearchService.js`.

---

## [Day 3] Independent verification pass: 5/5 PASS, one demo-relevant anomaly recorded

An independent verification agent (fresh `SPEC.md` read, no session context) ran a 24-case PUT routing matrix, byte-for-byte vector-freeze checks (element-by-element over all 192 vector components, plus a SHA-256 sweep of the whole `entry_vectors` collection across a `reevaluate:risk` run), a `--batch-size=7` migration over 500 records (71×7+3 keyset pages, exactly-once, re-run no-op), a full-source grep confirming no executable `.skip()`, hand-recomputed cosines (diff ≤ 7.7e-6), and a cold-start run-surface audit. All five items passed; local `.env` was refreshed from the current `.env.example` (it was a stale copy — harmless, `Config` defaults matched, but now accurate).

**Anomaly worth remembering for Day 4's demo (not a bug, deliberately not "fixed"):** under the `semantic` strategy, planted near-duplicate siblings can be crowded out of the top-5 by ties. The seed draws descriptions from a small template pool, so ~22 same-company entries share the exact normalized text "vendor invoice booked against purchase order" and all tie at cosine exactly 1.0; the fixed 5-slot table then keeps whichever ties arrive first in scan order. The siblings *score* joint-top — they just may not be *returned* when the query entry's description is boilerplate. This is the semantic space working as specified (identical text IS maximally semantically similar; distinguishing same-text entries by vendor is precisely the `entity` strategy's job, and entity does surface the true siblings). Re-ranking ties to favour seed-cluster members would be overfitting detection to the answer key — the same principle as the detector not importing `SUSPICIOUS_DESCRIPTIONS`. **Day 4 demo guidance:** pick a cluster whose descriptions are distinctive (or demo duplicates via the `entity` strategy) when recording the walkthrough.

Also confirmed by the verifier, already known and scheduled: `npm run start:client` fails (no `client/` yet) and `README.md` does not exist — both are Day 4 deliverables; and the machine's unrelated `decideiq` container occupies port 3000, which will collide with `CLIENT_PORT=3000` on Day 4 (plan to stop it or change the port).

**Affects:** `.env` (local only), Day 4 demo script.

---

## [Day 4] Client stack: Vite + React class components, Bootstrap as CSS only, dev-proxy instead of CORS

**Decision:** `client/` is a Vite + React 18 app in plain JS. Every component from `<App/>` down is a `React.Component` class — including small presentational pieces (`TierBadge`, `StaleBadge`, `VectorBars`). `main.jsx` holds the single non-class line in the codebase, the `createRoot(...).render(<App/>)` call, which has no component form. Bootstrap 5 is consumed as **CSS only**; `react-bootstrap` is deliberately not a dependency. Vite proxies `/api` to `VITE_API_BASE_URL`, so the browser is always same-origin with the dev server and the Express app needed no CORS middleware.

**Alternatives considered:** `react-bootstrap` for the modal/table widgets (rejected: its components are internally function components using hooks — importing them would put hooks in the rendered tree, which is the exact thing `SPEC.md` §4 and `CLAUDE.md` constraint #2 prohibit; the constraint is about the UI being written with class components, and shipping a hook-based component library through the back door reads as evasion); Create React App (unmaintained, and `.env.example` already documented `VITE_API_BASE_URL`, fixing the intent); adding the `cors` package server-side (a second way to reach the API, and a production-shaped concern solved for a local dev convenience — the proxy is strictly narrower).

**Cost accepted:** hand-rolling modal markup and dropdown behaviour against Bootstrap's CSS classes. Small: the modal is `this.state`-controlled markup with a backdrop click and an Escape listener, which is less code than wiring Bootstrap's JS would have been.

**Affects:** `client/**`, `vite.config.js`, `.env.example` (comment clarifying `VITE_API_BASE_URL` is the proxy target), root `package.json` (`setup` now installs `client/` too).

---

## [Day 4] Additive `GET /api/entries/:id/vectors`, in its own service to preserve the Day 1 import boundary

**Decision:** a read-only route returning `{ entryId, modelVersion, stale, sourceHash, dims, spaces: { semantic|financial|entity: { values, norm } } }`, 400 on a bad id, 404 for an unknown entry, **409 while the entry is unenriched** (mirroring the similarity endpoint's contract rather than inventing a second one). It lives in a new `VectorDiagnosticsService`, **not** on `EntryService`.

**Why a separate class:** `EntryService` owns the `PUT` path, and Day 1 established that Scenario D's execution path must hold no handle to the vectors collection. Hanging this read on `EntryService` would have put an `EntryVectorsRepository` in scope of the update path — degrading a structural guarantee back into a behavioural one for no benefit. A separate service keeps `EntryService`'s imports vector-free, which is the property that makes "Scenario D cannot touch vectors" checkable by reading the import list.

**Why it exists at all:** the spec requires a "deep-dive multi-vector diagnostics modal", and Day 1 named exactly two consumers for `entry_vectors` — the similarity endpoint and the diagnostics modal. Only the first had a route. Same additive-GET precedent as Day 2's user-confirmed list/detail GETs. Confirmed with the user at Day 4 plan approval.

**Affects:** `server/src/services/VectorDiagnosticsService.js`, `EntryController.getVectors`, `EntryRouter` (mounted before `/:id` alongside `search/similar`), `App.js` wiring.

---

## [Day 4] UI async model: the entry list *is* the queue view; adaptive `setTimeout` chain, not `setInterval`

**Decision:** no polling of a job API, because Day 2 decided there is no job API — `analytics.enrichment.status` on the entry document is the queue state, so re-fetching entries *is* reading the queue. `AuditDashboard` runs a `setTimeout` chain started in `componentDidMount` and cleared in `componentWillUnmount`, re-armed after every fetch completes: **2 s** while any listed entry is `pending`/`processing`, **10 s** when everything is settled. An in-flight flag drops overlapping fetches; an `unmounted` flag drops late responses. The open `DiagnosticsModal` polls its single entry on the same rule and refetches vectors on a `pending → complete` transition. After a `PUT`, the UI reads `routing.scenario` from the response to decide whether to expect worker activity at all (B/D yes, E/`no_op` no) — honouring the Day 3 note that the dashboard should read the routing block rather than re-derive the classification client-side.

**Alternatives considered:** `setInterval` (a response slower than the interval stacks requests — the failure mode gets worse exactly when the server is under load); a fixed 1 s poll (wasteful on a settled 500-row ledger, and the spec's own concern is scaling behaviour); WebSockets/SSE (a real answer at scale, but it needs a second transport and a push path out of the worker, and Day 2 deliberately avoided change streams to stay correct on standalone `mongod` — the same reasoning applies).

**Bug found and fixed during live verification (worth recording because it is a class of mistake, not a typo):** the first implementation scheduled the next poll from `this.state`, which `setState` had not yet committed — so after a save that queued a recompute, the component read the *pre-save* entry, concluded nothing was in flight, and never started the fast poll. The banner sat on "recomputing…" indefinitely even though the worker had finished in ~400 ms. Fixed by passing the freshly-fetched entry explicitly into the scheduling function rather than reading component state. Both `AuditDashboard.refresh` and `DiagnosticsModal.#refreshEntry` now do this. Verified live afterwards: the banner transitions to "Recompute finished — analytics below are fresh."

**Affects:** `client/src/components/AuditDashboard.jsx`, `client/src/components/DiagnosticsModal.jsx`, `client/src/domain/constants.js` (`POLL_ACTIVE_MS`, `POLL_IDLE_MS`, `isInFlight`).

---

## [Day 4] Save guard: three UI behaviours, each mirroring a backend guarantee rather than substituting for one

**Decision:**

1. **Disable-while-saving** — `this.state.saving` gates the submit handler and disables the button. This is the spec's "sequential double-clicks on save actions" case.
2. **Dirty-fields-only PUT** — the form diffs its draft against the entry snapshot and sends only changed keys; save is disabled when nothing is dirty.
3. **409 means reload, never blind retry** — on a CAS conflict the form refetches the entry, resets to server truth, and tells the auditor to re-apply. The UI never re-submits a write the server just refused.

**Why framed as mirroring:** the correctness here is already backend-side — diff-based classification makes an identical re-send a `no_op`, queue coalescing collapses N re-enqueues into one recompute, and the optimistic CAS on `updated` is what actually prevents a lost update. The UI layer is defence in depth and UX, and is deliberately documented that way in the code comments so a reviewer does not read it as *the* mitigation. Sending only dirty fields additionally keeps `routing.changedFields` meaningful instead of listing every field on the form.

**Verified (user-required this be demonstrated, not merely described):**

- *Double-click:* two identical PUTs → `routing.scenario: "B"` then `"no_op"`; the second wrote nothing and queued nothing.
- *Contention:* parallel writer loops against one entry recorded 386 responses, **14 of them 409**; the entry settled `complete` at `attempts: 1` with no lost update or stranded job.
- *Two-tab concurrent edit:* two tabs open on the same entry; tab B saved `glNumber`, then tab A — two writes stale — saved `description`. Accepted with correct `B` routing and the form re-synchronised to the server's merged state (disjoint fields, and each PUT re-plans from a fresh read; the single internal CAS retry absorbs exactly this case).
- *409 UI branch:* exercised by injecting a 409 into one save, since reproducing a natural CAS miss against a specific browser click is timing-dependent. Form showed the reload notice and reset to server values. **Recorded honestly in `README.md` as an injected response, not a natural one.**

**Affects:** `client/src/components/panels/EditEntryForm.jsx`, `AuditMetaPanel.jsx`, `NewEntryForm.jsx`, `client/src/api/ApiClient.js` (`ApiError` carries `status` so components branch on 409 without string-matching).

---

## [Day 4] Demo media: three screenshots, with the worker log committed verbatim beside its rendering

**Decision:** screenshots rather than a video (user-chosen at plan approval; the spec accepts either). Captured against the real running stack with a headless-Chrome script driving the actual client: (1) dashboard with risk colour-coding and a genuinely `pending` entry mid-enrichment, (2) the diagnostics modal for the spec's canonical high-risk shape — unbalanced, 02:00 weekend, evasive narrative, amount just under the approval threshold — scoring 1.00/high with all four factors, four IFRS flags, four anomaly signals, all three vector spaces and a live entity-strategy similarity search, (3) the worker log across a create, a Scenario B recompute and a Scenario D partial, with Scenario E producing no line at all.

The log image is a **syntax-highlighted rendering** of captured worker output, not a photograph of a terminal. Rather than let that pass as a terminal screenshot, the verbatim output is committed beside it as `docs/media/worker-recompute.txt` and the README says plainly what the image is. (Renamed from `.log` because `.gitignore` excludes `*.log` — it would otherwise have shipped as a broken reference.)

**Demo-entry choice follows the Day 3 verification note:** the similarity panel is captured under the `entity` strategy, avoiding the semantic-space tie-crowding that would make a boilerplate-description query look like a miss.

**Also worth remembering:** the client's strategy buttons carry `text-capitalize`, so `innerText` renders as `"Entity"` while `textContent` is `"entity"` — this cost a debugging cycle in the capture script and will bite any future DOM automation against this UI.

**Affects:** `docs/media/*`, `README.md` demo section.

---

## [Day 4] Final verification pass and README

**Verified end to end against the running stack** (Docker Mongo, seeded 500 with `--enrich-historical`, server, worker, client):

| Scenario | Evidence |
|---|---|
| A | Entry created through the UI form appeared `pending`; worker logged `reason=create, pipeline=full, attempt=1`; enriched in 436 ms to risk 1.00/high, compliance fail, 4 anomalies; dashboard flipped via polling. |
| B | `description` edit → `routing.scenario: "B"`; worker `reason=core_field_change, pipeline=full`; vector document hash **changed** (`02C481D0…` → `873B41B8…`). |
| C | `migrate:models` moved 499 entries `risk-v0 → risk-v1` in five keyset batches (3.5 s); `stale` badges cleared in the modal and in similarity results. |
| D | `debit` edit → `routing.scenario: "D"`; worker `reason=context_shift, pipeline=partial`; risk moved 0.00 → 0.45/medium while the vector document hash stayed **byte-identical**. Bulk `reevaluate:risk` re-scored 501 entries in 1.8 s with the sampled vector document unchanged. |
| E | Workflow status + comment saved; `routing.scenario: "E"`; `auditMeta.lastMetadataUpdate` stamped, `analytics.enrichment` untouched, **no worker log line at all**. |

`npm test` — 31/31 pass. The B-then-D sequence on one entry is the sharpest single artefact: same entry, same modal, two edits, and the vector hash moves for exactly one of them.

**README structure:** quick start, `.env.example` walkthrough as a table, command table, demo media, API reference (including the error contract and the `routing` block), an architecture-decisions section distilled from this file, a scenario→implementation map, the verification results above, and an explicit known-trade-offs section (semantic tie-crowding, the D-route financial-vector staleness, no per-run job history, append-only comments, unpaginated list endpoint).

**Links to `SPEC.md` were removed and reworded as prose:** `.gitignore` excludes `SPEC.md`/`CLAUDE.md`/`DAY_PLAN.md` from the deliverable, so a reviewer's clone would have hit a dead link. `DECISIONS.md` *is* tracked, so the README links to it freely.

**Affects:** `README.md`, `docs/media/*`.

---

## [Day 4] What I would change for production — deliberate scope boundaries, not oversights

Recorded so the line between "assessment scope" and "what I actually think production needs" is explicit. Everything below was a conscious decision to stop, not something missed.

**Security — the largest gap, and the one I would fix first.**
There is no authentication or authorization anywhere. `companyId` and `userId` arrive in the `POST /api/entries` body and are trusted. Tenant isolation in the similarity search is enforced against *that* client-supplied value, which means the isolation is real in code but trivially bypassable by a caller who lies. Production needs authenticated sessions, `companyId` derived server-side from the principal rather than the payload, and per-tenant authorization checks in the repository layer. On a graded local run this would have been ceremony; on anything real it is the first requirement, not the last.

Alongside it: no rate limiting, no request-size policy beyond the 256 KB JSON cap, no CORS policy (the client is same-origin via the dev proxy, which is a development-time answer, not a deployment one), and `MONGODB_URI` sits in a `.env` file rather than a secrets manager.

**Ledger immutability is documented, not enforced.**
The spec describes journal entries as immutable, and the `PUT` whitelist honours that in spirit — `entryNo`, `currency` and vendor identity are unwritable. But nothing at the database level prevents a direct mutation, and edits overwrite in place rather than appending a revision. A real audit system wants append-only history: every core-field change as a new immutable revision with the prior value retained, which is also what makes an audit trail defensible. That is a schema change, not a patch, which is why it was not attempted here.

**The queue would eventually need to stop being a poll.**
The MongoDB-native queue is the right call at this scale and I would defend it (see the Day 2 entry). Its ceiling is real though: poll-and-drain costs a query per lane per interval whether or not there is work, and at high job volume that becomes the dominant load. The upgrade path is ordered — first change streams to replace polling with push (the reason Day 1 kept the replica set even without depending on it), then an external broker only if throughput genuinely demands it. There is also no dead-letter *surface*: `failed` jobs are queryable but nothing alerts on them, and there is no retry-from-failed admin path.

**No per-run job history** (already noted Day 2): the entry document holds latest-attempt state only. Production auditing of the pipeline itself — who recomputed what, when, under which model — needs a separate append-only run log.

**Similarity search is O(n) per query.**
The streaming scan is honest at 500 entries and would be wrong at a million. `entry_vectors` was deliberately shaped as the seam where Atlas Vector Search, pgvector, or a dedicated ANN index drops in without the ledger schema changing — that substitution is the intended next step, not a rewrite.

**The AI is mocked, and the seams show where it matters.**
Feature-hashed deterministic vectors and heuristic risk rules stand in for real models. Swapping in genuine embeddings changes two things beyond the obvious: the migration story gets much heavier (re-embedding a large ledger is a long, resumable, rate-limited job rather than a 3.5-second pass), and model versioning needs rollback, not just forward migration — `migrate:models` currently only moves stale → current and has no reverse path.

**Operational visibility is `console.log`.**
No structured logging, no metrics, no tracing, no alerting on queue depth or failure rate. For a system whose whole value is asynchronous background work, "is the worker keeping up?" should be a dashboard, not something inferred by reading a terminal.

**Smaller, but real:**
- `POST /api/entries` has no idempotency key; a retried create succeeds twice unless it happens to collide on the unique `(companyId, entryNo)` index.
- `GET /api/entries` has no pagination, only `?limit` capped at 200 — the `KeysetPager` machinery to fix this already exists.
- `WORKER_LEASE_MS` is a fixed constant rather than tuned against observed pipeline duration; too short causes duplicate work, too long delays crash recovery.
- No CI, no application containerization (only MongoDB is dockerised), no deployment configuration.
- Test coverage is deliberately targeted at the paths where being wrong is expensive and non-obvious — claim concurrency, delta routing, migration exactness, similarity correctness — rather than comprehensive. There are no HTTP-layer tests and no frontend tests. For a time-boxed assessment I would make the same trade again; for a maintained system the HTTP contract deserves its own suite, because that is the surface consumers actually bind to.

**Affects:** nothing in the current codebase — this entry is scope documentation, and exists so that "we did not do X" reads as a decision with a reason rather than as something nobody thought about.
