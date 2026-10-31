# Portable capacity tooling

These are reviewed, parameterized **library modules**, not the full historical R22 coordinator or a load-running command. Imports do not start monitoring, connect to services, change networking, stop processes, or run a workload. Existing `tools/benchmark` corpus, ACK/cursor and HTTP helpers remain intact; these modules do not duplicate their deployment workflows.

## One configuration boundary

Create one immutable configuration with `config/CapacityConfig.mjs`, then pass its fields to each layer. The source scenario bytes/hash, run/attempt/environment, worker/actor ownership, output roots and phase list should not be independently re-entered into generated files. The following is an offline example only; the ownership Map in a real run must come from the actual successful worker initialization, not credential-file order.

```js
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createCapacityConfig} from './config/CapacityConfig.mjs';
import {materializeStage} from './config/StagePlan.mjs';
import {orderedActorsByWorker} from './runtime/ActorRoster.mjs';
import {deriveArtifactDirectory} from './evidence/ArtifactIdentity.mjs';
import {openResourceLog} from './guards/ResourceLog.mjs';

const scenario = {
  workerIds: ['worker-a'],
  actors: [{id: 'actor-a', cohort: 'member', threadId: 'thread-a'}],
  authorIds: ['actor-a'],
  phases: [{id: 'phase-a', kind: 'steady', durationSeconds: 1,
    targetFanoutRate: 1, drainNs: '1000000000', ackIntervalMs: 120000}],
};
const scenarioBytes = Buffer.from(JSON.stringify(scenario));
const config = createCapacityConfig({...scenario, runId: 'offline-example',
  attemptId: 'attempt-a', environment: 'offline', outputRoot: path.resolve('results'),
  scenarioSha256: createHash('sha256').update(scenarioBytes).digest('hex'),
  maxMessagesPerStage: 100});
const actualOwnership = new Map([['actor-a', 'worker-a']]); // Synthetic offline fixture only.
const roster = orderedActorsByWorker(config.actors, config.workerIds, actualOwnership);
const plan = materializeStage(config, {phaseId: config.phases[0].id,
  actorsByWorker: roster, startNs: '9007199254740993000', sequenceStart: '9007199254740993001'});
const identity = {runId: config.runId, attemptId: config.attemptId,
  stageId: plan.stageId, scenarioSha256: config.scenarioSha256,
  artifactKind: 'preview', visibility: 'private'};
const previewDirectory = deriveArtifactDirectory(config.paths.baseRoot, identity);
const disabledLog = openResourceLog({enabled: false});
console.log({plannedUnique: plan.plannedUnique, previewDirectory}); // No files or workload created.
```

`config.paths.outRoot` is `outputRoot/runId/attemptId`; record/private/out paths derive from it. Artifact directories add the phase, visibility and preview/final identity through `deriveArtifactDirectory`. The `scenarioSha256` binding must refer to actual scenario bytes; the factory does not independently read or authenticate them. Filesystem permission/symlink protection remains the responsibility of the caller that opens paths.

## Layer contracts

- **Config and exact plan:** `createCapacityConfig`, `assertAttemptOutputBinding`, `materializeStage`. Strict exact integers, bounded allocations, actual actor ownership, no fixed eight-worker/4000-recipient/rate assumptions. Plans remain single-thread; fanout totals are **planned**, never received evidence.
- **Worker/ACK/watch runtime:** `JsonLineWorkerPort` accepts an explicit child command and required partial-byte sink. Check both a response and its `completion` result; stdio drain/process close is not a clean WebSocket close. `ThrottledAckQueue` must receive a real ACK operation that resolves only after authoritative success; use `close()` and inspect its drain/failure result at the final stage. `WatchRetryController` cancels obsolete retries only on a validated ACK for the active nonce/cycle. See runtime examples before connecting services.
- **Evidence:** `DeliveryAudit` accepts the same worker roster mapped to `{id,cohort,channelIds:[threadId]}`, the exact plan messages and plan boundaries. Feed actual measured `record` events, use `exportBitmap`/`finalize`, and call `mergeSnapshots` with exact configured worker/actor IDs and raw bitmap bytes for byte/count verification. `checkpoint` is preview only. `ArtifactIdentity` and `OfflineEvidence` distinguish run/attempt/stage/source hash, private/out and preview/final; explicit bundle creation preserves failure partials. These do not prove persistent ACK/database cursors or WebSocket close. Keep the existing cursor-verification tool for its separate live contract.
- **Guards:** use `config.workerIds` in `generatorIntervalEnvelope` and explicitly provided measured intervals/monotonic window. `assertFreshResourceSample` requires actual sample/boot/process identities and caller-supplied thresholds. `assessHeadroom` adds conservative screening only after original quality, receipt and WebSocket conditions pass. `openResourceLog` defaults off and appends within budgets only when explicitly enabled. `stopOwnedProcess` requires an identity-bound platform handle adapter; it is not a PID-only or wildcard stopper and no native-process platform adapter is included. `stopOwnedContainers` is a separate explicit Docker full-ID adapter with identity readback; its graceful stop may force termination after the supplied grace period and is never WebSocket-close evidence.

All real operations remain explicit caller actions. The modules do not declare a stage complete merely because a plan exists, an observer process exits, or a caller supplied `complete:true`.

## Source lineage and unresolved closure

The supplied R21 execution index is intact, and generic algorithms were selected from its runtime sources. R22's supplied `offline-contract.mjs` specifies full 1 MiB/15 MiB terminal frames and true truncation rejection; the worker port applies and tests that rule without running its string-rewrite/deployment scripts. R22 `finish-contract.mjs` supplies the conservative extra-headroom rule, with machine-specific thresholds removed.

Still absent are the generated final `MixedAudienceCoordinatorMentionsOnlyR22.mjs`, `run-staircase-diagnostics-r22.mjs`, generated `ConfigurationSourcesMentionsOnlyR*`/related runner closure, final analysis files including fixed-written-ring readers, and streaming compressed-per-value/CRC implementations. The raw bitmap audit is **not** a substitute claimed as those missing sources. Clock-52's Windows/WSL machinery, instrumented NIFs, private deployment assets and hardcoded experiment generators are intentionally excluded. Exact file gaps and lineage hashes are listed in the delivery's source audit.

Focused offline checks were run; no real capacity, service, deployment, network namespace, process stop, database or device validation was performed for this revision. Tests live in the external delivery validation materials, not in product patches. See each module's bilingual README for contracts and limits.
