import React from 'react';
import { ApiError } from '../../api/ApiClient.js';

/** ISO date -> datetime-local string, for editing and dirty comparison. */
function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function draftFromEntry(entry) {
  return {
    amount: String(entry.amount ?? ''),
    description: entry.description ?? '',
    glNumber: entry.glNumber ?? '',
    postingDate: toLocalInput(entry.postingDate),
    debit: String(entry.debit ?? ''),
    credit: String(entry.credit ?? '')
  };
}

/**
 * Built around the backend's concurrency contract rather than around optimism:
 *
 * - Sends only changed keys, matching the planner's diff-based classification
 *   and keeping routing.changedFields meaningful.
 * - Disables while saving. This is UX suppression only - a click that slips
 *   through is harmless, because the backend diffs a re-send to a no-op.
 * - Treats 409 as reload, never blind retry: the server is the arbiter, so we
 *   refetch and let the auditor consciously re-apply.
 */
export class EditEntryForm extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      draft: draftFromEntry(props.entry),
      saving: false,
      error: null,
      conflictNotice: false
    };
    this.handleField = this.handleField.bind(this);
    this.handleReset = this.handleReset.bind(this);
    this.handleSubmit = this.handleSubmit.bind(this);
  }

  handleField(event) {
    const { name, value } = event.target;
    this.setState((state) => ({ draft: { ...state.draft, [name]: value }, error: null }));
  }

  handleReset() {
    this.setState({ draft: draftFromEntry(this.props.entry), error: null, conflictNotice: false });
  }

  /** Only keys whose value actually differs from the stored entry. */
  #dirtyChanges() {
    const { entry } = this.props;
    const { draft } = this.state;
    const changes = {};

    if (Number(draft.amount) !== entry.amount) changes.amount = Number(draft.amount);
    if (draft.description.trim() !== entry.description) {
      changes.description = draft.description.trim();
    }
    if (draft.glNumber.trim() !== entry.glNumber) changes.glNumber = draft.glNumber.trim();
    if (draft.postingDate && draft.postingDate !== toLocalInput(entry.postingDate)) {
      changes.postingDate = new Date(draft.postingDate).toISOString();
    }
    if (Number(draft.debit) !== entry.debit) changes.debit = Number(draft.debit);
    if (Number(draft.credit) !== entry.credit) changes.credit = Number(draft.credit);

    return changes;
  }

  async handleSubmit(event) {
    event.preventDefault();
    if (this.state.saving) return; // double-click guard (backend no_op/coalescing backstops this)

    const changes = this.#dirtyChanges();
    if (Object.keys(changes).length === 0) return;

    this.setState({ saving: true, error: null, conflictNotice: false });
    try {
      const { routing, entry } = await this.props.apiClient.updateEntry(
        this.props.entry._id,
        changes
      );
      this.setState({ saving: false, draft: draftFromEntry(entry) });
      this.props.onSaved(routing, entry);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Reload server truth and let the user re-apply.
        try {
          const fresh = await this.props.apiClient.getEntry(this.props.entry._id);
          this.setState({
            saving: false,
            conflictNotice: true,
            draft: draftFromEntry(fresh)
          });
          this.props.onReloaded(fresh);
        } catch (reloadError) {
          this.setState({ saving: false, error: reloadError.message });
        }
        return;
      }
      this.setState({ saving: false, error: error.message });
    }
  }

  render() {
    const { draft, saving, error, conflictNotice } = this.state;
    const dirtyCount = Object.keys(this.#dirtyChanges()).length;

    return (
      <form onSubmit={this.handleSubmit}>
        <div className="row g-2">
          <div className="col-6">
            <label className="form-label small mb-0">
              Amount <span className="badge text-bg-light border">B</span>
            </label>
            <input
              type="number"
              min="0"
              step="any"
              className="form-control form-control-sm"
              name="amount"
              value={draft.amount}
              onChange={this.handleField}
            />
          </div>
          <div className="col-6">
            <label className="form-label small mb-0">
              Posting date <span className="badge text-bg-light border">B</span>
            </label>
            <input
              type="datetime-local"
              className="form-control form-control-sm"
              name="postingDate"
              value={draft.postingDate}
              onChange={this.handleField}
            />
          </div>
          <div className="col-12">
            <label className="form-label small mb-0">
              Description <span className="badge text-bg-light border">B</span>
            </label>
            <input
              className="form-control form-control-sm"
              name="description"
              value={draft.description}
              onChange={this.handleField}
            />
          </div>
          <div className="col-4">
            <label className="form-label small mb-0">
              GL number <span className="badge text-bg-light border">B</span>
            </label>
            <input
              className="form-control form-control-sm"
              name="glNumber"
              value={draft.glNumber}
              onChange={this.handleField}
            />
          </div>
          <div className="col-4">
            <label className="form-label small mb-0">
              Debit <span className="badge text-bg-light border">D</span>
            </label>
            <input
              type="number"
              min="0"
              step="any"
              className="form-control form-control-sm"
              name="debit"
              value={draft.debit}
              onChange={this.handleField}
            />
          </div>
          <div className="col-4">
            <label className="form-label small mb-0">
              Credit <span className="badge text-bg-light border">D</span>
            </label>
            <input
              type="number"
              min="0"
              step="any"
              className="form-control form-control-sm"
              name="credit"
              value={draft.credit}
              onChange={this.handleField}
            />
          </div>
        </div>

        {conflictNotice && (
          <div className="alert alert-warning py-1 px-2 small mt-2 mb-0">
            This entry changed on the server while you were editing - the form has been reloaded
            with the latest values. Re-apply your change if it still makes sense.
          </div>
        )}
        {error && <div className="alert alert-danger py-1 px-2 small mt-2 mb-0">{error}</div>}

        <div className="d-flex align-items-center gap-2 mt-2">
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={saving || dirtyCount === 0}
          >
            {saving && <span className="spinner-border spinner-border-sm me-1" />}
            {saving ? 'Saving...' : `Save ${dirtyCount > 0 ? `${dirtyCount} change${dirtyCount > 1 ? 's' : ''}` : ''}`}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={this.handleReset}
            disabled={saving || dirtyCount === 0}
          >
            Reset
          </button>
          <span className="small text-secondary">
            B fields -> full recompute | D fields -> risk-only re-evaluation (vectors untouched)
          </span>
        </div>
      </form>
    );
  }
}
