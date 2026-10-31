# Shared capacity configuration and stage planning

This is a small new portable adapter of the supplied `R12InputPaths.resolveAttemptOutputPaths` binding and indexed `StaircasePlan.materializeStage` integer scheduling algorithm. It is **not** the missing generated `ConfigurationSourcesMentionsOnlyR*` or final R22 runner. It does not read environment variables, create directories, connect services, launch workers, or authorize a benchmark.

`createCapacityConfig(input)` is the single boundary for run identity, environment label, absolute output parent, worker IDs, public actor metadata, author IDs and phase definitions. It returns a deeply frozen configuration, copies allowed fields rather than retaining caller objects, and omits actor credentials. Paths are derived once as `outputRoot/runId/attemptId/{record.json,private,out}`. `assertAttemptOutputBinding(config,{recordPath,record})` compares actual record identity and both output-path representations against that same configuration. Checks are lexical; callers must independently control filesystem permissions and symlinks before opening paths.

Required input:

- `runId`, `attemptId`, `environment`: explicit stable labels; runId must be a portable single directory name.
- `scenarioSha256`: explicit SHA256 of the source scenario bytes; a binding, not a substituted plan hash.
- `outputRoot`: an absolute directory on the executing platform, not a private default.
- `workerIds`: unique IDs; `actors`: unique `{id,cohort:'member'|'browser',threadId}` entries; `authorIds`: unique configured member IDs.
- `phases`: unique `{id,kind:'warmup'|'steady',durationSeconds,targetFanoutRate,drainNs,ackIntervalMs}` entries. Timing and rate are positive safe integers; `drainNs` is an unsigned exact integer string, bigint or safe integer. ACK intervals must fit the timer range.
- `maxMessagesPerStage`: optional allocation cap, default100000, maximum1000000. Actor and worker/phase lists also have hard safety bounds.

`materializeStage(config,{phaseId,actorsByWorker,startNs,sequenceStart})` requires the normalized configuration from the factory and actual worker ownership Map. Each worker must own at least one actor; every configured actor must appear exactly once with unchanged cohort/thread. Actor order within each worker is preserved. This adapter intentionally retains the source's **single-thread** stage model, while removing fixed4000/8-worker/200-author/rate constants.

The message count is `(targetFanoutRate * durationSeconds) / recipients`, calculated with BigInt. Nonintegral counts and allocations beyond the cap are rejected before conversion to an array length. Each timestamp is `start + index * duration / count`; sequence and timestamps remain decimal strings, even above Number.MAX_SAFE_INTEGER. `plannedHttpRate` is an exact numerator/denominator pair. `plannedUnique` is a planned fanout count, never actual receipt, ACK, durable cursor or clean-close evidence. `legalAckDrainBetweenLevels:false` preserves the continuous-stage requirement; the caller still must operate and finally drain the real scheduler.

No test files are added to the target branch. External offline tests cover exact large integers, ownership mismatch, mutation, invalid inputs, nonintegral schedules, path identity and allocation limits.
