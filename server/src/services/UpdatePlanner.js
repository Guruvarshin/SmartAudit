import {
  BALANCE_FIELDS,
  CORE_FINANCIAL_FIELDS,
  EnrichmentReason,
  EnrichmentStatus,
  FULL_RECOMPUTE_REASONS,
  UpdateScenario,
  WorkflowStatus
} from '../domain/Constants.js';
import { HttpError } from '../http/HttpError.js';

/**
 * Turns a PUT payload into an update plan: which scenario applies, what to
 * $set/$push, and whether to re-enqueue enrichment.
 *
 * Classification is diff-based, not presence-based - a field counts as changed
 * only when its value differs from the stored one, which is what makes a
 * double-clicked save free.
 *
 * The accepted field set is closed: every field maps to exactly one scenario
 * (core -> B, balance -> D, auditMeta -> E) and anything else is a 400.
 */
export class UpdatePlanner {
  static #ALLOWED_TOP_LEVEL = new Set([
    ...CORE_FINANCIAL_FIELDS,
    ...BALANCE_FIELDS,
    'auditMeta'
  ]);

  static #ALLOWED_AUDIT_META = new Set(['workflowStatus', 'comment']);

  static #DESCRIPTIONS = Object.freeze({
    [UpdateScenario.CORE_FIELD_CHANGE]:
      'core financial field changed - vectors, risk and anomalies invalidated; full recomputation queued',
    [UpdateScenario.RISK_CONTEXT_CHANGE]:
      'balance side changed - partial re-evaluation queued (risk/compliance/anomalies only, vectors untouched)',
    [UpdateScenario.METADATA_ONLY]:
      'metadata-only edit - saved atomically, asynchronous queue bypassed entirely',
    [UpdateScenario.NO_OP]: 'no effective change - nothing written, nothing queued'
  });

  plan(entry, payload) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw HttpError.badRequest('request body must be a JSON object');
    }
    this.#rejectUnknownKeys(payload);

    const changedCore = this.#diffBaseline(entry, payload, CORE_FINANCIAL_FIELDS);
    const changedBalance = this.#diffBaseline(entry, payload, BALANCE_FIELDS);
    const { auditMetaSet, commentPush, metadataChanged } = this.#planAuditMeta(entry, payload);

    const baselineSet = { ...changedCore.set, ...changedBalance.set };
    const changedFields = [
      ...changedCore.fields,
      ...changedBalance.fields,
      ...(metadataChanged ? ['auditMeta'] : [])
    ];

    const scenario = changedCore.fields.length
      ? UpdateScenario.CORE_FIELD_CHANGE
      : changedBalance.fields.length
        ? UpdateScenario.RISK_CONTEXT_CHANGE
        : metadataChanged
          ? UpdateScenario.METADATA_ONLY
          : UpdateScenario.NO_OP;

    return Object.freeze({
      scenario,
      routing: Object.freeze({
        scenario,
        action: UpdatePlanner.#DESCRIPTIONS[scenario],
        changedFields: Object.freeze(changedFields)
      }),
      baselineSet,
      auditMetaSet,
      commentPush,
      enqueue: this.#enqueueFor(scenario, entry)
    });
  }

  /**
   * A partial (D) enqueue never overwrites an in-flight full recompute: the
   * owed full run subsumes it, and downgrading would drop the vector refresh
   * the entry still needs.
   */
  #enqueueFor(scenario, entry) {
    if (scenario === UpdateScenario.CORE_FIELD_CHANGE) {
      return { reason: EnrichmentReason.CORE_FIELD_CHANGE };
    }
    if (scenario !== UpdateScenario.RISK_CONTEXT_CHANGE) return null;

    const enrichment = entry.analytics?.enrichment ?? {};
    const inFlight =
      enrichment.status === EnrichmentStatus.PENDING ||
      enrichment.status === EnrichmentStatus.PROCESSING;
    if (inFlight && FULL_RECOMPUTE_REASONS.includes(enrichment.reason)) {
      return { reason: enrichment.reason };
    }
    return { reason: EnrichmentReason.CONTEXT_SHIFT };
  }

  #rejectUnknownKeys(payload) {
    const unknown = Object.keys(payload).filter(
      (key) => !UpdatePlanner.#ALLOWED_TOP_LEVEL.has(key)
    );
    if (unknown.length > 0) {
      throw HttpError.badRequest(
        `field(s) not updatable through PUT /api/entries/:id: ${unknown.join(', ')}`,
        {
          updatable: [...UpdatePlanner.#ALLOWED_TOP_LEVEL]
        }
      );
    }
    if (payload.auditMeta !== undefined) {
      if (
        payload.auditMeta === null ||
        typeof payload.auditMeta !== 'object' ||
        Array.isArray(payload.auditMeta)
      ) {
        throw HttpError.badRequest('auditMeta must be an object');
      }
      const unknownMeta = Object.keys(payload.auditMeta).filter(
        (key) => !UpdatePlanner.#ALLOWED_AUDIT_META.has(key)
      );
      if (unknownMeta.length > 0) {
        throw HttpError.badRequest(
          `auditMeta field(s) not updatable: ${unknownMeta.join(', ')}`,
          { updatable: [...UpdatePlanner.#ALLOWED_AUDIT_META] }
        );
      }
    }
  }

  #diffBaseline(entry, payload, fieldGroup) {
    const set = {};
    const fields = [];
    for (const field of fieldGroup) {
      if (payload[field] === undefined) continue;
      const normalised = this.#normalise(field, payload[field]);
      if (!this.#equal(field, entry[field], normalised)) {
        set[field] = normalised;
        fields.push(field);
      }
    }
    return { set, fields };
  }

  #normalise(field, value) {
    if (field === 'postingDate') {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        throw HttpError.badRequest(`postingDate "${value}" is not a valid date`);
      }
      return date;
    }
    if (field === 'amount' || field === 'debit' || field === 'credit') {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) {
        throw HttpError.badRequest(`${field} must be a non-negative number, got "${value}"`);
      }
      return number;
    }
    // description / glNumber
    const text = String(value).trim();
    if (text === '') {
      throw HttpError.badRequest(`${field} must be a non-empty string`);
    }
    return text;
  }

  #equal(field, stored, normalised) {
    if (field === 'postingDate') {
      return stored instanceof Date && stored.getTime() === normalised.getTime();
    }
    return stored === normalised;
  }

  /** A comment is inherently an append, so its presence alone counts as a change. */
  #planAuditMeta(entry, payload) {
    const auditMetaSet = {};
    let commentPush = null;

    const meta = payload.auditMeta ?? {};
    if (meta.workflowStatus !== undefined) {
      const status = String(meta.workflowStatus);
      if (!Object.values(WorkflowStatus).includes(status)) {
        throw HttpError.badRequest(
          `workflowStatus "${status}" is not valid`,
          { allowed: Object.values(WorkflowStatus) }
        );
      }
      if (status !== entry.auditMeta?.workflowStatus) {
        auditMetaSet['auditMeta.workflowStatus'] = status;
      }
    }

    if (meta.comment !== undefined) {
      const comment = meta.comment;
      const author = typeof comment?.author === 'string' ? comment.author.trim() : '';
      const text = typeof comment?.text === 'string' ? comment.text.trim() : '';
      if (author === '' || text === '') {
        throw HttpError.badRequest(
          'auditMeta.comment must be an object with non-empty "author" and "text"'
        );
      }
      commentPush = { author, text, at: new Date() };
    }

    const metadataChanged = Object.keys(auditMetaSet).length > 0 || commentPush !== null;
    if (metadataChanged) {
      auditMetaSet['auditMeta.lastMetadataUpdate'] = new Date();
    }
    return { auditMetaSet, commentPush, metadataChanged };
  }
}
