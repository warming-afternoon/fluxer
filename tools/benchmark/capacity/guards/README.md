# Opt-in resource and ownership guards

These explicit libraries extract reusable safety contracts from the supplied tooling. Imports do not sample resources, create logs, start timers or stop processes. There are no WSL/Docker/private-account identities, fixed container counts, experiment rates or product/NIF dependencies.

## APIs

- `openResourceLog({enabled:false})` does no I/O. Explicit enablement requires `file`, `maxRows` (at most100000), and `maxBytes` (at most64MiB). Existing complete records are appended, never truncated. An exclusive `.lock` enforces one writer. Budget exhaustion returns false: callers must stop observation and mark coverage incomplete. Failed writes preserve partial bytes and close the writer. Partial existing tails are rejected; crash-left locks require manual ownership verification, never automatic takeover.
- `readLatestResourceRecord(file,{maxTailBytes:65536})` reads the last complete JSON line from a bounded tail, ignoring an in-progress partial. Oversize records, missing complete lines and invalid UTF-8/JSON fail explicitly.
- `assertFreshResourceSample(sample,{bootId,nowNs,maxAgeNs,minimumAvailableBytes,expectedProcessIds})` validates supplied boot identity, exact monotonic time, freshness, completeness, resource minima and optional exact process identities. Decimal strings/BigInt prevent rounded timestamps. This does not independently collect or authenticate the supplied sample.
- `generatorIntervalEnvelope({byWorker,workerIds,startNs,endNs,cellNs,maxIntervalNs,maxCells})` creates conservative maximum envelopes only from continuous observed CPU intervals. `byWorker` is a Map of arrays of `{startNs,endNs,cpuPercent,loopP99Ms}`. It rejects gaps, overlaps, ordering errors, oversized intervals, missing tails, rounded Number timestamps and excessive output. Proofs retain exact coverage and source-row SHA256. Derived grid cells are not independent raw samples.
- `assessHeadroom(input)` accepts explicit rates, role limits, identical-boot/identical-instance before/after cumulative CPU counters and original continuation/resource/delivery/WebSocket evidence. Role rows are `{role,identity,restartCount,cpuUsageNs}`. It only advances when all original gates pass, actual unique received equals expected with no missing delivery, and projected CPU is strictly below every configured limit. Counts/times are decimal strings/BigInt. Linear projection is additional screening, not a capacity or clean-WebSocket-close proof.

No defaults encode the experiment's12 cores,35K/40K rates,3.6/10.8 core thresholds, eight workers or360-second window. A VM aggregate, if needed, must be supplied by a verified sampler using the same cumulative-role contract.

## Identity-bound stopping

`stopOwnedProcess(owner,{openHandle,timeoutMs,signal:'SIGTERM'})` requires `{pid,bootId,startToken,runId}`. The supplied handle must expose `identityBound:true`, `inspect()`, `terminate({signal,expected})`, `waitForExit({timeoutMs,expected})` and `close()`. Both the live instance and exit receipt must match the full identity. No broad process search, PID-only kill, forced kill escalation or automatic-stop CLI is provided.

The adapter must use an identity-bound kernel handle (such as pidfd) or an equivalently bound cooperative endpoint. Reading `/proc` and then calling `kill(pid)` is not sufficient because PID reuse can race the signal. The adapter must implement the exit timeout and deadlines/cancellation for all other operations; the wrapper does not promise a global async-operation deadline.

**Actual Linux/Windows handle adapters are not included or executed.** Offline mocks verify the contract, not production platform stopping.

## Source lineage and exclusions

The APIs derive from indexed `ResourcePressure`, `OwnedRuntime`, `GeneratorIntervalCoverage/Campaign`, R22 `finish-contract`, and R22 monitor-stop sources. Platform deployment code, fixed topology, script rewriting, scheduler/NIF instrumentation and clock-52's Windows/WSL apparatus are excluded. The implementation uses supplied same-boot monotonic values rather than claiming cross-platform clock calibration.

Relevant external fixture tests and exact commands are supplied in the delivery validation folder. No live monitoring, containers, capacity workload or real process termination was performed.

## Concrete exact-container adapter

`OwnedContainers.mjs` exports `stopOwnedContainers(owner,{execute,gracefulSeconds,timeoutMs})`, extracted from the actual `OwnedRuntime.stop` algorithm. The owner is `{project,services:[{id,imageId,role}]}` with full64-character container IDs, complete sha256 image IDs, bounded count and unique IDs/roles.

Explicit invocation inspects the frozen IDs, checks images and Compose project/role labels, calls `docker stop --timeout <gracefulSeconds> -- <ids>` only for matching running IDs, then inspects again to confirm all are stopped. It never discovers by name or substitutes missing/out-of-scope containers. `execute` defaults to Node execFileSync and can be replaced by an offline fake; import does not run a command.

Docker may forcibly terminate a container after its grace timeout; this adapter does not promise SIGTERM-only behavior. Call it only with authorization to stop those exact containers. Each command has timeoutMs, not the whole multi-command operation. Results explicitly set `cleanWebSocketCloseProven:false`. This revision only tested a fake Docker executor, not an actual daemon.
