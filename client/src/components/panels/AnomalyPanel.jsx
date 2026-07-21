import React from 'react';
import { SeverityBadge } from '../Badges.jsx';

/** Granular anomaly signals — each names its type AND the field it fired on (SPEC.md §3.2). */
export class AnomalyPanel extends React.Component {
  render() {
    const { anomalies } = this.props;

    if (!anomalies || anomalies.length === 0) {
      return <p className="text-secondary small mb-0">No anomaly signals raised.</p>;
    }

    return (
      <table className="table table-sm small mb-0">
        <thead>
          <tr>
            <th>Type</th>
            <th>Field</th>
            <th>Severity</th>
            <th className="text-end">Score</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {anomalies.map((signal, index) => (
            <tr key={`${signal.type}-${signal.field}-${index}`}>
              <td className="font-monospace">{signal.type}</td>
              <td className="font-monospace">{signal.field}</td>
              <td>
                <SeverityBadge severity={signal.severity} />
              </td>
              <td className="text-end">{signal.score?.toFixed(2)}</td>
              <td className="text-secondary">{signal.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
}
