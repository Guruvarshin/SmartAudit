import React from 'react';
import { WORKFLOW_STATUSES } from '../../domain/constants.js';
import { Format } from '../../util/Format.js';
import { WorkflowBadge } from '../Badges.jsx';

/**
 * Scenario E's surface: workflow status + append-only auditor comments.
 * Saved through the same PUT, but the backend routes it synchronously —
 * no queue, no worker, and the response's routing block proves it ('E').
 */
export class AuditMetaPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      workflowStatus: props.entry.auditMeta?.workflowStatus ?? 'unreviewed',
      commentAuthor: '',
      commentText: '',
      saving: false,
      error: null
    };
    this.handleStatus = this.handleStatus.bind(this);
    this.handleAuthor = this.handleAuthor.bind(this);
    this.handleText = this.handleText.bind(this);
    this.handleSubmit = this.handleSubmit.bind(this);
  }

  handleStatus(event) {
    this.setState({ workflowStatus: event.target.value });
  }

  handleAuthor(event) {
    this.setState({ commentAuthor: event.target.value });
  }

  handleText(event) {
    this.setState({ commentText: event.target.value });
  }

  #buildAuditMeta() {
    const { entry } = this.props;
    const { workflowStatus, commentAuthor, commentText } = this.state;
    const auditMeta = {};
    if (workflowStatus !== (entry.auditMeta?.workflowStatus ?? 'unreviewed')) {
      auditMeta.workflowStatus = workflowStatus;
    }
    if (commentText.trim()) {
      auditMeta.comment = { author: commentAuthor.trim(), text: commentText.trim() };
    }
    return auditMeta;
  }

  async handleSubmit(event) {
    event.preventDefault();
    if (this.state.saving) return; // double-click guard

    const auditMeta = this.#buildAuditMeta();
    if (Object.keys(auditMeta).length === 0) return;
    if (auditMeta.comment && !auditMeta.comment.author) {
      this.setState({ error: 'A comment needs an author.' });
      return;
    }

    this.setState({ saving: true, error: null });
    try {
      const { routing, entry } = await this.props.apiClient.updateEntry(this.props.entry._id, {
        auditMeta
      });
      this.setState({ saving: false, commentText: '' });
      this.props.onSaved(routing, entry);
    } catch (error) {
      this.setState({ saving: false, error: error.message });
    }
  }

  render() {
    const { entry } = this.props;
    const { workflowStatus, commentAuthor, commentText, saving, error } = this.state;
    const comments = entry.auditMeta?.comments ?? [];
    const changes = this.#buildAuditMeta();

    return (
      <div>
        <form onSubmit={this.handleSubmit}>
          <div className="d-flex align-items-center gap-2 mb-2">
            <label className="small text-secondary mb-0">Workflow</label>
            <select
              className="form-select form-select-sm w-auto"
              value={workflowStatus}
              onChange={this.handleStatus}
            >
              {WORKFLOW_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.replace('_', ' ')}
                </option>
              ))}
            </select>
            <WorkflowBadge status={entry.auditMeta?.workflowStatus} />
          </div>

          <div className="row g-2">
            <div className="col-4">
              <input
                className="form-control form-control-sm"
                placeholder="Author"
                value={commentAuthor}
                onChange={this.handleAuthor}
              />
            </div>
            <div className="col-8">
              <input
                className="form-control form-control-sm"
                placeholder="Append an audit comment…"
                value={commentText}
                onChange={this.handleText}
              />
            </div>
          </div>

          {error && <div className="alert alert-danger py-1 px-2 small mt-2 mb-0">{error}</div>}

          <button
            type="submit"
            className="btn btn-sm btn-outline-primary mt-2"
            disabled={saving || Object.keys(changes).length === 0}
          >
            {saving && <span className="spinner-border spinner-border-sm me-1" />}
            {saving ? 'Saving…' : 'Save metadata (Scenario E — synchronous)'}
          </button>
        </form>

        {comments.length > 0 && (
          <ul className="list-group list-group-flush mt-2 small">
            {comments
              .slice()
              .reverse()
              .map((comment, index) => (
                <li className="list-group-item px-0 py-1" key={`${comment.at}-${index}`}>
                  <span className="fw-semibold">{comment.author}</span>
                  <span className="text-secondary"> · {Format.dateTime(comment.at)}</span>
                  <div>{comment.text}</div>
                </li>
              ))}
          </ul>
        )}
        {entry.auditMeta?.lastMetadataUpdate && (
          <div className="text-secondary small mt-1">
            last metadata update: {Format.dateTime(entry.auditMeta.lastMetadataUpdate)}
          </div>
        )}
      </div>
    );
  }
}
