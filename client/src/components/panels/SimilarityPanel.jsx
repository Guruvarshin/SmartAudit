import React from 'react';
import { ApiError } from '../../api/ApiClient.js';
import { VECTOR_STRATEGIES } from '../../domain/constants.js';
import { Format } from '../../util/Format.js';
import { StaleBadge, TierBadge } from '../Badges.jsx';

/**
 * Three-strategy similarity search. Candidates whose vectors predate the
 * current model version are badged stale rather than silently compared.
 */
export class SimilarityPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      strategy: null, // no search until the auditor picks a space
      loading: false,
      results: null,
      error: null
    };
  }

  handleStrategy(strategy) {
    // Re-clicking the active strategy re-runs it: results shift after a
    // recompute or migration.
    this.setState({ strategy, loading: true, error: null }, () => this.#search(strategy));
  }

  async #search(strategy) {
    try {
      const response = await this.props.apiClient.searchSimilar(this.props.entryId, strategy);
      if (this.state.strategy !== strategy) return; // superseded by a later click
      this.setState({ loading: false, results: response.results });
    } catch (error) {
      if (this.state.strategy !== strategy) return;
      const message =
        error instanceof ApiError && error.status === 409
          ? 'This entry has not been enriched yet — its vectors do not exist until the worker completes. Retry shortly.'
          : error.message;
      this.setState({ loading: false, results: null, error: message });
    }
  }

  render() {
    const { strategy, loading, results, error } = this.state;

    return (
      <div>
        <div className="btn-group btn-group-sm mb-2" role="group" aria-label="Search strategy">
          {VECTOR_STRATEGIES.map((space) => (
            <button
              key={space}
              type="button"
              className={`btn ${strategy === space ? 'btn-primary' : 'btn-outline-primary'} text-capitalize`}
              onClick={() => this.handleStrategy(space)}
              disabled={loading}
            >
              {space}
            </button>
          ))}
        </div>

        {loading && (
          <p className="text-secondary small mb-0">
            <span className="spinner-border spinner-border-sm me-1" /> Scanning {strategy} space…
          </p>
        )}

        {error && <div className="alert alert-warning py-1 px-2 small mb-0">{error}</div>}

        {!loading && !error && results && results.length === 0 && (
          <p className="text-secondary small mb-0">
            No comparable entries (degenerate vector in this space).
          </p>
        )}

        {!loading && results && results.length > 0 && (
          <table className="table table-sm table-hover small mb-0">
            <thead>
              <tr>
                <th className="text-end">Similarity</th>
                <th>Entry №</th>
                <th>Name</th>
                <th>Description</th>
                <th className="text-end">Amount</th>
                <th>Risk</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {results.map((hit) => (
                <tr
                  key={hit.entryId}
                  role="button"
                  onClick={() => this.props.onOpenEntry(hit.entryId)}
                  title="Open this entry's diagnostics"
                >
                  <td className="text-end fw-semibold">{hit.similarity.toFixed(4)}</td>
                  <td className="font-monospace">{hit.entry?.entryNo ?? hit.entryId}</td>
                  <td>{Format.truncate(hit.entry?.name, 24)}</td>
                  <td className="text-secondary">{Format.truncate(hit.entry?.description, 40)}</td>
                  <td className="text-end">
                    {Format.money(hit.entry?.amount, hit.entry?.currency)}
                  </td>
                  <td>
                    <TierBadge tier={hit.entry?.analytics?.risk?.tier} />
                  </td>
                  <td>
                    <StaleBadge stale={hit.stale} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && !results && !error && (
          <p className="text-secondary small mb-0">
            Pick a strategy to find the top-5 closest transactions in that vector space.
          </p>
        )}
      </div>
    );
  }
}
