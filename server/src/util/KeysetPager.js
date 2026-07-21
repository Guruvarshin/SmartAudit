/**
 * Keyset (cursor) pagination driver, shared by the Scenario C migration and
 * the Scenario D bulk re-evaluation.
 *
 * Each page is fetched by "everything after the last _id I saw", so the
 * database never counts past skipped rows (`.skip()` is exactly what SPEC.md
 * Scenario C prohibits) and the process holds at most one page of lean
 * documents at a time regardless of collection size. The pager is stateless
 * between pages — a crash resumes by simply re-running, because the callers'
 * writes are guarded and idempotent: already-processed documents no longer
 * match the page filter and converge to a no-op.
 */
export class KeysetPager {
  /**
   * @param {{ fetchPage: (afterId: object | null, batchSize: number) => Promise<object[]>,
   *           batchSize: number }} options
   *   fetchPage must return documents sorted ascending by _id, filtered to
   *   `_id > afterId` when afterId is non-null.
   */
  constructor({ fetchPage, batchSize }) {
    this.fetchPage = fetchPage;
    this.batchSize = batchSize;
  }

  /** Yields pages (arrays of documents) until the underlying scan is exhausted. */
  async *pages() {
    let afterId = null;
    for (;;) {
      const page = await this.fetchPage(afterId, this.batchSize);
      if (page.length === 0) return;
      yield page;
      afterId = page[page.length - 1]._id;
    }
  }
}
