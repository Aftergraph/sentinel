// Central rule-pack registry — single source of truth for rule IDs,
// severities, pack versions, and blocking semantics.
// v1.0.0 = original 6-rule pack (precision-audited, locks determinism).
// v1.1.0 = v1.0.0 + 14 high-precision deterministic additions (no AST,
//          no absence-detection, no entropy scanners — per precision-audit lessons).
// v1.2.0 = v1.1.0 + no-destructive-migration-without-backup-verification
//          (upstream rule, precision-audit gap #13 verified: SQL-path scoped,
//          destructive keyword, backup-reference escape hatch).
// v1.3.0 = v1.2.0 + require-retry-with-backoff-for-transient-failures
//          (precision-audit gap #8: single-line .catch() re-invocation with
//          no delay primitive on the line; delay-token escape hatch).
// Excluded by design: no-swallowed-exceptions-in-critical-path ships in-tree
// (module + fixtures tested) but is NOT in any pack — the name promises
// critical-path scoping the regex cannot deliver (fires on every empty
// catch in any JS/TS file), i.e. precision-audit CUT gap #7. Promote it
// only with real path-criticality context.
// Also NOT in any pack (gap-list rules, no presence-signal formulation):
// no-single-point-of-failure-in-deployment (#9) and
// require-health-check-before-traffic-shift (#10) are absence checks
// (missing canary/probe) a diff regex cannot prove;
// require-backward-compatible-schema-changes (#12),
// require-foreign-key-constraints-on-related-tables (#14), and
// require-index-for-where-clause-columns (#19) need schema/ORM context.
// Entry criteria: manifest-aware (k8s/Dockerfile) or schema-aware checks.

export const RULE_PACK_VERSION = '1.3.0';

export const SUPPORTED_PACKS = ['1.0.0', '1.1.0', '1.2.0', '1.3.0'];

const V1_0_IDS = [
  'no-unauthenticated-api-endpoints',
  'no-secrets-in-cicd-config',
  'require-transaction-rollback-on-failure',
  'no-unindexed-schema-migration-on-large-tables',
  'no-n-plus-one-queries-in-api-resolvers',
  'require-dataloader-or-eager-load-for-nested-fetches',
];

// Additions in v1.1.0 — every rule is a pure function of the unified diff,
// scoped to narrow file types + binary-signal keywords. Absence checks,
// concurrency-model checks, and generic secret scanners are excluded by
// design (see prototype/precision-audit.md CUT list).
const V1_1_ADDITIONS = [
  'no-eval-with-dynamic-input',
  'no-disabled-tls-verification',
  'no-private-key-in-diff',
  'no-unpinned-github-action-ref',
  'no-process-exit-in-server-code',
  'no-hardcoded-localhost-url-in-diff',
  'require-lockfile-update-with-manifest-change',
  'no-destructive-sql-without-guard',
  'require-where-on-delete-update',
  'no-unbounded-list-query-without-pagination',
  'no-sync-io-in-route-handler',
  'require-strict-equality',
  'no-var-instead-of-let-const',
  'no-console-log-in-server-diff',
];

const V1_2_ADDITIONS = [
  'no-destructive-migration-without-backup-verification',
];

const V1_3_ADDITIONS = [
  'require-retry-with-backoff-for-transient-failures',
];

export const RULE_IDS_BY_PACK = {
  '1.0.0': V1_0_IDS,
  '1.1.0': [...V1_0_IDS, ...V1_1_ADDITIONS],
  '1.2.0': [...V1_0_IDS, ...V1_1_ADDITIONS, ...V1_2_ADDITIONS],
  '1.3.0': [...V1_0_IDS, ...V1_1_ADDITIONS, ...V1_2_ADDITIONS, ...V1_3_ADDITIONS],
};

export const SEVERITY_MAP = {
  // v1.0.0
  'no-unauthenticated-api-endpoints': 'security',
  'no-secrets-in-cicd-config': 'security',
  'require-transaction-rollback-on-failure': 'reliability',
  'no-unindexed-schema-migration-on-large-tables': 'data',
  'no-n-plus-one-queries-in-api-resolvers': 'performance',
  'require-dataloader-or-eager-load-for-nested-fetches': 'performance',
  // v1.1.0 additions
  'no-eval-with-dynamic-input': 'security',
  'no-disabled-tls-verification': 'security',
  'no-private-key-in-diff': 'security',
  'no-unpinned-github-action-ref': 'security',
  'no-process-exit-in-server-code': 'reliability',
  'no-hardcoded-localhost-url-in-diff': 'reliability',
  'require-lockfile-update-with-manifest-change': 'reliability',
  'no-destructive-sql-without-guard': 'data',
  'require-where-on-delete-update': 'data',
  'no-unbounded-list-query-without-pagination': 'performance',
  'no-sync-io-in-route-handler': 'performance',
  'require-strict-equality': 'correctness',
  'no-var-instead-of-let-const': 'style',
  'no-console-log-in-server-diff': 'style',
  // v1.2.0 addition
  'no-destructive-migration-without-backup-verification': 'data',
  // v1.3.0 addition
  'require-retry-with-backoff-for-transient-failures': 'reliability',
};

// Style findings are reported but never block a verdict (cli-v0-design §6).
export const BLOCKING_SEVERITIES = new Set([
  'security',
  'reliability',
  'correctness',
  'data',
  'performance',
]);

export function ruleIdsForPack(version = RULE_PACK_VERSION) {
  const ids = RULE_IDS_BY_PACK[version];
  if (!ids) throw new Error(`Unsupported rule pack: ${version} (supported: ${SUPPORTED_PACKS.join(', ')})`);
  return ids;
}
