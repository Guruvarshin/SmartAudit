import React from 'react';
import { ENRICHMENT_STATUSES, RISK_TIERS } from '../domain/constants.js';

/** Server-side filters, plus a poll indicator so the refresh loop is visible. */
export class EntryFilters extends React.Component {
  constructor(props) {
    super(props);
    this.handleTierChange = this.handleTierChange.bind(this);
    this.handleStatusChange = this.handleStatusChange.bind(this);
  }

  handleTierChange(event) {
    this.props.onChange({ tier: event.target.value, status: this.props.status });
  }

  handleStatusChange(event) {
    this.props.onChange({ tier: this.props.tier, status: event.target.value });
  }

  render() {
    const { tier, status, polling, lastRefreshedAt, onRefresh } = this.props;

    return (
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <label className="small text-secondary mb-0">Risk tier</label>
        <select
          className="form-select form-select-sm w-auto"
          value={tier}
          onChange={this.handleTierChange}
        >
          <option value="">all</option>
          {RISK_TIERS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>

        <label className="small text-secondary mb-0 ms-2">Enrichment</label>
        <select
          className="form-select form-select-sm w-auto"
          value={status}
          onChange={this.handleStatusChange}
        >
          <option value="">all</option>
          {ENRICHMENT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>

        <button type="button" className="btn btn-sm btn-outline-secondary ms-2" onClick={onRefresh}>
          Refresh now
        </button>

        <span className="small text-secondary ms-auto">
          {polling ? (
            <>
              <span
                className="spinner-grow spinner-grow-sm me-1 text-info"
                style={{ width: '0.6em', height: '0.6em' }}
              />
              worker active — polling every 2s
            </>
          ) : (
            <>idle — polling every 10s</>
          )}
          {lastRefreshedAt && <> · updated {lastRefreshedAt.toLocaleTimeString()}</>}
        </span>
      </div>
    );
  }
}
