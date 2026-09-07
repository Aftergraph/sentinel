# SentinelBench report — pack `1.6.0`

- cases: 26
- recall: 1
- precision: 1
- false positives per case: 0
- held-out: 2 cases (excluded from main score)

| case | hit | strict | fired | expected |
|---|---|---|---|---|
| clean-eval-negative | yes | yes | — | — |
| clean-findings-prop-negative | yes | yes | — | — |
| clean-optional-chaining-negative | yes | yes | — | — |
| clean-params-get-negative | yes | yes | — | — |
| clean-secrets-cicd-negative | yes | yes | — | — |
| clean-strict-equality-negative | yes | yes | — | — |
| clean-sync-io-negative | yes | yes | — | — |
| correctness-strict-equality | yes | yes | require-strict-equality | require-strict-equality |
| data-destructive-sql | yes | yes | no-destructive-migration-without-backup-verification, no-destructive-sql-without-guard | no-destructive-migration-without-backup-verification, no-destructive-sql-without-guard |
| data-foreign-key | yes | yes | no-unindexed-schema-migration-on-large-tables, require-foreign-key-constraints-on-related-tables | no-unindexed-schema-migration-on-large-tables, require-foreign-key-constraints-on-related-tables |
| data-where-on-delete | yes | yes | require-where-on-delete-update | require-where-on-delete-update |
| overlap-unauthenticated-route | yes | yes | no-unauthenticated-api-endpoints, no-unbounded-list-query-without-pagination | no-unauthenticated-api-endpoints, no-unbounded-list-query-without-pagination |
| overlap-unbounded-list | yes | yes | no-unauthenticated-api-endpoints, no-unbounded-list-query-without-pagination | no-unauthenticated-api-endpoints, no-unbounded-list-query-without-pagination |
| performance-map-query-singleline | yes | yes | no-n-plus-one-queries-in-api-resolvers | no-n-plus-one-queries-in-api-resolvers |
| performance-map-query | yes | yes | no-n-plus-one-queries-in-api-resolvers | no-n-plus-one-queries-in-api-resolvers |
| performance-n-plus-one | yes | yes | no-n-plus-one-queries-in-api-resolvers | no-n-plus-one-queries-in-api-resolvers |
| reliability-health-check | yes | yes | require-health-check-before-traffic-shift | require-health-check-before-traffic-shift |
| reliability-lockfile | yes | yes | require-lockfile-update-with-manifest-change | require-lockfile-update-with-manifest-change |
| reliability-process-exit | yes | yes | no-process-exit-in-server-code | no-process-exit-in-server-code |
| reliability-recreate-single-replica | yes | yes | no-recreate-single-replica-deployment, require-health-check-before-traffic-shift | no-recreate-single-replica-deployment, require-health-check-before-traffic-shift |
| reliability-retry-backoff | yes | yes | require-retry-with-backoff-for-transient-failures | require-retry-with-backoff-for-transient-failures |
| security-eval | yes | yes | no-eval-with-dynamic-input | no-eval-with-dynamic-input |
| security-private-key | yes | yes | no-private-key-in-diff | no-private-key-in-diff |
| style-console-log | yes | yes | no-console-log-in-server-diff | no-console-log-in-server-diff |
| style-no-var-l4-positive | yes | yes | no-var-instead-of-let-const | no-var-instead-of-let-const |
| style-no-var | yes | yes | no-var-instead-of-let-const | no-var-instead-of-let-const |

## Held-out (excluded from score)
| case | hit | strict | fired | expected |
|---|---|---|---|---|
| clean-structured-clone-negative | yes | yes | — | — |
| security-eval-l4-positive | yes | yes | no-eval-with-dynamic-input | no-eval-with-dynamic-input |
