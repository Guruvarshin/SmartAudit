import React from 'react';
import { Format } from '../../util/Format.js';
import { TierBadge } from '../Badges.jsx';

export class RiskPanel extends React.Component {
  render() {
    const { risk } = this.props;

    if (!risk || risk.score === null || risk.score === undefined) {
      return <p className="text-secondary small mb-0">Not scored yet - awaiting enrichment.</p>;
    }

    const percent = Math.round(risk.score * 100);
    const barClass =
      risk.tier === 'high' ? 'bg-danger' : risk.tier === 'medium' ? 'bg-warning' : 'bg-success';

    return (
      <div>
        <div className="d-flex align-items-center gap-2 mb-2">
          <div className="progress flex-grow-1" style={{ height: '1.4rem' }}>
            <div
              className={`progress-bar ${barClass}`}
              style={{ width: `${Math.max(percent, 4)}%` }}
            >
              {risk.score.toFixed(2)}
            </div>
          </div>
          <TierBadge tier={risk.tier} />
        </div>

        {(risk.factors ?? []).length > 0 ? (
          <table className="table table-sm small mb-1">
            <thead>
              <tr>
                <th>Factor</th>
                <th className="text-end">Weight</th>
                <th className="text-end">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {risk.factors.map((factor) => (
                <tr key={factor.code}>
                  <td>
                    <span className="font-monospace">{factor.code}</span>
                    <span className="text-secondary"> - {factor.label}</span>
                  </td>
                  <td className="text-end">{factor.weight?.toFixed(2)}</td>
                  <td className="text-end">{factor.contribution?.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-secondary small mb-1">No elevated risk factors.</p>
        )}

        <div className="text-secondary small">
          model <span className="font-monospace">{risk.modelVersion}</span> | computed{' '}
          {Format.dateTime(risk.computedAt)}
        </div>
      </div>
    );
  }
}
