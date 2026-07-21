import React from 'react';
import { Format } from '../../util/Format.js';
import { ComplianceBadge, SeverityBadge } from '../Badges.jsx';

export class CompliancePanel extends React.Component {
  render() {
    const { compliance } = this.props;

    if (!compliance || !compliance.status) {
      return <p className="text-secondary small mb-0">Not evaluated yet — awaiting enrichment.</p>;
    }

    return (
      <div>
        <div className="mb-2">
          <ComplianceBadge status={compliance.status} />
          <span className="text-secondary small ms-2">
            ruleset <span className="font-monospace">{compliance.rulesetVersion}</span> · evaluated{' '}
            {Format.dateTime(compliance.evaluatedAt)}
          </span>
        </div>
        {(compliance.flags ?? []).length > 0 ? (
          <ul className="list-unstyled small mb-0">
            {compliance.flags.map((flag) => (
              <li key={flag.code} className="mb-1">
                <SeverityBadge severity={flag.severity} />{' '}
                <span className="font-monospace">{flag.code}</span>
                <span className="badge text-bg-light border ms-1">{flag.standard}</span>
                <div className="text-secondary ms-1">{flag.message}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-secondary small mb-0">No compliance flags.</p>
        )}
      </div>
    );
  }
}
