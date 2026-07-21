import React from 'react';
import { TIER_ROW_CLASS } from '../domain/constants.js';
import { Format } from '../util/Format.js';
import {
  ComplianceBadge,
  EnrichmentStatusBadge,
  TierBadge,
  WorkflowBadge
} from './Badges.jsx';

/** One ledger row; tier drives the row colour (SPEC.md §4 colour-coding). */
export class EntryRow extends React.Component {
  constructor(props) {
    super(props);
    this.handleClick = this.handleClick.bind(this);
  }

  handleClick() {
    this.props.onOpenEntry(this.props.entry._id);
  }

  render() {
    const { entry } = this.props;
    const risk = entry.analytics?.risk;
    const anomalies = entry.analytics?.anomalies ?? [];

    return (
      <tr
        className={TIER_ROW_CLASS[risk?.tier] ?? ''}
        role="button"
        onClick={this.handleClick}
        title="Open diagnostics"
      >
        <td className="font-monospace small">{entry.entryNo}</td>
        <td className="small">{Format.date(entry.postingDate)}</td>
        <td className="small">{Format.truncate(entry.name, 28)}</td>
        <td className="small text-secondary">{Format.truncate(entry.description, 48)}</td>
        <td className="text-end small">{Format.money(entry.amount, entry.currency)}</td>
        <td className="text-end small">{Format.money(entry.debit, entry.currency)}</td>
        <td className="text-end small">{Format.money(entry.credit, entry.currency)}</td>
        <td className="font-monospace small">{entry.glNumber}</td>
        <td className="text-center">
          <span className="me-1 small fw-semibold">{Format.score(risk?.score)}</span>
          <TierBadge tier={risk?.tier} />
        </td>
        <td className="text-center small">{anomalies.length > 0 ? anomalies.length : '—'}</td>
        <td className="text-center">
          <ComplianceBadge status={entry.analytics?.compliance?.status} />
        </td>
        <td className="text-center">
          <EnrichmentStatusBadge status={entry.analytics?.enrichment?.status} />
        </td>
        <td className="text-center">
          <WorkflowBadge status={entry.auditMeta?.workflowStatus} />
        </td>
      </tr>
    );
  }
}

/** The ledger table. Rows open the diagnostics modal. */
export class EntryTable extends React.Component {
  render() {
    const { entries, onOpenEntry } = this.props;

    if (entries.length === 0) {
      return (
        <div className="alert alert-secondary">
          No entries match the current filters. Run <code>npm run seed</code> to hydrate the
          database, or create an entry above.
        </div>
      );
    }

    return (
      <div className="table-responsive bg-white rounded border">
        <table className="table table-hover table-sm align-middle mb-0">
          <thead className="table-light">
            <tr>
              <th>Entry №</th>
              <th>Posted</th>
              <th>Name</th>
              <th>Description</th>
              <th className="text-end">Amount</th>
              <th className="text-end">Debit</th>
              <th className="text-end">Credit</th>
              <th>GL</th>
              <th className="text-center">Risk</th>
              <th className="text-center">Anomalies</th>
              <th className="text-center">Compliance</th>
              <th className="text-center">Enrichment</th>
              <th className="text-center">Workflow</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <EntryRow key={entry._id} entry={entry} onOpenEntry={onOpenEntry} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }
}
