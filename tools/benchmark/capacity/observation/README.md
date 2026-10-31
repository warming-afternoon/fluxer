# Bounded R22 observation

`ObservationSession.mjs` provides `createObservationSession(options)` with
`beginStage(plan)`, `sample()`, `endStage(plan)`, `cancel()`, `close()` and
`setViolationHandler(handler)`. A stage plan must declare `stageId`,
`formalStartNs`, and `formalEndNs` in the session's explicit clock domain.
Providers are NOT started by construction. The runner installs its safety handler
before beginning observation; the handler aborts admission, not operating-system
services. Samples run sequentially and concurrent sample requests coalesce.

Required options: `providers`, `intervalMs`, `providerTimeoutMs`, `maxSamples`,
`maxSampleBytes`, `maxTotalBytes`, `maxErrors`, `maxGapNs`, `maxAgeNs`,
`requiredMetrics`, `clockDomain`. Optional `limits:{metric:{max:number}}` applies
immediate upper bounds to required metrics. Every limit is explicit; there is no
historical VM/GW sizing preset. All times in JSON are exact decimal nanoseconds.
Injected `nowNs`, `schedule`, `unschedule` permit offline deterministic testing.
`log` is passed to the existing bounded `openResourceLog`; it is disabled by
default. `close()` releases it after all stages, not between levels.

## Providers

- `createHttpJsonProvider({id,url,headers,fields,timeoutMs,maxResponseBytes,
  sourceClockDomain,timestampPath,sourceIdentityPath,expectedSourceIdentity})`:
  read-only GET, bounded streamed JSON, redirects rejected, field allowlist.
  `fields` maps metric names to arrays of JSON property names, e.g.
  `{'gateway.cpuCores':['gateway','cpuCores']}`. URL/headers/full response are
  never persisted. Missing/nonfinite numeric fields are omitted, not zero.
  The source must expose an actual sample monotonic timestamp and instance/boot
  identity. Both are explicitly mapped. Mismatched/missing identity is diagnostic
  only. A source clock domain must actually equal the observer clock domain:
  merely assigning the same string to different hosts does NOT synchronize them.
  Cross-host freshness requires a separately reviewed bounded calibration adapter;
  this implementation refuses to invent one. HTTP receive time alone proves
  request receipt, not source freshness.
- `createMetricReaderProvider({id,reader,fields,maxResponseBytes})`: reuses an
  already-owned `MetricHttpClient.read()` contract without spawning/killing its
  helper. The optional `sourceClockDomain`, `timestampPath`, `sourceIdentityPath` and
  `expectedSourceIdentity` mappings have the same semantics as the HTTP provider.
  Without them the adapter is diagnostic-only.
- `createNodeProcessProvider({id,clockDomain,resolutionMs})`: observes only this
  Node process RSS/heap, interval CPU delta (percent of one core), and actual
  event-loop p99 when the event-loop histogram has samples. It is NOT gateway,
  whole-machine, VM, container, scheduler or business CPU. Initial empty loop
  histogram stays absent; do not require that metric before a measured interval.

## Evidence and safety

The result retains raw bounded timestamped samples, errors, per-metric min/max,
last value/count, source freshness, observed window and formal window coverage.
Missing required metrics, provider failures/timeouts, source freshness failures,
poll gaps, and resource upper-bound violations call the installed safety handler.
Provider failures are terminal for that provider within the stage, so a hung
injected reader cannot create unbounded overlapping reads. Provider implementations
must still own cancellation/cleanup of their read operation.

`complete` requires a fully covered formal window, fresh comparable source
samples, no errors, and every required metric. `coverage.kind` is explicitly
**discrete polling, not continuous CPU coverage**. Unobserved CPU intervals cannot
be reconstructed from gauge readings. Existing `guards/IntervalCoverage.mjs`
and `ResourceGuard.mjs` remain authoritative for actual interval/boot-bound CPU
headroom proofs supplied by a capable adapter; this module does not duplicate or
weaken their validation. Summaries use sampled maxima, never extrapolated claimed
measurements. Optional native scheduler/NIF evidence remains unsupported/unknown.

Latency is owned by the transport and existing `evidence/DeliveryAudit.mjs`;
never substitute resource polls, receipt times or synthetic zero latencies for
actual send/receive evidence. Quantile bucket bounds must stay intervals.

Artifacts belong to the campaign's private/out artifact store and existing
`evidence/OfflineEvidence.mjs` bundle/hash validation. No Docker copy/export,
remote filesystem traversal, gzip of nonexistent historical files, overwrite of
old attempts, or service lifecycle operation is implemented here. Session failure
results remain partial; a cancelled result never claims completion.

## Admission and physical generator continuation

`beginSafety({stageId:'initialization'})` / `endSafety()` wrap admission using the
same real providers and immediate safety callbacks. Their distinct
`benchmark.observation-safety.v1` result has `safetyOnly:true`, no formal window,
and no generator performance result. Safety completion is not performance success.
A cancelled admission retains a partial safety result. Finish safety before
`beginStage`; the runner persists admission evidence separately.

Set **one** own-node provider `generatorProcess:true` only when that actual process
owns the generator. It cannot be duplicated under logical worker partitions.
Use required CPU/RSS safety metrics for initial admission; an initially empty
loop histogram is not synthesized. Formal generator evidence subsequently requires
actual paired CPU/loop intervals.

`result.generator` reuses `generatorIntervalEnvelope` over contiguous actual
source intervals intersecting the formal window. Configured `intervalMs` defines
an exact grid and must divide the formal duration; `maxGapNs` bounds every real
source interval. The guard requires complete interval coverage (no gaps/overlaps),
then conservatively takes maximum CPU and loop values over each cell's overlapping
source intervals. Boundary-crossing source intervals are retained, not discarded.
`rawWorkerIntervals`, SHA-bound `proof`, and derived cells are all preserved.
`workerSamples[].monoNs` is each derived cell's midpoint, NOT a fabricated sample
time; `derivedConservativeEnvelope:true` and the proof mark this explicitly.
The cells are **not independent raw samples**. `workerCoverage.expectedWorkerIds`
is the one physical provider ID; expected count comes from the configured grid,
never observed sample count. `known` is false if the guard cannot prove coverage.
Do not treat logical actor partitions as independent CPU samplers.
