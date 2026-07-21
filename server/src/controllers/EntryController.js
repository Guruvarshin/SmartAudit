/** HTTP translation only - no business rules live here. */
export class EntryController {
  constructor({ entryService, similaritySearchService, vectorDiagnosticsService }) {
    this.entryService = entryService;
    this.similaritySearchService = similaritySearchService;
    this.vectorDiagnosticsService = vectorDiagnosticsService;
  }

  async searchSimilar(req, res) {
    res.json(await this.similaritySearchService.search(req.body));
  }

  /** 201 with status 'pending' - the contract is "accepted, enriched asynchronously". */
  async create(req, res) {
    const entry = await this.entryService.create(req.body);
    res.status(201).json(entry);
  }

  /** Responds { routing, entry } so the scenario classification is part of the API contract. */
  async update(req, res) {
    res.json(await this.entryService.update(req.params.id, req.body));
  }

  async getById(req, res) {
    res.json(await this.entryService.getById(req.params.id));
  }

  async getVectors(req, res) {
    res.json(await this.vectorDiagnosticsService.getForEntry(req.params.id));
  }

  async list(req, res) {
    res.json(await this.entryService.list(req.query));
  }
}
