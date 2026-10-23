# Request authorization, rate limiting and push-clear transport

[中文版](REQUEST_AND_PUSH_OPTIMIZATIONS.zh-CN.md)

This release enables three request/notification optimizations by default: a combined channel-authorization Gateway RPC, ordered global/route rate limiting, and per-item push-notification clear batches. Explicit `false` preserves the original path. Deploy the complete implementation, not just new environment values on old binaries.

| Process | Setting | Default and disabled behavior |
|---|---|---|
| API/worker | `FLUXER_COMBINED_CHANNEL_AUTH_ENABLED` / `services.api.combined_channel_auth_enabled` | `true`; false uses the original separate authorization calls |
| API/worker | `FLUXER_COMBINED_RATE_LIMIT_ENABLED` / `services.api.combined_rate_limit_enabled` | `true`; false uses separate global/route checks |
| Gateway sender | `FLUXER_GATEWAY_CLEAR_BATCH_ENABLED` / `services.gateway.clear_batch_enabled` | `true`; false sends the original individual clear requests |
| Every Push receiver | `FLUXER_PUSH_CLEAR_BATCH_ENABLED` | `true`; false rejects clear batches, so disable only after all batch senders and outstanding work are drained |

Standalone KV uses one ordered script; KV Cluster retains sequential single-key checks. Quota, TTL, permission, MFA, NSFW, private-thread membership and read-state protection remain intact. Thread browsing/watch subscriptions and subscription concurrency are unchanged. Existing explicit false values remain false; updating `.env.example` does not migrate operator configuration.

## Build and identify the release

The source-build overlay shares one image between API and worker and leaves unrelated service image pins unchanged. `FLUXER_PRODUCT_BUILD_TAG` selects an immutable tag for the three locally built product images, while `FLUXER_SOURCE_SHA` identifies the checkout. The previous `FLUXER_BCD_IMAGE_TAG` is retained only as a compatible alias when the descriptive tag variable is absent; it is not a feature switch. The four behavior settings above retain their existing names.

From this directory, with normal required secrets/domain in `.env`:

```sh
export FLUXER_SOURCE_SHA="$(git rev-parse HEAD)"
export FLUXER_PRODUCT_BUILD_TAG="request-push-${FLUXER_SOURCE_SHA}"
docker compose -f docker-compose.yml -f request-and-push-optimizations.compose.yml config --quiet
docker compose -f docker-compose.yml -f request-and-push-optimizations.compose.yml build api gateway push
# New installations only; existing clusters must follow the staged transition below.
docker compose -f docker-compose.yml -f request-and-push-optimizations.compose.yml up -d --no-build
```

Record effective Compose, source SHA, image IDs/digests and flags. Registry deployment may publish and pin the same images separately. An old published image does not gain implementation support from new environment settings. Gateway requires a complete `rebar3 as prod release`, with matching `.app`, beams, `start.script` and `start.boot`; do not overlay new beams onto an old embedded release or switch to interactive loading. Before traffic, verify service health, image identities, embedded startup and `guild.get_channel_authorization` support.

## Existing installations: receiver and RPC capability first

An uncoordinated rolling update with new defaults against old Gateway/Push versions is unsupported. Apply `request-and-push-compat.compose.yml` **last** during transition: it disables both combined API operations and Gateway clear batching while keeping upgraded Push receivers able to accept both protocol versions.

1. Preserve effective configuration and image digests. Set both API flags and Gateway clear batching explicitly false before replacing binaries. Recreate affected processes during a controlled maintenance/drain window; in-memory outbox jobs are not durable across restart.
2. Upgrade every Push replica in each `push.job.clear` NATS queue group with receiver support true. New receivers accept individual requests. Do not send batches while any receiver is old or disabled: a request can reach any queue-group replica.
3. Upgrade every Gateway RPC endpoint and actual guild owner to the complete release, keeping clear senders false. APIs with combined authorization disabled still use legacy methods. There is no unknown-method/timeout fallback; compatibility decoding only supplements an already successful response from the new method.
4. Verify all Gateway capabilities, then enable both API flags on every API/worker. Separately pause all relevant producers and drain each sender/receiver before restarting Gateway clear senders with true.
5. Verify both API flags and every sender/receiver true. Persist these values and monitor failures, retries, expiry, drops, queued and inflight work.

Remove the compatibility overlay in stages, not with one full-stack update. After capability checks, update API/worker while keeping senders disabled:

```sh
FLUXER_COMBINED_CHANNEL_AUTH_ENABLED=true FLUXER_COMBINED_RATE_LIMIT_ENABLED=true \
FLUXER_GATEWAY_CLEAR_BATCH_ENABLED=false FLUXER_PUSH_CLEAR_BATCH_ENABLED=true \
docker compose -f docker-compose.yml -f request-and-push-optimizations.compose.yml up -d --no-deps --no-build api worker
# Pause producers and establish drain first, then update senders separately.
FLUXER_COMBINED_CHANNEL_AUTH_ENABLED=true FLUXER_COMBINED_RATE_LIMIT_ENABLED=true \
FLUXER_GATEWAY_CLEAR_BATCH_ENABLED=true FLUXER_PUSH_CLEAR_BATCH_ENABLED=true \
docker compose -f docker-compose.yml -f request-and-push-optimizations.compose.yml up -d --no-deps --no-build gateway
```

Command-scoped values do not update `.env`; persist them. These commands do not upgrade/verify receivers or establish drain. Pausing HTTP alone is insufficient while WS, workers or background jobs still enqueue. Inspect each Gateway's native `push_outbox:stats/0`, queued/inflight/followup/retry work where available, and Push running/queued work. Confirm no new production or drops/expiry masquerading as drain. Benchmark diagnostic counters are not a production durability API. If drain cannot be audited, retain compatible binaries/flags and schedule maintenance; do not claim a lossless restart.

## Disable and roll back

Keep current Gateway RPC capability and all Push receivers true initially.

1. Set both API flags false, replace all API/worker processes and let old combined-authorization requests/error mapping settle before any Gateway downgrade.
2. Pause producers and drain every Gateway's queued/inflight/followup/retry work while receivers remain true. Restart each sender with clear batching false, then resume. The flag is read at process initialization; editing a file does not reconfigure a running outbox.
3. Only after all batch producers, in-flight/retry requests and receiver work finish may receivers be disabled/downgraded. Keep receiver support if uncertain. A toggle cannot withdraw an issued batch; old/disabled receivers reject it and retries may expire.
4. Downgrade Gateway to a release without `guild.get_channel_authorization` only after every API has disabled combined authorization and its old requests have settled.

Queues/deduplication are memory/TTL based, not a durable transactional outbox or cross-instance exactly-once mechanism. Graceful Push shutdown has a deadline; an exited process or empty queue alone is not no-loss proof. Use coordinated container/process restart; live OTP upgrade of old queued entries is unsupported.

## Accepted behavior and performance limits

For thread authorization, the combined RPC overlaps independent database reads only after parent validation. To avoid orphaned work, exceptional paths wait for an already-started RPC before returning the original-priority error. Database failures or missing thread state can therefore turn an early error into a client deadline. This behavior is accepted; error timing is not universally equivalent and total return time has no universal 30-second bound.

Existing single-group measurements showed positive ACK HTTP/end-to-end/drain signals, but sending/delivery did not consistently improve over both surrounding baselines. Time/resource drift and fixed order limit attribution; there is no statistically established throughput guarantee. Use release-specific health, correctness and capacity checks for deployment decisions.
