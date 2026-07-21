/** Mirror of the server's domain vocabulary, plus presentation maps. */

export const RISK_TIERS = Object.freeze(['low', 'medium', 'high']);

export const ENRICHMENT_STATUSES = Object.freeze([
  'pending',
  'processing',
  'complete',
  'failed'
]);

export const VECTOR_STRATEGIES = Object.freeze(['semantic', 'financial', 'entity']);

export const WORKFLOW_STATUSES = Object.freeze([
  'unreviewed',
  'in_review',
  'cleared',
  'escalated'
]);

export const TIER_ROW_CLASS = Object.freeze({
  high: 'table-danger',
  medium: 'table-warning',
  low: 'table-success'
});

export const TIER_BADGE_CLASS = Object.freeze({
  high: 'text-bg-danger',
  medium: 'text-bg-warning',
  low: 'text-bg-success'
});

export const STATUS_BADGE_CLASS = Object.freeze({
  pending: 'text-bg-secondary',
  processing: 'text-bg-info',
  complete: 'text-bg-success',
  failed: 'text-bg-danger'
});

export const SEVERITY_BADGE_CLASS = Object.freeze({
  info: 'text-bg-secondary',
  warning: 'text-bg-warning',
  critical: 'text-bg-danger'
});

export const COMPLIANCE_BADGE_CLASS = Object.freeze({
  pass: 'text-bg-success',
  review: 'text-bg-warning',
  fail: 'text-bg-danger'
});

export const WORKFLOW_BADGE_CLASS = Object.freeze({
  unreviewed: 'text-bg-secondary',
  in_review: 'text-bg-info',
  cleared: 'text-bg-success',
  escalated: 'text-bg-danger'
});

/** Fast while a worker is expected to move something, slow once settled. */
export const POLL_ACTIVE_MS = 2000;
export const POLL_IDLE_MS = 10000;

export function isInFlight(entry) {
  const status = entry?.analytics?.enrichment?.status;
  return status === 'pending' || status === 'processing';
}
