/**
 * HTTP translation for journal-entry routes: unpack the request, call the
 * service, choose a status code. No business rules live here.
 */
export class EntryController {
  constructor({ entryService }) {
    this.entryService = entryService;
  }

  /**
   * POST /api/entries — SPEC.md Scenario A.
   *
   * 201 with the persisted record. The response deliberately shows
   * analytics.enrichment.status 'pending': the contract is "accepted and will
   * be enriched asynchronously", and the caller can poll GET /api/entries/:id
   * to watch the worker's result land.
   */
  async create(req, res) {
    const entry = await this.entryService.create(req.body);
    res.status(201).json(entry);
  }

  /**
   * PUT /api/entries/:id — Scenarios B / D / E, routed by the UpdatePlanner.
   *
   * 200 with { routing, entry }: the routing block names the detected
   * scenario ('B' | 'D' | 'E' | 'no_op') and the action taken, so the
   * classification is part of the API contract rather than something to
   * infer from worker logs.
   */
  async update(req, res) {
    res.json(await this.entryService.update(req.params.id, req.body));
  }

  /** GET /api/entries/:id */
  async getById(req, res) {
    res.json(await this.entryService.getById(req.params.id));
  }

  /** GET /api/entries?limit&tier&status */
  async list(req, res) {
    res.json(await this.entryService.list(req.query));
  }
}
