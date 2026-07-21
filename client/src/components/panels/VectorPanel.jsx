import React from 'react';
import { VECTOR_STRATEGIES } from '../../domain/constants.js';
import { StaleBadge } from '../Badges.jsx';

/** Signed values as bars around a midline. */
export class VectorBars extends React.Component {
  render() {
    const { values } = this.props;
    const width = 256;
    const height = 56;
    const mid = height / 2;
    const barWidth = width / values.length;
    const maxAbs = Math.max(...values.map(Math.abs), 1e-9);

    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-100 border rounded bg-white"
        style={{ maxHeight: '72px' }}
        role="img"
      >
        <line x1="0" y1={mid} x2={width} y2={mid} stroke="#dee2e6" strokeWidth="1" />
        {values.map((value, index) => {
          const magnitude = (Math.abs(value) / maxAbs) * (mid - 2);
          const y = value >= 0 ? mid - magnitude : mid;
          return (
            <rect
              key={index}
              x={index * barWidth + 0.5}
              y={y}
              width={Math.max(barWidth - 1, 0.5)}
              height={Math.max(magnitude, 0.5)}
              fill={value >= 0 ? '#0d6efd' : '#dc3545'}
            >
              <title>{`dim ${index}: ${value.toFixed(4)}`}</title>
            </rect>
          );
        })}
      </svg>
    );
  }
}

/**
 * All three spaces, read from the separate entry_vectors collection. This
 * panel visibly not moving during a risk-only update is the schema isolation
 * on display.
 */
export class VectorPanel extends React.Component {
  render() {
    const { vectors, vectorsStatus } = this.props;

    if (vectorsStatus === 'loading') {
      return (
        <p className="text-secondary small mb-0">
          <span className="spinner-border spinner-border-sm me-1" /> Loading vectors…
        </p>
      );
    }
    if (vectorsStatus === 'unenriched') {
      return (
        <p className="text-secondary small mb-0">
          No vectors yet — they are computed by the background worker during enrichment.
        </p>
      );
    }
    if (vectorsStatus === 'error' || !vectors) {
      return <p className="text-danger small mb-0">Could not load vectors.</p>;
    }

    return (
      <div>
        <div className="text-secondary small mb-2">
          {vectors.dims} dims per space · model{' '}
          <span className="font-monospace">{vectors.modelVersion}</span>{' '}
          <StaleBadge stale={vectors.stale} /> · source hash{' '}
          <span className="font-monospace">{String(vectors.sourceHash).slice(0, 12)}…</span>
        </div>
        <div className="row g-3">
          {VECTOR_STRATEGIES.map((space) => (
            <div className="col-md-4" key={space}>
              <div className="small fw-semibold text-capitalize mb-1">
                {space}
                <span className="text-secondary fw-normal ms-2">
                  ‖v‖ = {vectors.spaces[space].norm.toFixed(4)}
                </span>
              </div>
              <VectorBars values={vectors.spaces[space].values} />
            </div>
          ))}
        </div>
      </div>
    );
  }
}
