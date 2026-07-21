/**
 * Reference data for generated ledgers.
 *
 * Descriptions are paired to their GL account so entries read like a real
 * chart of accounts - the semantic-anomaly cohort is only detectable as
 * anomalous relative to a plausible baseline.
 */

export const GL_ACCOUNTS = Object.freeze([
  {
    glNumber: '400120',
    label: 'Raw Materials Purchases',
    min: 25000,
    max: 450000,
    descriptions: [
      'Purchase of raw materials for production',
      'Bulk raw material procurement for assembly line',
      'Steel and alloy stock replenishment',
      'Packaging material purchase - production batch'
    ]
  },
  {
    glNumber: '401050',
    label: 'Office Supplies',
    min: 2000,
    max: 45000,
    descriptions: [
      'Office stationery and consumables',
      'Printer toner and paper restock',
      'Pantry and office supplies - monthly'
    ]
  },
  {
    glNumber: '500200',
    label: 'Professional & Consulting Fees',
    min: 50000,
    max: 900000,
    descriptions: [
      'Statutory audit fees for financial year',
      'Legal advisory retainer - contract review',
      'Management consulting engagement - phase 2',
      'Tax advisory services - quarterly filing'
    ]
  },
  {
    glNumber: '600310',
    label: 'Sales Revenue',
    min: 75000,
    max: 2500000,
    descriptions: [
      'Invoice raised for goods supplied',
      'Revenue recognised on completed milestone',
      'Export sales invoice - shipment cleared',
      'Annual maintenance contract billing'
    ]
  },
  {
    glNumber: '210040',
    label: 'Accounts Payable',
    min: 15000,
    max: 700000,
    descriptions: [
      'Vendor invoice booked against purchase order',
      'Supplier payable recognised on goods receipt',
      'Trade payable - freight invoice'
    ]
  },
  {
    glNumber: '110020',
    label: 'Cash and Bank',
    min: 10000,
    max: 1500000,
    descriptions: [
      'Bank transfer to vendor account',
      'Customer receipt credited to current account',
      'Petty cash reimbursement settlement'
    ]
  },
  {
    glNumber: '520110',
    label: 'Travel and Entertainment',
    min: 5000,
    max: 180000,
    descriptions: [
      'Business travel reimbursement - client visit',
      'Airfare and hotel for site inspection',
      'Client entertainment expense - contract signing'
    ]
  },
  {
    glNumber: '530220',
    label: 'Software Subscriptions',
    min: 8000,
    max: 320000,
    descriptions: [
      'Annual SaaS licence renewal',
      'Cloud infrastructure usage - monthly billing',
      'ERP module subscription - user seats'
    ]
  },
  {
    glNumber: '610150',
    label: 'Freight and Logistics',
    min: 12000,
    max: 400000,
    descriptions: [
      'Inbound freight charges on raw materials',
      'Outbound shipment and courier charges',
      'Customs clearance and handling fees'
    ]
  },
  {
    glNumber: '700400',
    label: 'Payroll Expense',
    min: 150000,
    max: 3200000,
    descriptions: [
      'Monthly payroll accrual - operations team',
      'Statutory bonus provision',
      'Contract staff invoice settlement'
    ]
  }
]);

export const VENDORS = Object.freeze([
  'ABC Traders Pvt Ltd',
  'Meridian Logistics LLC',
  'Nova Software Systems',
  'Kestrel Consulting Group',
  'Harbourline Freight Services',
  'Aurora Industrial Supplies',
  'Vertex Metals and Alloys',
  'Blueridge Facilities Management',
  'Sentinel Assurance Partners',
  'Orchid Stationery Co',
  'Trident Cloud Infrastructure',
  'Lakeview Staffing Solutions',
  'Ironwood Manufacturing Ltd',
  'Castellan Legal Advisors',
  'Pinnacle Export Corporation'
]);

/**
 * Descriptions that should read as uncharacteristic against the vocabulary
 * above - the intended targets of a semantic anomaly.
 */
export const SUSPICIOUS_DESCRIPTIONS = Object.freeze([
  'misc adjustment',
  'test entry do not use',
  'reversal - see email',
  'adjustment as discussed',
  'correction',
  'per management instruction',
  'temp posting will fix later',
  'balancing figure',
  'xxx',
  'manual je - no backup'
]);

export const CURRENCIES = Object.freeze(['INR', 'INR', 'INR', 'INR', 'USD', 'USD', 'EUR']);

/**
 * Hard-coded rather than generated so seeded data is stable across runs and
 * can be referenced by id.
 */
export const COMPANIES = Object.freeze([
  { _id: '6650a1f4c3d2e10000000001', name: 'Northwind Manufacturing Pvt Ltd', weight: 0.8 },
  { _id: '6650a1f4c3d2e10000000002', name: 'Southgate Exports Ltd', weight: 0.2 }
]);

export const USER_IDS = Object.freeze([
  '6650b2a5d4e3f20000000001',
  '6650b2a5d4e3f20000000002',
  '6650b2a5d4e3f20000000003',
  '6650b2a5d4e3f20000000004',
  '6650b2a5d4e3f20000000005'
]);

export const POSTING_USERS = Object.freeze([
  'user_8392',
  'user_1145',
  'user_6027',
  'user_3318',
  'user_9754',
  'system_batch'
]);

/**
 * Re-exported from the domain layer so the seed plants against the same value
 * the detector inspects, and the two cannot drift apart.
 */
export { APPROVAL_THRESHOLD } from '../domain/Constants.js';

export const Cohort = Object.freeze({
  CLEAN: 'clean',
  UNBALANCED: 'unbalanced',
  OFF_HOURS: 'off_hours',
  NUMERIC_OUTLIER: 'numeric_outlier',
  ROUNDING: 'rounding_pattern',
  SEMANTIC: 'semantic',
  NEAR_DUPLICATE: 'near_duplicate'
});

/**
 * Weighted so most of the ledger is unremarkable - a seed where a third of
 * entries are anomalous would make the risk scorer look good for the wrong
 * reason.
 */
export const COHORT_MIX = Object.freeze([
  { cohort: Cohort.CLEAN, share: 0.65 },
  { cohort: Cohort.UNBALANCED, share: 0.08 },
  { cohort: Cohort.OFF_HOURS, share: 0.08 },
  { cohort: Cohort.NUMERIC_OUTLIER, share: 0.06 },
  { cohort: Cohort.ROUNDING, share: 0.05 },
  { cohort: Cohort.SEMANTIC, share: 0.05 },
  { cohort: Cohort.NEAR_DUPLICATE, share: 0.03 }
]);

/** Fixed, to keep runs reproducible. */
export const REFERENCE_DATE = Object.freeze(new Date('2026-07-20T00:00:00.000Z'));

export const HISTORY_DAYS = 180;
