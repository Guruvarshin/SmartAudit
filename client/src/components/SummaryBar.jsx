import React from 'react';

export class SummaryBar extends React.Component {
  render() {
    const { entries } = this.props;
    const count = (predicate) => entries.filter(predicate).length;

    const cards = [
      { label: 'Entries shown', value: entries.length, className: 'text-bg-dark' },
      {
        label: 'High risk',
        value: count((entry) => entry.analytics?.risk?.tier === 'high'),
        className: 'text-bg-danger'
      },
      {
        label: 'Medium risk',
        value: count((entry) => entry.analytics?.risk?.tier === 'medium'),
        className: 'text-bg-warning'
      },
      {
        label: 'Awaiting enrichment',
        value: count((entry) =>
          ['pending', 'processing'].includes(entry.analytics?.enrichment?.status)
        ),
        className: 'text-bg-info'
      },
      {
        label: 'Compliance fail',
        value: count((entry) => entry.analytics?.compliance?.status === 'fail'),
        className: 'text-bg-secondary'
      }
    ];

    return (
      <div className="row g-3 mb-3">
        {cards.map((card) => (
          <div className="col-6 col-md" key={card.label}>
            <div className={`card ${card.className} h-100`}>
              <div className="card-body py-2 px-3">
                <div className="fs-3 fw-bold">{card.value}</div>
                <div className="small opacity-75">{card.label}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }
}
