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

  /** GET /api/entries/:id */
  async getById(req, res) {
    res.json(await this.entryService.getById(req.params.id));
  }

  /** GET /api/entries?limit&tier&status */
  async list(req, res) {
    res.json(await this.entryService.list(req.query));
  }
}
