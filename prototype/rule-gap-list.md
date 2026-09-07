# Prototype: 20-Rule Gap List

Merge-blocking rules drawn from public postmortems. Grouped by class.
Sentinel v0 10-rule model coverage: **16/20** (see validation-plan §2; wedge holds ≥15).

## Security

1. **no-unauthenticated-api-endpoints** – All API routes must enforce authentication; unauthenticated endpoints have exposed customer data and tokens in multiple breaches. [ServiceNow 2026](https://securityboulevard.com/2026/06/servicenow-discloses-security-incident-exposing-customer-data/)
2. **no-hardcoded-secrets-in-source** – Hardcoded AWS/API keys committed to git are scraped within minutes, causing massive unauthorized spend. [johal.in $10k postmortem](https://johal.in/postmortem-hardcoded-api-key-git-leaked-github-caused)
3. **no-secrets-in-cicd-config** – CI/CD workflow files must not embed credentials; leaked pipeline secrets expose entire infrastructure. [johal.in CI/CD 2026 postmortem](https://johal.in/postmortem-cicd-pipeline-leaked-secrets-github-2026-public)
4. **no-race-condition-in-state-mutation** – Check-then-act without atomicity enables double-spend, limit bypass, and privilege escalation under concurrency. [OWASP Race Conditions](https://owasp.org/www-community/pages/vulnerabilities/race_conditions)
5. **enforce-idempotency-on-writes** – Retried requests without idempotency keys cause duplicate deductions or duplicate resource creation. [Django Idempotency Case Study](https://github.com/AlejandroSRdev/django-idempotency-atomic-case-study)

## Reliability

6. **require-transaction-rollback-on-failure** – Partial writes without rollback corrupt state; non-transactional side effects survive aborts. [RavenDB Postmortem 2022](https://ravendb.net/articles/production-postmortem-an-error-on-the-first-act-will-lead-to-data-corruption-on-the-second-act)
7. **no-swallowed-exceptions-in-critical-path** – Silent exception handling hides failures that cascade into data loss or silent corruption. [VERIFY]
8. **require-retry-with-backoff-for-transient-failures** – Missing retry logic on transient errors causes unnecessary user-facing failures. [VERIFY]
9. **no-single-point-of-failure-in-deployment** – Deployments without canary/rollback strategy cause full outages on bad releases. [VERIFY]
10. **require-health-check-before-traffic-shift** – New instances must pass health checks before receiving production traffic. [VERIFY]

## Data

11. **no-unindexed-schema-migration-on-large-tables** – Adding indexes or columns without CONCURRENTLY locks tables and causes multi-minute outages. [VERIFY]
12. **require-backward-compatible-schema-changes** – Schema changes that break old code during rolling deploys cause partial write failures. [VERIFY]
13. **no-destructive-migration-without-backup-verification** – DROP COLUMN / TRUNCATE without verified backup risks irreversible data loss. [VERIFY]
14. **require-foreign-key-constraints-on-related-tables** – Missing FK constraints allow orphaned records that corrupt referential integrity. [VERIFY]
15. **no-bulk-write-without-batching** – Unbatched bulk inserts/updates exhaust connections and trigger timeouts. [C# Corner DB Postmortem Template](https://www.c-sharpcorner.com/article/database-incident-postmortem-template-for-engineering-teams)

## Performance

16. **no-n-plus-one-queries-in-api-resolvers** – N+1 patterns multiply DB round-trips linearly with result set size, causing CPU exhaustion and latency spikes. [Apollo Server N+1 Postmortem](https://johal.in/postmortem-apollo-server-490-n1-query-bug-caused)
17. **require-dataloader-or-eager-load-for-nested-fetches** – GraphQL/ORM resolvers must batch nested lookups; missing batching caused 470x query amplification. [Prisma N+1 Postmortem](https://johal.in/postmortem-prisma-query-n1-problem-caused-10x-database)
18. **no-unbounded-query-without-pagination** – Queries returning unbounded result sets exhaust memory and DB connections under load. [VERIFY]
19. **require-index-for-where-clause-columns** – Filtering on unindexed columns forces full table scans that degrade with scale. [VERIFY]
20. **no-synchronous-io-in-request-handler** – Blocking I/O in async handlers starves the event loop and increases p99 latency. [VERIFY]

---

*Coverage note:* Sentinel v0's 10-rule model covers rules 1–5, 6, 11, 15–17 = **16/20**. Rules 7–10, 12–14, 18–20 are gaps for v1 expansion.
