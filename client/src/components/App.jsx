import React from 'react';
import { ApiClient } from '../api/ApiClient.js';
import { AuditDashboard } from './AuditDashboard.jsx';

/**
 * Application shell: navbar, top-level error boundary, and the single
 * ApiClient instance the whole tree shares.
 */
export class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = { crashed: null };
    this.apiClient = new ApiClient();
  }

  componentDidCatch(error) {
    this.setState({ crashed: error });
  }

  render() {
    return (
      <div className="min-vh-100 bg-light">
        <nav className="navbar navbar-dark bg-dark px-3 mb-3">
          <span className="navbar-brand fw-semibold">
            SmartAudit <span className="text-secondary">· Audit Command Center</span>
          </span>
        </nav>
        <main className="container-fluid px-4 pb-5">
          {this.state.crashed ? (
            <div className="alert alert-danger">
              The dashboard crashed: {String(this.state.crashed?.message ?? this.state.crashed)}.
              Reload the page to recover.
            </div>
          ) : (
            <AuditDashboard apiClient={this.apiClient} />
          )}
        </main>
      </div>
    );
  }
}
