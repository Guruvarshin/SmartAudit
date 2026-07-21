import React from 'react';
import {
  COMPLIANCE_BADGE_CLASS,
  SEVERITY_BADGE_CLASS,
  STATUS_BADGE_CLASS,
  TIER_BADGE_CLASS,
  WORKFLOW_BADGE_CLASS
} from '../domain/constants.js';

/** Risk tier chip; renders an em-dash chip while the entry is un-scored. */
export class TierBadge extends React.Component {
  render() {
    const { tier } = this.props;
    if (!tier) return <span className="badge text-bg-light border">—</span>;
    return <span className={`badge ${TIER_BADGE_CLASS[tier] ?? 'text-bg-secondary'}`}>{tier}</span>;
  }
}

/** Enrichment lifecycle chip; pending/processing animate to signal the worker is owed. */
export class EnrichmentStatusBadge extends React.Component {
  render() {
    const { status } = this.props;
    const busy = status === 'pending' || status === 'processing';
    return (
      <span className={`badge ${STATUS_BADGE_CLASS[status] ?? 'text-bg-secondary'}`}>
        {busy && (
          <span
            className="spinner-border spinner-border-sm me-1"
            style={{ width: '0.7em', height: '0.7em' }}
            role="status"
          />
        )}
        {status ?? 'unknown'}
      </span>
    );
  }
}

export class SeverityBadge extends React.Component {
  render() {
    const { severity } = this.props;
    return (
      <span className={`badge ${SEVERITY_BADGE_CLASS[severity] ?? 'text-bg-secondary'}`}>
        {severity}
      </span>
    );
  }
}

export class ComplianceBadge extends React.Component {
  render() {
    const { status } = this.props;
    if (!status) return <span className="badge text-bg-light border">—</span>;
    return (
      <span className={`badge ${COMPLIANCE_BADGE_CLASS[status] ?? 'text-bg-secondary'}`}>
        {status}
      </span>
    );
  }
}

export class WorkflowBadge extends React.Component {
  render() {
    const { status } = this.props;
    return (
      <span className={`badge ${WORKFLOW_BADGE_CLASS[status] ?? 'text-bg-secondary'}`}>
        {(status ?? 'unreviewed').replace('_', ' ')}
      </span>
    );
  }
}

/** Marks similarity candidates / vector docs computed by a superseded model (Scenario C). */
export class StaleBadge extends React.Component {
  render() {
    if (!this.props.stale) return null;
    return (
      <span className="badge text-bg-warning" title="Vectors computed by a superseded model version — run npm run migrate:models">
        stale model
      </span>
    );
  }
}
