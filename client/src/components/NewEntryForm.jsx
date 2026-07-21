import React from 'react';
import { ApiError } from '../api/ApiClient.js';

/** Blank form values; company/user identity is inherited from the template entry. */
function emptyDraft() {
  return {
    postingDate: new Date().toISOString().slice(0, 16),
    entryNo: `JE-${Date.now().toString().slice(-6)}`,
    name: '',
    description: '',
    amount: '',
    debit: '',
    credit: '',
    currency: 'INR',
    glNumber: '',
    postingBy: ''
  };
}

/**
 * Scenario A's front door: POST /api/entries. The response lands in the list
 * immediately at enrichment.status 'pending', and the dashboard's fast poll
 * then shows the worker claim → complete transition live.
 *
 * Save guard: the submit button disables while the request is in flight —
 * the same double-click discipline as the modal's edit form.
 */
export class NewEntryForm extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      open: false,
      draft: emptyDraft(),
      submitting: false,
      error: null
    };
    this.handleToggle = this.handleToggle.bind(this);
    this.handleField = this.handleField.bind(this);
    this.handleSubmit = this.handleSubmit.bind(this);
    this.handleFillRisky = this.handleFillRisky.bind(this);
  }

  handleToggle() {
    this.setState((state) => ({ open: !state.open, error: null }));
  }

  handleField(event) {
    const { name, value } = event.target;
    this.setState((state) => ({ draft: { ...state.draft, [name]: value } }));
  }

  /**
   * Pre-fills the spec's canonical high-risk shape: unbalanced sides, posted
   * 02:00 on a Sunday, vague description, amount just under the approval
   * threshold — every risk factor at once, for the demo.
   */
  handleFillRisky() {
    const sunday = new Date();
    sunday.setDate(sunday.getDate() - ((sunday.getDay() + 7) % 7 || 7));
    sunday.setHours(2, 0, 0, 0);
    this.setState((state) => ({
      draft: {
        ...state.draft,
        postingDate: `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}T02:00`,
        name: 'Misc Vendor',
        description: 'misc adjustment',
        amount: '99500',
        debit: '99500',
        credit: '1500',
        glNumber: '400120',
        postingBy: 'user_ui'
      }
    }));
  }

  async handleSubmit(event) {
    event.preventDefault();
    if (this.state.submitting) return; // double-click guard
    const template = this.props.template;
    if (!template) {
      this.setState({ error: 'No existing entry to inherit company/user identity from — seed the database first.' });
      return;
    }

    const { draft } = this.state;
    this.setState({ submitting: true, error: null });
    try {
      const entry = await this.props.apiClient.createEntry({
        postingDate: new Date(draft.postingDate).toISOString(),
        transactionType: 'Journal Entry',
        entryNo: draft.entryNo.trim(),
        name: draft.name.trim(),
        description: draft.description.trim(),
        amount: Number(draft.amount),
        debit: Number(draft.debit || 0),
        credit: Number(draft.credit || 0),
        currency: draft.currency.trim().toUpperCase(),
        glNumber: draft.glNumber.trim(),
        postingBy: draft.postingBy.trim(),
        companyId: template.companyId,
        userId: template.userId,
        sourceId: 'ui_manual',
        uploadId: 'ui_manual',
        systemCreated: false,
        uploadSourceType: 1
      });
      this.setState({ draft: emptyDraft(), submitting: false, open: false });
      this.props.onCreated(entry);
    } catch (error) {
      const detail =
        error instanceof ApiError && error.details
          ? ` (${Object.entries(error.details)
              .map(([field, message]) => `${field}: ${message}`)
              .join('; ')})`
          : '';
      this.setState({ submitting: false, error: `${error.message}${detail}` });
    }
  }

  render() {
    const { open, draft, submitting, error } = this.state;

    return (
      <div className="card mb-3">
        <div className="card-header d-flex align-items-center py-2">
          <span className="fw-semibold">New journal entry</span>
          <span className="small text-secondary ms-2">
            POST /api/entries — enriched asynchronously by the worker (Scenario A)
          </span>
          <button
            type="button"
            className="btn btn-sm btn-outline-primary ms-auto"
            onClick={this.handleToggle}
          >
            {open ? 'Close' : 'Create entry'}
          </button>
        </div>

        {open && (
          <form className="card-body" onSubmit={this.handleSubmit}>
            <div className="row g-2">
              <div className="col-md-3">
                <label className="form-label small mb-0">Posting date</label>
                <input
                  type="datetime-local"
                  className="form-control form-control-sm"
                  name="postingDate"
                  value={draft.postingDate}
                  onChange={this.handleField}
                  required
                />
              </div>
              <div className="col-md-2">
                <label className="form-label small mb-0">Entry №</label>
                <input
                  className="form-control form-control-sm"
                  name="entryNo"
                  value={draft.entryNo}
                  onChange={this.handleField}
                  required
                />
              </div>
              <div className="col-md-3">
                <label className="form-label small mb-0">Name</label>
                <input
                  className="form-control form-control-sm"
                  name="name"
                  value={draft.name}
                  onChange={this.handleField}
                  required
                />
              </div>
              <div className="col-md-4">
                <label className="form-label small mb-0">Description</label>
                <input
                  className="form-control form-control-sm"
                  name="description"
                  value={draft.description}
                  onChange={this.handleField}
                  required
                />
              </div>
              <div className="col-md-2">
                <label className="form-label small mb-0">Amount</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  className="form-control form-control-sm"
                  name="amount"
                  value={draft.amount}
                  onChange={this.handleField}
                  required
                />
              </div>
              <div className="col-md-2">
                <label className="form-label small mb-0">Debit</label>
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
              <div className="col-md-2">
                <label className="form-label small mb-0">Credit</label>
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
              <div className="col-md-1">
                <label className="form-label small mb-0">Currency</label>
                <input
                  className="form-control form-control-sm"
                  name="currency"
                  value={draft.currency}
                  onChange={this.handleField}
                  maxLength={3}
                  required
                />
              </div>
              <div className="col-md-2">
                <label className="form-label small mb-0">GL number</label>
                <input
                  className="form-control form-control-sm"
                  name="glNumber"
                  value={draft.glNumber}
                  onChange={this.handleField}
                  required
                />
              </div>
              <div className="col-md-3">
                <label className="form-label small mb-0">Posted by</label>
                <input
                  className="form-control form-control-sm"
                  name="postingBy"
                  value={draft.postingBy}
                  onChange={this.handleField}
                  required
                />
              </div>
            </div>

            {error && <div className="alert alert-danger py-1 px-2 small mt-2 mb-0">{error}</div>}

            <div className="d-flex gap-2 mt-3">
              <button type="submit" className="btn btn-sm btn-primary" disabled={submitting}>
                {submitting && <span className="spinner-border spinner-border-sm me-1" />}
                {submitting ? 'Creating…' : 'Create entry'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-danger"
                onClick={this.handleFillRisky}
                disabled={submitting}
              >
                Fill spec&apos;s high-risk example
              </button>
              <span className="small text-secondary align-self-center">
                Company/user identity inherited from the listed ledger.
              </span>
            </div>
          </form>
        )}
      </div>
    );
  }
}
