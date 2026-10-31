# Capacity evidence gates

This module is a source-derived portable integration of R22's recipient bitmap,
HTTP reconciliation, ACK frontier and continuation responsibilities. It imports
`evidence/DeliveryAudit.mjs`; it does not implement another delivery recorder.
It runs no network requests, services, benchmarks or filesystem mutations.

## Contracts

- `auditDeliverySupply({config,plan,checkpoint,final})`: requires actual bitmap
  bytes, every per-message summary, admitted HTTP records and actor manifests.
  Recounts bits through `mergeSnapshots`, checks each recipient bit/padding,
  stage/run/attempt/scenario binding, planned schedule, unique API message IDs,
  actual WS message IDs/submission times, fanout and quality counters.
- `auditAckFrontier({checkpoint,cursors,intervalMs,final,previousCheckpoint})`:
  validates actual attempt/completion events, due time/cadence, counts and
  monotonic cursors. Between stages, committed ACK <= persisted <= last received
  permits legal completion while a readonly query is running. Final requires
  received = committed ACK = persisted, drained queue and no outstanding attempts.
  Never forces an ACK tail between stages. Cursor IDs stay decimal strings.
- `auditStage(...)`: combines delivery, ACK, explicitly bounded HTTP/scheduled/WS
  latency, fully covered resource observations, and steady-stage trend gates.
  Missing/invalid evidence stops continuation. Warmup receives quality gates,
  not a steady-capacity claim. Final requires actual close and final snapshots.
- `assessTrend(...)`: actual monotonic samples, rolling submission/completion
  supply fractions, receive coverage, persistent backlog windows and observed
  latency-window growth. All thresholds/window durations are caller policy;
  no historical 30K/35K/40K rates, environment limits or account IDs are defaults.
  `ContinuationRules.mjs` preserves the supplied continuation.v1 algorithms:
  rolling supply, continuous shortfall spans, all-sample OLS backlog windows with
  strictly increasing pending age, merged first/last histograms, Theil–Sen latency
  slope, tail jitter, scheduled-lag bursts and physical generator CPU/loop pressure.
  The 360-second / six 60-second window profile has parity regressions against the
  original source. Durations and all thresholds are explicit/configurable.
- `assessNextStage(...)`: optional explicit metric-max linear headroom screen;
  never overrides failed original gates. Discrete resource maxima do not prove
  continuous CPU occupancy or production capacity.
- `auditFinalArtifacts(...)`: rejects preview-only, missing, duplicate or unexpected
  stages, missing legal drain and missing actual close. Lists unrun reserved stages.
  Extra frames observed all the way through socket close remain **unknown**.

`VerifyAckCursors.mjs` now exports `readCursorPartition` and
`createReadOnlyCursorReader`. The old CLI and portable transport share the same
prepared paginated Cassandra SELECT with local-quorum consistency. Imports no
longer eagerly load the driver. Caller explicitly owns client connection/cleanup;
partition size, duplicate keys and pagination cycles are bounded/rejected.
No Postgres support, reset/write query or implicit DB operation is provided.

## Policy / evidence limits

`maxScheduleLagMs`, `maxHttpLatencyMs`, `maxWsLatencyMs`, nonempty
`resourceLimits: {metric: {max}}` and the full `trend` object are explicit.
Trend fields: `rollingWindowSeconds`, `rollingStepSeconds`, `endpointToleranceMs`,
`minSupplyRatio`, `minReceiveRatio`, `minPassingWindowFraction`,
`maxShortfallSeconds`, `backlogWindowSeconds`, `maxBacklogSlopeRatio`,
`maxBacklogIncreaseSeconds`, `maxPendingAgeMs`, `maxTailMs`,
`maxEndBacklogSeconds`, `maxLatencyGrowthRatio`, `maxLatencyGrowthMs`.
`nextStageLimits: {metric: {max}}` is optional additional screening.
A short steady phase without backlog/latency-window coverage is unknown, not pass.
No gzip/CRC implementation was extracted: supplied artifact-audit variants do
not contain one. ArtifactStore handles bounded files and reread SHA verification.

Offline regression tests are in the delivery ZIP's `verification-r22/audit`;
they use synthetic evidence and an injected mock Cassandra client only.

## Source-faithful continuation policy

Source algorithm constants retained by the default profile (and shown explicitly
in the scenario template): `endpointSupplyRatio: 0.995`, `rollingReceiveRatio: 0.99`,
`latencySlopeMsPerSecond: 1`, `latencyTailJitterMs: 25`,
`scheduledLagMaxMs: 1000`, `generatorCpuMaxPercent: 90`,
`generatorLoopP99MaxMs: 100`, `generatorLoopFraction: 0.25`.
The 360/60 profile compares merged first/last two windows and tests the final
three windows. Short explicitly configured test windows scale window counts, not
pretend they establish six-minute capacity. Actual HTTP submission time assigns
schedule/HTTP latency bins; actual receive-time DeliveryAudit histograms assign
WS bins. Missing histograms or physical generator coverage remain unknown.
This live implementation has one physical generator process, not eight independent
workers: never duplicate its CPU sample for logical partitions. Observation uses
conservative covered-cell envelopes from actual CPU/loop intervals with retained
raw provenance; these derived cells are not independent raw measurements.
