# Multi-API deployment candidate

The default generated topology has two full API processes. Both handle normal logins, new accounts, multiple devices, sending and acknowledgements. There is no benchmark account/token map or API service discovery dependency. Instance-count changes require a controlled restart.

## Defaults and budgets

- Session activity caching (always enabled): process-local cache of successful session-activity enqueueing only. A local entry expires at 299 seconds, before the existing shared 300-second key. The cache is bounded at 20,000 entries. It never authorizes a request or bypasses revocation.
- Automatic KV pipelining (always enabled): automatic pipeline for API KV transport. This does not combine business transactions. Standalone Valkey is the validated scope; Cluster has not been validated here.
- FLUXER_API_INSTANCES=2: the renderer creates the topology; setting the variable alone does not start another process.
- Each API: container 1536 MiB, Node heap 1024 MiB. Total HTTP concurrency remains 512, divided across instances. Memory is independent per container. The renderer shows total budgets and rejects API limits exceeding 40% of host RAM.
- Caddy: container 1792 MiB, GOMEMLIMIT 1536 MiB.
- Guild member range loading: concurrency 4. Thread member loading: concurrency 2. Both are bounded and configurable.
- Outbox channel index: enabled. Logical task concurrency: 96. Each admitted task still has independent completion accounting. This is an index optimization, not a new clear-batch protocol.
- Existing narrow ACK authentication and combined acknowledgement gateway RPC are enabled in the deployment template and can be disabled.

Five-second user activity coalescing, experimental ACK admission and benchmark hooks are not included in this deployment source. Historical WSL experiments remain outside the repository.

## Generate and deploy

Prepare a resolved Compose JSON for the Cassandra installation and a clean Caddyfile, then run:

    node deploy/self-hosting/render-multi-api.mjs --input compose.resolved.json --output compose.multi-api.json --caddy-template deploy/self-hosting/Caddyfile --caddy-output Caddyfile.generated --instances 2

The renderer derives API service names, Caddy upstreams and direct internal RPC addresses from the same instance list. It does not provision Cassandra from the original upstream PostgreSQL Compose. Configure API, worker and Rust data services consistently for Cassandra before generation. Generated Compose/configuration files may contain secrets: keep them private and do not commit them.

Caddy uses least_conn, disables request retries, and probes /_ready every two seconds with a one-second timeout and two failures/successes to remove/reinstate an instance. Readiness caches dependency checks, excludes draining instances and is served before the HTTP admission limit. Gateway and Push use a bounded, health-aware direct pool for explicitly allowlisted read-only RPCs. Safe reads may retry within the existing time/attempt budget; non-read RPCs have one attempt. Unknown write outcomes must not be replayed automatically. Worker and scheduled jobs are not multiplied with API count.

Use a coordinated version of API, Gateway and Push; do not mix a Gateway without the combined ACK RPC with an API that requires it. The original template remains available for an explicitly selected single-API installation.

## Cassandra state semantics

This version retains the previous unconditional Cassandra read-state writer. It does not add version columns, conditional writes, deletion control rows or a migration/backfill. It must not be described as solving cross-process same-key races involving manual unread operations or mention increments. Health routing and disabled retries do not provide that coordination.

Production is a fresh installation. Apply the project's complete Cassandra target schema before starting the APIs (pnpm dev:cassandra:apply with the intended FLUXER_CASSANDRA_* connection configuration); API startup does not create the whole database. No old-data migration is required for an empty installation. The separate WSL CAS experiment and its snapshots must not be mixed into this source.

## Validation and future synchronization

Keep the core regression tests for cache failure/revocation, health/read-only retry safety, member-range completeness, outbox index lifecycle and deployment budgets. Build and run them against the integrated source. Historical benchmark results belong to the recorded source/image/configuration and do not prove the capacity of this new combined feature version.

Use dev as the product-code source of truth; merge dev into test to add the same optimizations alongside benchmark tools. Do not merge test back into dev wholesale. WSL should fetch the same Git branches and freeze a clean commit/image/configuration for each future run, with private fixtures/results stored outside Git.
