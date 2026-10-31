# Configurable continuous capacity campaign

This is the R22 execution chain generalized for `test`; it does not deploy services,
select containers, create accounts, change membership, stop services, or infer a host.
The concrete HTTP/WebSocket driver and read-only Cassandra verifier are included.
No arbitrary adapter module is imported from configuration.

## Safe entry points

From repository root (Node with native WebSocket support):

```sh
node tools/benchmark/capacity/campaign/cli.mjs validate --config /explicit/scenario.json
node tools/benchmark/capacity/campaign/cli.mjs plan --config /explicit/scenario.json --output /new/private/plan
node tools/benchmark/capacity/campaign/cli.mjs offline-example --output /new/private/examples --attempt try-1
```

`validate` validates the immutable V2 workload and campaign envelope, not endpoint
readiness, credentials, observation coverage, or a capacity result. `plan` also
requires `actorOwners: {actorId: workerId}` for the declared, not yet verified roster.
The planner labels its output planning-only. Concatenate numbered `.json-part` files
in numeric order before JSON parsing. Neither command opens any network connection.
`offline-example` executes a three-stage synthetic lifecycle with an injected clock,
transport, observations and audit; it is explicitly NOT a capacity claim.

Only this opt-in command permits actual traffic, and was NOT run for this delivery:

```sh
node tools/benchmark/capacity/campaign/cli.mjs run --live \
  --config /explicit/scenario.json --credentials /private/credentials.json
```

The attempt directory must not exist. Rerun with a new `attemptId`; never reuse old
runtime state. Exit 0 means reserved stages and final evidence passed; exit 2 means
execution closed but some stage failed/was unknown/not run; exit 1 means command or
execution failure. SIGINT/SIGTERM abort owned scheduling and preserve partial evidence.
CLI failures deliberately omit endpoint/credential-bearing exception text.

## Configuration

Copy `scenario.template.json` as a starting point. Its IDs, endpoints, source hash,
clock proof and limits are placeholders/illustrations, not any real deployment; replace
and review every field. No credential template contains a usable token.

Top-level JSON: `capacity`, `campaign`, `assessment`, `observation`, `transport`,
plus `actorOwners` for planning. No secrets belong in scenario JSON. Capacity fields
are the V2 `config/CapacityConfig.mjs` contract: explicit `runId`, `attemptId`,
`environment`, source `scenarioSha256`, absolute `outputRoot`, unique `workerIds`,
`actors: [{id,cohort:'member'|'browser',threadId}]`, `authorIds`, allocation bound,
and `phases: [{id,kind,durationSeconds,targetFanoutRate,drainNs,ackIntervalMs}]`.
A single warmup precedes steady phases; all phases retain one ACK interval. The
single-thread planner proves actual worker/actor ownership, exact integer fanout,
contiguous sequence ranges and integer nanosecond schedules. The SHA is an explicit
source binding, not a claim this command has discovered/verified an external source.
In addition, the CLI records SHA256 of the exact input config file bytes in private
CONFIG provenance, without a recursive hash field. Programmatic callers get a hash of
`JSON.stringify(input)` instead. Neither hash is computed over credential files.

`campaign` requires exact unsigned decimal nanoseconds: `sequenceStart` (sequence,
not nanoseconds), `startLeadNs`, `maxInterstageGapNs`, `checkpointSettleNs`,
`finalAckTimeoutNs`, `failureTailTimeoutNs`, `operationTimeoutNs`. All durations
are positive and at most one day; final ACK timeout must exceed the legal interval.
The interstage gap is measured from prior formal end, so it includes WS drain,
checkpoint/cursor/observation/audit cost and the next start lead. Exceeding it fails
the continuous attempt; no silent reset/reconnect or fresh supply is substituted.

`assessment`: explicit nonnegative `maxScheduleLagMs`, `maxHttpLatencyMs`,
`maxWsLatencyMs`; nonempty `resourceLimits: {metricName:{max:number}}` and optional
`nextStageLimits` for an additional linear screen (never a capacity proof).
`trend` requires `rollingWindowSeconds`, `rollingStepSeconds`,
`endpointToleranceMs`, `minSupplyRatio`, `minReceiveRatio`,
`minPassingWindowFraction`, `maxShortfallSeconds`, `backlogWindowSeconds`,
`maxBacklogSlopeRatio`, `maxBacklogIncreaseSeconds`, `maxPendingAgeMs`, `maxTailMs`,
`maxEndBacklogSeconds`, `maxLatencyGrowthRatio`, `maxLatencyGrowthMs`. The source-derived
continuation profile also exposes `endpointSupplyRatio`, `rollingReceiveRatio`, `latencySlopeMsPerSecond`,
`latencyTailJitterMs`, `scheduledLagMaxMs`, `generatorCpuMaxPercent`,
`generatorLoopP99MaxMs`, `generatorLoopFraction`, `latencyComparisonWindows`,
`latencyTailWindowCount`, and `scheduledLagConsecutiveWindows`; template values are
explicit illustrative policy, not verified environment limits. Choose windows
compatible with every phase; missing/insufficient evidence remains unknown and stops
advancement. See `audit/StageAudit.mjs`; no historical R22 threshold is silently reused.

`transport`: see `transport/README.md` and constructor for explicit API/gateway URLs,
all concurrency/time/resource bounds, watch/heartbeat protocol, and Cassandra
connection fields (`transport.cassandra` is routed only to the cursor adapter, not the driver). Credentials are a separate private file: `actors` matching the
configured actors (tokens and guild IDs), optional Cassandra authentication, and
`observationHeaders: {providerId: headers}`. Before sockets, the concrete driver performs bounded authoritative thread-member
pagination and exact-set comparison. `credentials.admission` requires `readerId`,
`threadId`, and `expectedFollowerIds` for ALL expected followers (including offline
followers). The reader must be an explicitly authorized bot credential; transport
requires `membershipPageSize` and `maxMembershipRows`. Member actors must be in the
set and browser actors absent. Missing proof blocks initialization. This is read-only,
not automatic provisioning or account repair. Browser ACK eligibility must be explicit;
this runner never mutates membership to achieve eligibility.

`observation`: see `observation/README.md`. CLI provider types are `http-json` and
`own-node`; remaining fields map directly to `createObservationSession`. Required
metrics, clock domain, freshness, sample budgets, and polling intervals are explicit.
HTTP metrics need source timestamp and identity proof in the same declared clock
domain, not just a local HTTP receive timestamp. Own-node data observes ONLY the
load-generator process, not server/gateway/VM resources. The template explicitly
selects one `generatorProcess: true` own-node provider; its real CPU/loop intervals
feed the source-derived generator gate. Generator sampling interval must exactly
divide every phase duration before admission; own-node histogram resolution must
be positive and smaller than the interval. Leave enough start lead for initial
nonempty histogram intervals (the template leaves multiple sampling periods). `node.loopP99Ms` is not an initialization
required metric: an initially empty histogram is unknown, not zero. Formal generator
loop/interval coverage must still pass the stage audit; no initialization loop proof
is claimed. Unknown required metrics,
provider failure, unsafe values, or polling gaps abort active scheduling, not merely
block the next stage. Observation is closed in CLI finally, including failed runs.

## Lifecycle and evidence contract

`runCampaign({config,driver,observation,clock?,signal?})` initializes one driver once.
Required observation safety sampling begins before admission/socket initialization
and stops after initialization; this evidence is safety-only, never a formal stage.
A missing/failed required initialization resource proof blocks supply.
For each phase it materializes the exact plan against initialized actor ownership,
begins observation, schedules supply, allows only the stage's WS drain, checkpoints,
reads committed cursors, ends observation and calls the shared stage audit. It never
forces ACK drain between stages. Stage evidence includes actual HTTP responses,
recipient bitmaps, per-message summaries, cumulative legal ACK events, database
frontiers, timing samples, latency and resource gates. A failed/unknown gate retains
executed-stage evidence; subsequent stages become `not-run/not-evaluated`, not a
fabricated capacity failure.

Finalization is legal periodic ACK drain outside performance windows, exact
received/ACK/persisted frontier audit, actual clean socket close, and separate final
checkpoint/audit **for each stage**. Final checkpoints and cursors are reloaded
from hash-verified stored bytes before final audit, not audited only in memory. Preview artifacts never become final by renaming.
Extra frames through the entire close interval remain explicitly unknown.
`reservedStagesComplete`/`complete` count execution of reserved stages;
`performancePassed` additionally requires all preview/final audits. Per-stage results
are retained even when a conservative headroom screen prevents the next stage.

Every operation has a timeout and abort race. Safety faults cancel immediately.
On failure after supply completed with no observed safety fault, an optional bounded
legal tail may run before cancellation; active/unsafe failures cancel first and retain
read-only partial tails. Tail success cannot promote a failed attempt. Adapters must
honor abort/cancel; an uncooperative external adapter can outlive its timeout, and the
runner does not kill arbitrary processes as a fallback.

Artifacts are private: `outputRoot/runId/attemptId/private`, directory mode 0700,
files 0600. They include actor/thread/message IDs and must not be published unchecked.
No credentials are persisted. Large JSON documents are byte-sharded at 16 MiB; each
part and complete document is SHA256-bound in a manifest. `readArtifact(root,ref)`
verifies integrity then reconstructs Map and byte-buffer evidence. Final successful
execution re-reads every artifact before writing the manifest. Failure manifests
preserve what was written and remain explicitly partial. No file is 20 MiB or larger.

## Scope limits

No Windows/WSL/container identity, production account, fixed environment, old attempt,
or device eligibility cache infrastructure is carried over. Single-process logical
worker partitions are not represented as a verified multiprocess/source-IP layout.
Application-source-IP proof absent from the source package cannot be fabricated.
Live service compatibility, real recipient eligibility, actual source-IP distribution,
Cassandra access, resource clock identity and production capacity remain unverified
until explicitly configured and authorized against a real test deployment.
