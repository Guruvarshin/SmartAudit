import React from 'react';
import { ApiError } from '../api/ApiClient.js';
import { POLL_ACTIVE_MS, isInFlight } from '../domain/constants.js';
import { Format } from '../util/Format.js';
import { EnrichmentStatusBadge, StaleBadge, TierBadge } from './Badges.jsx';
import { AnomalyPanel } from './panels/AnomalyPanel.jsx';
import { AuditMetaPanel } from './panels/AuditMetaPanel.jsx';
import { CompliancePanel } from './panels/CompliancePanel.jsx';
import { EditEntryForm } from './panels/EditEntryForm.jsx';
import { RiskPanel } from './panels/RiskPanel.jsx';
import { SimilarityPanel } from './panels/SimilarityPanel.jsx';
import { VectorPanel } from './panels/VectorPanel.jsx';

/**
 * Deep-dive view: risk, anomalies, compliance, the three vector spaces,
 * similarity search, and both edit surfaces.
 *
 * Polls the entry only while it is pending or processing, and refetches
 * vectors once enrichment completes. What to expect after a save comes from
 * the PUT response's routing block rather than being re-derived here: B and D
 * mean a worker is owed, E and no_op mean nothing asynchronous happened.
 */
export class DiagnosticsModal extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      entry: null,
      loadError: null,
      vectors: null,
      vectorsStatus: 'loading',
      lastRouting: null
    };
    this.pollTimer = null;
    this.unmounted = false;

    this.handleSaved = this.handleSaved.bind(this);
    this.handleReloaded = this.handleReloaded.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleBackdropClick = this.handleBackdropClick.bind(this);
  }

  componentDidMount() {
    document.addEventListener('keydown', this.handleKeyDown);
    this.#refreshEntry();
    this.#refreshVectors();
  }

  componentWillUnmount() {
    this.unmounted = true;
    document.removeEventListener('keydown', this.handleKeyDown);
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }

  handleKeyDown(event) {
    if (event.key === 'Escape') this.props.onClose();
  }

  handleBackdropClick(event) {
    if (event.target === event.currentTarget) this.props.onClose();
  }

  async #refreshEntry() {
    // Scheduling reads this local, never this.state, which may lag a commit.
    let latest = this.state.entry;
    try {
      const previousStatus = latest?.analytics?.enrichment?.status;
      const entry = await this.props.apiClient.getEntry(this.props.entryId);
      if (this.unmounted) return;

      latest = entry;
      this.setState({ entry, loadError: null });
      this.props.onEntryChanged(entry);

      // A pending->complete transition means fresh analytics just landed, and
      // after a full recompute, fresh vectors too.
      const status = entry.analytics?.enrichment?.status;
      if (previousStatus && previousStatus !== status && status === 'complete') {
        this.#refreshVectors();
      }
    } catch (error) {
      if (!this.unmounted) this.setState({ loadError: error.message });
    } finally {
      this.#schedulePoll(latest);
    }
  }

  async #refreshVectors() {
    try {
      const vectors = await this.props.apiClient.getVectors(this.props.entryId);
      if (!this.unmounted) this.setState({ vectors, vectorsStatus: 'ok' });
    } catch (error) {
      if (this.unmounted) return;
      if (error instanceof ApiError && error.status === 409) {
        this.setState({ vectors: null, vectorsStatus: 'unenriched' });
      } else {
        this.setState({ vectors: null, vectorsStatus: 'error' });
      }
    }
  }

  /** `entry` is passed explicitly because callers hold a fresher document than state. */
  #schedulePoll(entry = this.state.entry) {
    if (this.unmounted) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    // Only while the worker owes this entry a result; the dashboard's slower
    // list poll covers everything else.
    if (isInFlight(entry)) {
      this.pollTimer = setTimeout(() => this.#refreshEntry(), POLL_ACTIVE_MS);
    }
  }

  handleSaved(routing, entry) {
    this.setState({ entry, lastRouting: routing });
    this.props.onEntryChanged(entry);
    this.#schedulePoll(entry);
  }

  /** The 409 path: server truth replaces our snapshot, no routing to show. */
  handleReloaded(entry) {
    this.setState({ entry, lastRouting: null });
    this.props.onEntryChanged(entry);
    this.#schedulePoll(entry);
  }

  #routingBanner() {
    const { lastRouting, entry } = this.state;
    if (!lastRouting) return null;

    const busy = isInFlight(entry);
    const expectsWorker = lastRouting.scenario === 'B' || lastRouting.scenario === 'D';
    const tone = busy ? 'alert-info' : 'alert-success';

    return (
      <div className={`alert ${tone} py-2 d-flex align-items-center gap-2 mb-3`}>
        {busy && expectsWorker && <span className="spinner-border spinner-border-sm" />}
        <div>
          <strong>Scenario {lastRouting.scenario}</strong> - {lastRouting.action}
          {lastRouting.changedFields?.length > 0 && (
            <span className="text-secondary">
              {' '}
              (changed: {lastRouting.changedFields.join(', ')})
            </span>
          )}
          {expectsWorker && (
            <div className="small">
              {busy
                ? 'Background worker is recomputing this entry...'
                : 'Recompute finished - analytics below are fresh.'}
            </div>
          )}
        </div>
      </div>
    );
  }

  render() {
    const { entry, loadError } = this.state;

    return (
      <div
        className="modal d-block"
        style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
        tabIndex={-1}
        onClick={this.handleBackdropClick}
      >
        <div className="modal-dialog modal-xl modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header py-2">
              <h5 className="modal-title">
                {entry ? (
                  <>
                    <span className="font-monospace">{entry.entryNo}</span>
                    <span className="text-secondary"> | {entry.name}</span>{' '}
                    <TierBadge tier={entry.analytics?.risk?.tier} />{' '}
                    <EnrichmentStatusBadge status={entry.analytics?.enrichment?.status} />
                  </>
                ) : (
                  'Loading...'
                )}
              </h5>
              <button type="button" className="btn-close" onClick={this.props.onClose} />
            </div>

            <div className="modal-body">
              {loadError && <div className="alert alert-danger py-2">{loadError}</div>}

              {!entry ? (
                <div className="text-center py-5">
                  <div className="spinner-border text-secondary" role="status" />
                </div>
              ) : (
                <>
                  {this.#routingBanner()}

                  <div className="row g-2 small mb-3">
                    <div className="col-md-3">
                      <span className="text-secondary">Posted:</span>{' '}
                      {Format.dateTime(entry.postingDate)}
                    </div>
                    <div className="col-md-3">
                      <span className="text-secondary">Amount:</span>{' '}
                      {Format.money(entry.amount, entry.currency)}
                    </div>
                    <div className="col-md-3">
                      <span className="text-secondary">Debit / Credit:</span>{' '}
                      {Format.money(entry.debit, entry.currency)} /{' '}
                      {Format.money(entry.credit, entry.currency)}
                    </div>
                    <div className="col-md-3">
                      <span className="text-secondary">GL:</span>{' '}
                      <span className="font-monospace">{entry.glNumber}</span>
                    </div>
                    <div className="col-md-3">
                      <span className="text-secondary">Posted by:</span> {entry.postingBy}
                    </div>
                    <div className="col-md-3">
                      <span className="text-secondary">Created:</span>{' '}
                      {Format.dateTime(entry.created)}
                    </div>
                    <div className="col-md-3">
                      <span className="text-secondary">Updated:</span>{' '}
                      {Format.dateTime(entry.updated)}
                    </div>
                    <div className="col-md-3">
                      <span className="text-secondary">Pipeline:</span>{' '}
                      <span className="font-monospace">
                        {entry.analytics?.enrichment?.reason ?? '-'}
                      </span>
                      <span className="text-secondary">
                        {' '}
                        | attempts {entry.analytics?.enrichment?.attempts ?? 0}
                      </span>
                      {entry.analytics?.enrichment?.lastError && (
                        <div className="text-danger">
                          {entry.analytics.enrichment.lastError}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="row g-3">
                    <div className="col-lg-6">
                      <h6 className="border-bottom pb-1">Risk score</h6>
                      <RiskPanel risk={entry.analytics?.risk} />
                    </div>
                    <div className="col-lg-6">
                      <h6 className="border-bottom pb-1">Compliance</h6>
                      <CompliancePanel compliance={entry.analytics?.compliance} />
                    </div>

                    <div className="col-12">
                      <h6 className="border-bottom pb-1">Anomaly signals</h6>
                      <AnomalyPanel anomalies={entry.analytics?.anomalies} />
                    </div>

                    <div className="col-12">
                      <h6 className="border-bottom pb-1">
                        Multi-vector diagnostics{' '}
                        <span className="text-secondary small fw-normal">
 - stored in the separate entry_vectors collection; untouched by
                          Scenario D updates
                        </span>{' '}
                        <StaleBadge stale={this.state.vectors?.stale} />
                      </h6>
                      <VectorPanel
                        vectors={this.state.vectors}
                        vectorsStatus={this.state.vectorsStatus}
                      />
                    </div>

                    <div className="col-12">
                      <h6 className="border-bottom pb-1">Similarity search</h6>
                      <SimilarityPanel
                        entryId={entry._id}
                        apiClient={this.props.apiClient}
                        onOpenEntry={this.props.onOpenEntry}
                      />
                    </div>

                    <div className="col-lg-7">
                      <h6 className="border-bottom pb-1">
                        Edit ledger fields{' '}
                        <span className="text-secondary small fw-normal">
 - PUT /api/entries/:id, delta-routed
                        </span>
                      </h6>
                      <EditEntryForm
                        key={entry.updated}
                        entry={entry}
                        apiClient={this.props.apiClient}
                        onSaved={this.handleSaved}
                        onReloaded={this.handleReloaded}
                      />
                    </div>
                    <div className="col-lg-5">
                      <h6 className="border-bottom pb-1">
                        Audit metadata{' '}
                        <span className="text-secondary small fw-normal">- Scenario E</span>
                      </h6>
                      <AuditMetaPanel
                        key={`meta-${entry.updated}`}
                        entry={entry}
                        apiClient={this.props.apiClient}
                        onSaved={this.handleSaved}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
}
