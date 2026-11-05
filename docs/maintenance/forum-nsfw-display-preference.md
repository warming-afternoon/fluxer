# Forum guild NSFW display preference

## Scope and authority

This patch adds an independent display restriction only for the exact configured
`INTEGRATION_GUILD_ID`. It does not change another guild's policy, a native age
qualification, roles or private-thread membership. Setting the preference to true
removes only this additional restriction; native authorization still decides.

The native `user_guild_settings` row owns `show_nsfw` / `nsfw_version`, keyed by
`(user_id, guild_id)`. Missing rows and unset values are hidden. The dedicated
Cassandra bigint version starts at zero and uses LWT compare-and-set. It is not
the existing notification `version`, whose ordinary update helper is not a CAS.

Ordinary notification writes explicitly exclude the new pair. The first CAS on
an existing null-version row also guards its ordinary row version because the
query DSL rejects an all-null condition. Unrelated contention re-reads and retries;
sustained contention is retryable BUSY, not a false NSFW conflict. Authority reads
use SERIAL consistency. General all-guild notification reads keep their original
consistency; bootstrap replaces only a participating target's settings with a
separate authoritative target read. A failed or malformed read cannot grant.

Forum uses two exact, Forum-only NATS subjects:

- `rpc.preferences.v1.get_service`: `{version:1, request_id, actor_user_id, guild_id}`
- `rpc.preferences.v1.update_service`: the same plus `show_nsfw:boolean, expected_version:number`

The response is `{guild_id, show_nsfw, nsfw_eligible, version}`. Successful updates
return exactly expected+1. A matching retry can return the already committed pair
and repair propagation; a newer conflicting value returns STALE_VERSION. The
caller must reload rather than overwrite it. Current native account and target
membership are checked. Broker ACLs isolate these subjects from the bot role.

`show_nsfw` is raw preference; `nsfw_eligible` is a read-only result of the existing
native `canUserAccessNsfwContent` rule. Forum content uses their conjunction, while
settings display/save the raw preference. Neither endpoint changes eligibility.
Bots, missing DOB and disabled DOB collection retain the existing native meaning.
The display preference must never be treated as proof of adulthood.

## HTTP, collections and Gateway delivery

HTTP display checks read the native preference without needing a live Gateway
session. Hidden channel/thread resources return the existing unknown-channel 404.
Dependency failure is a service error, never a fabricated allowance. This display
check is outside optional age-validation skips and visitor fallback. Original
HTTP age checks and their responses remain intact when display is enabled.

Channel/thread collections, supported message-search scopes and explicit IDs,
READY read-state metadata and ACK responses are filtered. Classification includes
channel/category/guild inheritance and the actual current parent of a thread.
Legacy read-state metadata whose actual channel cannot be resolved is suppressed
unless its non-target guild scope is explicit. Failed resolution is not success.

Gateway keeps only a versioned display preference and a separate in-progress
fence. No new age cache or age epoch is introduced. Original visitor admission,
`adult_content_allowed`, `hidden_nsfw` and minor eviction remain native. Roles,
thread membership and other native permission paths are not granted by true.

The display deny applies before cached-channel hits and fallback permission
recomputation. Cache keys retain the full preference version to avoid reusing a
view from an earlier generation. Target-only cache miss eviction bounds visitor
historical views to 256 and ETS viewable entries to about 1024 (a soft bound under
concurrent insertion); eviction only recomputes native permissions, never grants. Both connect paths, target async finalization, role/viewable caches,
thread gates, live delivery, presence/read-state metadata, replay and local queued
push are covered. Target async finalization rechecks current classification.
Unrelated-guild-only sessions are not registered for target revocation. A later
join/visit to the target without scoped registration requires fresh identify.
Transferred scoped replay is invalidated rather than trusted on a cold node.

Scoped sockets are registered before identify/resume can deliver. Their registry
outlives session detach or normal exit: a dead session alone cannot prove a Cowboy
socket stopped processing queued dispatch. Begin/sync also signal the independently
registered sockets and wait for confirmed death, retaining evidence after a timeout
or `noconnection`. Owner monitors remove only proven-dead sockets; the ETS heir
preserves registrations and display watermarks if the shared table owner restarts.

Internal HTTP permission RPCs use a transient `api_native_permissions` flag to
calculate the original native permissions without relying on a random online
session's display cache. The API separately applies the display restriction and
its existing age checks. The flag is internal, not WS input or persistent state.

## Write and crash-recovery protocol

1. Validate exact scope, actor and expected version using native authority.
2. Durably track a unique intent containing only the authorized preference update.
3. Pre-fence synchronously across all required Gateway nodes. Each begin first
   reads native preference authority through `get_nsfw_display_preference`. If a
   recovery already committed a newer winner, it synchronizes that winner instead
   of recreating a fence after restart. Otherwise it raises expected+1 and closes
   registered sessions and sockets, including resumable disconnected sessions.
4. LWT-CAS the native pair.
5. Synchronize the committed native version. Preference/version/fence are one
   atomic local row; only a version at or above a fence clears it. Older completion
   cannot undo a newer operation. Bootstrap cannot clear an unfinished fence.
6. Publish normal all-device settings/push settings, delete this exact intent,
   and report success.

If intent persistence or fencing fails, CAS does not start. If CAS or later work
fails, the request is not reported successful. Recovery re-reads authority: it
completes the exact desired CAS only if the authorized expected version remains;
otherwise it propagates the newer winner without overwriting it. Unique attempts
cannot delete each other's journal records. A failed HTTP/RPC response does not
prove rollback; clients must refresh actual authority.

The recovery loop scans sixteen bounded shards. Outage/backlog can extend recovery
indefinitely; its tick is not an end-to-end deadline. Forum-local preference saves
and native NSFW saves are not a cross-database transaction. Partial failure must
be shown and reconciled, never described as an atomic rollback.

## Topology and rollout

Apply `fluxer_api/src/integration/upgrade-v5-nsfw-display.cql` before new selects.
Fresh schemas include both columns in `tools/dev/cassandra_target_schema.json`.
Integration startup probes column availability before ready.

Use the same `INTEGRATION_GUILD_ID` in API, worker, integration and Gateway. Scope
mismatch rejects synchronization. This is not a complete read-side safety net for
an incorrectly configured mixed-scope deployment. Every service must use the same
scope before admitting traffic; scope changes require a coordinated drain/restart,
not a live switch. Drain/replace old Gateway code before enabling
writes. An old Gateway lacking pre-fence support prevents a new writer's CAS.

Forum's frontend must use V2. The user accepts a short transition with V1 still
open, and will close V1 after V2 has been used for a while. V1 Discord Thread
projections do not apply this preference, so legacy authenticated entry points may
still return that Discord-source content during the transition. This is an accepted
short-term scope limitation, not a claim of site-wide uniform filtering. Closing
V1 is not a prerequisite for this release, and this patch does not close it.

Clustered deployments require `INTEGRATION_NSFW_GATEWAY_NODES`, a comma-separated
complete list such as `gateway@10.0.0.11,gateway@10.0.0.12`, on every Gateway. The
confirmation set includes configured, current and sticky previously observed
nodes. Missing topology or an unreachable required node fails confirmation;
disappearance from discovery is not retirement. The bundled Compose file passes
this environment variable through and defaults to one non-clustered Gateway.

## Validation and known limits

Use `fluxer_gateway/docs/nsfw-display-validation.md` for exact offline commands,
measured call counts and their limitations. Native UI saves are explicit,
non-coalesced CAS commands with no optimistic success; lower-version events cannot
reopen a later false. Test reports identify what was actually run.

No DOB/bot/accounts-policy write path is modified. Existing native age concurrency
or stale-DTO behavior is a separate known upstream risk, not repaired or widened
by this display toggle. Historical qualification-design experiments are excluded
from this product patch and are not a prerequisite or an implemented age system.

Already downloaded content, screenshots/client memory cannot be recalled. Issued
signed media URLs remain usable until their normal expiry. Local push is checked
again at outbound publish, but notifications already accepted downstream cannot
be recalled. This patch does not revoke media capabilities or purge storage.

Real replicated Cassandra SERIAL/LWT behavior, actual broker ACL/failure behavior,
production partitions, browser multi-device reconnect and deployment are separate
acceptance checks. Offline mocks/microbenchmarks do not prove those environments.
