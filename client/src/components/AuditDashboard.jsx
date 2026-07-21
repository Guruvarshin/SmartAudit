import React from 'react';
import { POLL_ACTIVE_MS, POLL_IDLE_MS, isInFlight } from '../domain/constants.js';
import { DiagnosticsModal } from './DiagnosticsModal.jsx';
import { EntryFilters } from './EntryFilters.jsx';
import { EntryTable } from './EntryTable.jsx';
import { NewEntryForm } from './NewEntryForm.jsx';
import { SummaryBar } from './SummaryBar.jsx';

/**
 * Owns the entry list and the polling loop that keeps it current while the
 * worker enriches asynchronously.
 *
 * The queue state is `analytics.enrichment.status` on the entry itself, so
 * re-fetching the list is reading the queue - there is no separate job API. A
 * setTimeout chain rather than setInterval, so a slow response can never
 * overlap the next tick; it re-arms fast while anything is in flight and
 * slowly once everything is settled.
 */
export class AuditDashboard extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      entries: null, // null = first load not yet resolved
      loadError: null,
      tier: '',
      status: '',
      selectedEntryId: null,
      lastRefreshedAt: null
    };
    this.pollTimer = null;
    this.unmounted = false;
    this.fetchInFlight = false;

    this.handleFilterChange = this.handleFilterChange.bind(this);
    this.handleRefreshClick = this.handleRefreshClick.bind(this);
    this.handleEntryCreated = this.handleEntryCreated.bind(this);
    this.handleEntryChanged = this.handleEntryChanged.bind(this);
    this.handleOpenEntry = this.handleOpenEntry.bind(this);
    this.handleCloseModal = this.handleCloseModal.bind(this);
  }

  componentDidMount() {
    this.refresh();
  }

  componentWillUnmount() {
    this.unmounted = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevState.tier !== this.state.tier || prevState.status !== this.state.status) {
      this.refresh();
    }
  }

  async refresh() {
    if (this.fetchInFlight || this.unmounted) return;
    this.fetchInFlight = true;
    // Scheduling uses this local, not this.state: setState is asynchronous
    // and would lag one commit behind the fetch just completed.
    let latest = this.state.entries;
    try {
      const entries = await this.props.apiClient.listEntries({
        tier: this.state.tier || null,
        status: this.state.status || null
      });
      if (!this.unmounted) {
        latest = entries;
        this.setState({ entries, loadError: null, lastRefreshedAt: new Date() });
      }
    } catch (error) {
      if (!this.unmounted) this.setState({ loadError: error.message });
    } finally {
      this.fetchInFlight = false;
      this.#scheduleNextPoll(latest);
    }
  }

  #scheduleNextPoll(entries = this.state.entries) {
    if (this.unmounted) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const anyInFlight = (entries ?? []).some(isInFlight);
    const delay = anyInFlight ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    this.pollTimer = setTimeout(() => this.refresh(), delay);
  }

  handleFilterChange({ tier, status }) {
    this.setState({ tier, status });
  }

  handleRefreshClick() {
    this.refresh();
  }

  /** A new entry is born 'pending', so surface it and tighten the poll. */
  handleEntryCreated(entry) {
    this.setState(
      (state) => ({ entries: [entry, ...(state.entries ?? [])] }),
      () => this.#scheduleNextPoll()
    );
  }

  /** Merges an entry mutated in the modal so the table updates immediately. */
  handleEntryChanged(entry) {
    this.setState(
      (state) => ({
        entries: (state.entries ?? []).map((existing) =>
          existing._id === entry._id ? entry : existing
        )
      }),
      () => this.#scheduleNextPoll()
    );
  }

  handleOpenEntry(entryId) {
    this.setState({ selectedEntryId: entryId });
  }

  handleCloseModal() {
    this.setState({ selectedEntryId: null });
  }

  render() {
    const { entries, loadError, tier, status, selectedEntryId, lastRefreshedAt } = this.state;
    const anyInFlight = (entries ?? []).some(isInFlight);

    return (
      <div>
        <SummaryBar entries={entries ?? []} />

        <NewEntryForm
          apiClient={this.props.apiClient}
          template={(entries ?? [])[0] ?? null}
          onCreated={this.handleEntryCreated}
        />

        <EntryFilters
          tier={tier}
          status={status}
          polling={anyInFlight}
          lastRefreshedAt={lastRefreshedAt}
          onChange={this.handleFilterChange}
          onRefresh={this.handleRefreshClick}
        />

        {loadError && (
          <div className="alert alert-danger py-2">
            Could not load entries: {loadError} - retrying automatically.
          </div>
        )}

        {entries === null ? (
          <div className="text-center py-5">
            <div className="spinner-border text-secondary" role="status" />
            <div className="mt-2 text-secondary">Loading ledger...</div>
          </div>
        ) : (
          <EntryTable entries={entries} onOpenEntry={this.handleOpenEntry} />
        )}

        {selectedEntryId && (
          <DiagnosticsModal
            key={selectedEntryId}
            entryId={selectedEntryId}
            apiClient={this.props.apiClient}
            onClose={this.handleCloseModal}
            onEntryChanged={this.handleEntryChanged}
            onOpenEntry={this.handleOpenEntry}
          />
        )}
      </div>
    );
  }
}
