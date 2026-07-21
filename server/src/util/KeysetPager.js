/**
 * Keyset pagination driver.
 *
 * Each page is fetched as "everything after the last _id I saw", so the
 * database never counts past skipped rows and memory holds at most one page
 * regardless of collection size. Stateless between pages: a crash resumes by
 * re-running, because the callers' writes are guarded and idempotent, so
 * already-processed documents no longer match the filter.
 *
 * `fetchPage` must return documents sorted ascending by _id, filtered to
 * `_id > afterId` when afterId is non-null.
 */
export class KeysetPager {
  constructor({ fetchPage, batchSize }) {
    this.fetchPage = fetchPage;
    this.batchSize = batchSize;
  }

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
