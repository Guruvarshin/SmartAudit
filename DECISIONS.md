# Decision Log

Maintained by Claude Code, one entry per architectural decision, appended at the end of each day/phase per `DAY_PLAN.md`. Read this file at the start of every session, right after `SPEC.md`, before writing any code.

Purpose: a fresh session (or a fresh subagent) should be able to read this file alone and know every non-obvious choice already made, without re-deriving it or contradicting it. If you're about to make a call that touches something already logged here, reconcile with the existing entry explicitly — don't silently override it.

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

**Note on `CLAUDE.md` constraint #1:** logic lives in classes (`Config`, `MongoConnection`, `EntryFactory`, `SeedRunner`, `SeededRandom`, `CliArguments`, and the Day 2+ controllers/services/repositories/workers). Mongoose **schema definitions** and the frozen vocabulary in `domain/Constants.js` are declarative data, not the "loose, procedural functional modules" the constraint forbids, so they are not wrapped in ceremonial classes. Flagged to the user at plan approval.

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
