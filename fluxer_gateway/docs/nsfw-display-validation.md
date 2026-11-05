# Scoped NSFW display: Gateway validation and operational boundaries

This supplements `docs/maintenance/forum-nsfw-display-preference.md`; that document
owns the API/storage recovery protocol. The Gateway display preference is an
additional deny for `INTEGRATION_GUILD_ID`, never a role, age grant or private-thread
membership grant. Other guilds keep native permission behavior.

## Reproduce the offline checks

Use Erlang/OTP 27 (`erl` and `erlc` on `PATH`), from the repository root:

```sh
NSFW_TEST_EBIN=/tmp/nsfw-beam bash fluxer_gateway/scripts/test-nsfw-display.sh
```

In the implementation workspace the pre-existing local toolchain was used with:

```sh
PATH=/workspace/scratch/45fcd84c324a/.runtime/bin:$PATH \
  NSFW_TEST_EBIN=/tmp/nsfw-beam \
  bash fluxer_gateway/scripts/test-nsfw-display.sh
```

The script compiles all 410 current Gateway source modules, then four EUnit suites.
No database, API, NATS, production service, package download or remote write is used.
The stand-alone compile reports `behaviour cowboy_websocket undefined`, because
this offline invocation does not load the Cowboy dependency. It is not a complete
`rebar3` release build, dependency validation, Dialyzer or Eqwalizer run.

The final local run on 2026-11-05 passed **54 tests**: 35 new NSFW tests plus
19 existing tests. `git diff --check -- fluxer_gateway` also passed.

The test suites are:

- `gateway_nsfw_preferences_tests`: scoped preference/default denial, inheritance,
  roles and private membership, per-user cache separation, cached and fallback
  recipient paths, stale startup and replay, native HTTP permission isolation,
  scope mismatch, expected cluster topology, live/disconnected session revocation,
  synchronous and asynchronous connect, classification changes during async work,
  pre-fence/commit ordering, recovery before the original request resumes,
  concurrent old begin versus commit, authority read after restart, native age/permission invariance,
  presence/read-state metadata, migration, queued push rechecks and hot-path trace.
- `guild_directory_permissions_tests`: 3 existing directory permission tests.
- `guild_data_tests`: 3 existing combined native authorization tests.
- `guild_thread_move_tests`: 13 existing thread lifecycle/version tests.

The new suite exercises real Gateway functions and the async compute worker. The
socket revocation test uses local actor/socket stand-ins around the real session
callback; it does not open a real Cowboy websocket. The new authority-read test
injects an explicit local read function into the internal transition and verifies
its call count, missing authority failures and newer committed native state. It
is not a real HTTP/database transaction test.

The partition regression verifies that an observed peer cannot disappear from the
confirmation set, missing fixed topology rejects, and an unreachable expected peer
makes fanout fail. It does not create a live multi-node network partition.
Migration tests begin with an empty preference table and reject a scoped transferred
replay buffer, requiring fresh identify instead. They do not exercise rolling
production deployment.

## Timing and query-count measurement

The final local run prints p50 and p95 in the test log;
these machine-dependent values vary across runs. The last test runs 200 events, each selecting 200 device sessions from the actual
`guild_sessions:filter_sessions_for_channel/4` cached-channel path. It reports p50
and p95 microseconds for one 200-device fanout. Erlang call tracing on `rpc_client`,
`rpc` and `erpc` asserts zero calls during those event selections. This is a local
microbenchmark, not end-to-end websocket latency, a service-load benchmark or an
assertion that every possible Gateway event has been dynamically traced.

No new external lookup is performed by the display checks in delivery, replay,
read-state filtering or queued push filtering. `begin_local` performs one native
preference read per expected node on the settings-change path, before fencing.
Startup obtains its native data through the existing API bootstrap.

## Synchronization and topology

Startup wire data includes top-level `forum_nsfw_guild_id`, native settings
`show_nsfw` and `nsfw_version`. No age qualification is stored or changed by this
preference feature. The old settings
`version` is not the preference generation. Sessions register for target revocation
only when startup `guilds` or `visit_guild_ids` actually contains the target. An
unrelated user's profile event does not register or revoke a target session.
Joining or visiting the target later without scoped registration requires a fresh
identify, instead of borrowing another device's cached allowance. Scope conflicts cannot change the
configured scope. Missing/malformed target display data denies sensitive content.
The deployment must use the same `INTEGRATION_GUILD_ID` in API and Gateway and must
not hot-switch that scope. Synchronization RPCs reject scope conflicts, but this
patch does not claim complete protection against inconsistent deployment scope
across every initial-connect and later-join path.

`guild.begin_nsfw_preference_update` validates scope and reads
`get_nsfw_display_preference` authority before raising `expected_nsfw_version + 1`.
An already newer native winner is synchronized instead of resurrecting a fence.
Preference/version/fence share one atomic ETS row. Old begins cannot overtake a
new local committed version. Startup imports cannot clear an unfinished fence.
Only `guild.sync_nsfw_preference` at or above the fence generation can clear it.
Both RPCs use the complete node set and wait for session and socket shutdown,
including sessions whose socket is already disconnected but whose replay remains.
A separate socket registry is populated before identify can emit READY and before
resume can emit replay. It survives session detach and uses the same ETS heir as
the preference watermarks. After revoking sessions, begin/sync directly closes each
affected registered socket and waits for its process DOWN. Session `normal` exit or
`noproc` is not a substitute for that independent socket confirmation. A socket
close timeout or remote `noconnection` fails confirmation and retains its record
for retry. The ETS owner monitors sockets, cleans records only on proven death,
and restores monitoring from the table after restart; disconnected nodes are retried
by its existing sweep. Tests cover normal exit without a reply, dead session PIDs,
detach before enumeration, close timeout/retry, and stale identify/resume sockets.
Already transmitted network bytes cannot be recalled; confirmation guarantees the
affected Gateway socket process has stopped, including its queued dispatch work.
A successful preference update requires successful fanout; failed fanout is not
confirmation. Native storage and the durable recovery intent remain API-owned.

For a clustered/discovery-enabled or previously multi-node deployment, explicitly
set `INTEGRATION_NSFW_GATEWAY_NODES` to the complete comma-separated Erlang node
names on every Gateway. The confirmation set includes this fixed list, current
members and sticky observed peers. Missing configuration, an omitted current node
or an unreachable expected peer prevents confirmation. The default single Gateway
can operate without the list. Dynamic topology without a complete fixed list is
not supported for this guarantee. Permanent retirement requires an intentional
configuration/maintenance procedure; membership loss alone does not retire a peer.
Cold transferred scoped guild sessions are invalidated and scoped session replay
transfers are rejected. This intentionally forces authoritative identify rather
than treating a copied snapshot as new-node authority.

## HTTP and push boundaries

The internal API permission RPC handlers use a transient `api_native_permissions`
state flag to calculate native role permissions. The API independently enforces
display and existing age gates from native storage for offline HTTP users. This
internal atom is added only by trusted RPC handler code, is not websocket input,
and is never persisted into guild state or native caches. EUnit checks that the
same user can receive native API permissions without any Gateway session while the
session-side permission cache still denies hidden content.

Target sensitive push recipients require a locally known true display preference
and no pending display fence, in addition to the existing push eligibility path.
An unknown display preference is suppressed; this feature introduces no age cache.
Queued local jobs are rechecked at each outbound publish attempt. This cannot recall
a notification that an external downstream service already accepted before a later
revocation; there is no downstream notification-cancellation protocol in this patch.

## Native age rules remain unchanged

Compared with baseline `9a4d9cd5b`, the member Gateway permission path had no
`nsfw_allowed` cache or age-generation logic. The display layer adds only a deny:
false or unknown hides scoped sensitive channels; true returns to the same native
roles, channel overrides, private-thread membership and any existing age checks.
It does not set `nsfw_allowed`, `adult_content_allowed`, DOB, bot status or roles.

The baseline visitor age gates remain intact: `guild_visitors.admit` reads
`adult_content_allowed`, `maybe_age_rejection` rejects restricted guilds,
`evict_minors` retains its original behavior, and `guild_visitor_permissions` filters
sensitive channels when `adult` is false. `guild_visitor_permissions.erl` and
`session_visits.erl` have no diff from the baseline. The new regression compares
show=true visitor snapshots with native adult=false and adult=true views, and
proves that the display preference cannot change that native age decision.
Member tests likewise compare show=true permissions with native role calculations
for ordinary members and the owner. USER_UPDATE follows its original dispatch path.

The extra sticky-age cache and user-version ordering considered during development
were removed. There is no new permanent age denial, birthday transition, midnight
logout or qualification-epoch protocol in this feature. The API's existing AgeUtils
and channel authorization age rules remain the authority for their original paths.

## Separate upstream qualification-ordering risk

The ordinary user row version is not a CAS age generation. Asynchronous profile
updates and delayed startup results do not constitute a strict globally ordered
age-revocation protocol. Closing that separate gap would require coverage of the
DOB/bot write paths, policy changes and pending bootstrap registration, rather than
changing a display preference. It is not newly solved or newly broadened by this
feature and is not a deployment prerequisite for the requested display switch.
No global user or policy storage change is part of this Gateway patch. The isolated
pending-token design experiment was not connected to production.

## Versioned display-cache bounds

Full preference-version keys are retained, including across false/true/false
transitions. For the target guild only, a visitor view miss clears the old map when
it has at least 256 entries, and a member viewable-channel cache miss clears the old
ETS entries when its size is at least 1024. The computed current entry is then added.
These are cache-size triggers rather than strict concurrent quotas: simultaneous
ETS writers may temporarily exceed the trigger. Watermarks, permission checks and
final delivery filtering are unchanged; eviction affects cache hits only.
Regressions run 1100 preference versions, reject delayed old-generation results even
when the current boolean equals the old boolean, and preserve other guilds' caches.
