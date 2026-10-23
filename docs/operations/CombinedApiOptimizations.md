# Combined channel authorization and ordered rate limiting

[中文版](CombinedApiOptimizations.zh-CN.md)

Both settings default to `true` in master configuration, environment loading and the self-hosted Compose template. Explicit `false` disables either setting without a schema migration. Existing installations must use the capability-first transition in [deployment guide](../../deploy/self-hosting/REQUEST_AND_PUSH_OPTIMIZATIONS.md); new defaults are not a safe uncoordinated rolling upgrade against old Gateway or Push versions.

| Environment | Master configuration | Operation |
| --- | --- | --- |
| `FLUXER_COMBINED_CHANNEL_AUTH_ENABLED` | `services.api.combined_channel_auth_enabled` | One Gateway RPC returns the guild context, membership and permissions for a channel authorization request. |
| `FLUXER_COMBINED_RATE_LIMIT_ENABLED` | `services.api.combined_rate_limit_enabled` | One standalone KV script checks the global limit before charging the route bucket. |

## Channel authorization rollout

Deploy Gateway support for `guild.get_channel_authorization` before enabling the API setting. Its versioned response binds the guild, context channel, permission target, mode and member identity. Denials, overload, timeouts, unknown methods and malformed versioned responses fail closed; they do not fan out to the old authorization calls. Unversioned responses may supplement only missing member or permission fields. Private-thread membership, timeout, NSFW and MFA checks remain in the API authorization path. Disable the API setting before rolling Gateway back to an implementation without the method. This optimization does not replace thread browsing or watch context RPCs.

## Combined rate limiting

Global rejection leaves the route bucket untouched. Route rejection retains the global charge. Email buckets run afterwards as an independent check; bypass, exempt routes, session revocation and response headers retain their existing behavior. KV Cluster uses the previous ordered single-key calls, avoiding cross-slot scripts; enabling this setting does not reduce Cluster round trips.

Only `NOSCRIPT` is retried with the same script arguments. A timeout, connection error or malformed result is an unknown outcome and must not trigger separate global/route charges. The shared single-key Lua remains the reference for leakage, TTL and reset calculations.

The integration test accepts `FLUXER_C_TEST_VALKEY_URL` and optionally `FLUXER_C_BASELINE_KV_SOURCE`. It clears the supplied database between cases: use a disposable isolated Valkey instance only. The baseline source should contain the original single-key Lua constants. Unit suites also cover the Cluster fallback and unknown results.
