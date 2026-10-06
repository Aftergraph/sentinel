import { createHash } from 'node:crypto';
import { createCapabilityAttestationStore } from './capability-attestation-store.js';

const LENOVO_SCHEMA = 'AftergraphLenovoPlacementCapabilityAcceptance/v1';
const LENOVO_NODE = 'wrkr_jonas_lenovo';
const LENOVO_POOL = 'jonas-lenovo';
const LENOVO_CAPABILITIES = Object.freeze([
  'computer',
  'local.desktop',
  'local.device',
]);

const LENOVO_KEYS = Object.freeze([
  'schema',
  'machine',
  'runner_name',
  'github_run_id',
  'github_sha',
  'observed_at_utc',
  'worker_id',
  'pool',
  'physical_host',
  'computer_node_task_running',
  'works_worker_task_running',
  'interactive_session_present',
  'explorer_running',
  'dwm_running',
  'healthy_monitor_count',
].sort());

const DEFAULT_FRESHNESS_TTL_MS = 5 * 60 * 1000;
const MAX_FRESHNESS_TTL_MS = 60 * 60 * 1000;

function exactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function iso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function deterministicAttestationId(schema, nodeId, capability) {
  const digest = createHash('sha256')
    .update([schema, nodeId, capability].join('\0'))
    .digest('hex')
    .slice(0, 32);
  return 'capatt_' + digest;
}

function validateOptions({ verifiedAt, freshnessTtlMs }) {
  if (!iso(verifiedAt)) {
    throw new Error('capability receipt verification time is invalid');
  }
  if (
    !Number.isInteger(freshnessTtlMs) ||
    freshnessTtlMs <= 0 ||
    freshnessTtlMs > MAX_FRESHNESS_TTL_MS
  ) {
    throw new Error('capability receipt freshness TTL is invalid');
  }
}

function lenovoAttestations(receipt, options) {
  if (!exactKeys(receipt, LENOVO_KEYS)) {
    throw new Error('Lenovo placement capability receipt shape is invalid');
  }
  if (
    receipt.schema !== LENOVO_SCHEMA ||
    receipt.machine !== 'JONAS-LENOVO' ||
    !nonEmpty(receipt.runner_name) ||
    !/^\d+$/u.test(String(receipt.github_run_id ?? '')) ||
    !/^[a-f0-9]{40}$/u.test(String(receipt.github_sha ?? '')) ||
    !iso(receipt.observed_at_utc) ||
    receipt.worker_id !== LENOVO_NODE ||
    receipt.pool !== LENOVO_POOL ||
    receipt.physical_host !== 'PASS' ||
    receipt.computer_node_task_running !== true ||
    receipt.works_worker_task_running !== true ||
    receipt.interactive_session_present !== true ||
    receipt.explorer_running !== true ||
    receipt.dwm_running !== true ||
    !Number.isInteger(receipt.healthy_monitor_count) ||
    receipt.healthy_monitor_count < 1
  ) {
    throw new Error('Lenovo placement capability receipt did not prove required fields');
  }

  if (Date.parse(options.verifiedAt) < Date.parse(receipt.observed_at_utc)) {
    throw new Error('capability receipt verification predates observation');
  }

  return LENOVO_CAPABILITIES.map((capability) =>
    Object.freeze({
      id: deterministicAttestationId(LENOVO_SCHEMA, LENOVO_NODE, capability),
      nodeId: LENOVO_NODE,
      capability,
      state: 'AVAILABLE',
      observedAt: receipt.observed_at_utc,
      verifiedAt: options.verifiedAt,
      freshnessTtlMs: options.freshnessTtlMs,
      source: 'sentinel:receipt:' + LENOVO_SCHEMA,
    }),
  );
}

/**
 * Translate a typed, independently-produced probe receipt into the exact
 * runtime-fabric attestations that its schema is allowed to prove.
 *
 * Callers cannot supply or widen semantic capabilities. Unknown schemas and
 * receipts with extra fields fail closed.
 */
export function attestationsFromCapabilityReceipt(
  receipt,
  {
    verifiedAt = new Date().toISOString(),
    freshnessTtlMs = DEFAULT_FRESHNESS_TTL_MS,
  } = {},
) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('capability receipt must be an object');
  }
  validateOptions({ verifiedAt, freshnessTtlMs });

  if (receipt.schema === LENOVO_SCHEMA) {
    return lenovoAttestations(receipt, { verifiedAt, freshnessTtlMs });
  }

  throw new Error('unsupported capability receipt schema');
}

export function ingestCapabilityReceipt({
  receipt,
  storePath,
  verifiedAt = new Date().toISOString(),
  freshnessTtlMs = DEFAULT_FRESHNESS_TTL_MS,
}) {
  const attestations = attestationsFromCapabilityReceipt(receipt, {
    verifiedAt,
    freshnessTtlMs,
  });
  const store = createCapabilityAttestationStore(storePath);
  return attestations.map((attestation) => store.put(attestation));
}

export const capabilityReceiptSchemas = Object.freeze({
  lenovoPlacement: LENOVO_SCHEMA,
});

export const capabilityReceiptDefaults = Object.freeze({
  freshnessTtlMs: DEFAULT_FRESHNESS_TTL_MS,
  maxFreshnessTtlMs: MAX_FRESHNESS_TTL_MS,
});
