# Portable capacity evidence helpers

These opt-in Node modules have no service, process, network or file activity at import time. They do not run a workload. The source lineage is the indexed R21 `DeliveryAudit.mjs`, `future-runtime/OfflineEvidence.mjs` and the validation half of `future-runtime/PhaseEvidence.mjs`. They do not recover the missing generated R22 analysis/runner.

- `DeliveryAudit` preserves exact decimal/BigInt sequence and monotonic-time values, real actor insertion order, bounded receipt bitmaps, unique actual receipts, duplicates, missing recipients and separate formal/tail counts. `finalize()` seals collection; `checkpoint()` remains an open preview. `mergeSnapshots()` requires exact worker/actor coverage and rejects mixed preview/final input. Preview merging needs explicit `allowCheckpoints: true`. Supply `bitmapDataByWorker` to verify raw bitmap hash/length **and bit count** against the claimed actual receipts; without bytes, `bitmapDataVerified` remains false. Planned fanout is not actual receipt evidence. This does not prove database ACK persistence or WebSocket clean close.
- `validatePhaseBoundaryEvidence` validates the existing observed-phase DTO, complete run/attempt/stage/phase/clock identity, source references and exact monotonic ordering. Pass expected identity/hash fields when binding evidence to a known scenario. It does not open referenced files or validate a full private scenario manifest. Unsafe numeric clocks are rejected; use decimal strings for nanoseconds.
- `OfflineEvidence` explicitly copies a caller-selected file list into a new separate directory, hashes before/after/copy, refuses symlinks/traversal/overwrite and retains copied partial files plus `BUNDLE-FAILURE.json` on failure. `verifyEvidenceBundle` verifies all selected file bytes and the expected identity without contacting the original services. `writeDerivedJson` never overwrites an earlier result.
- `ArtifactIdentity` is a **new small integration adapter**, not a recovered R22 DTO. It validates `{runId, attemptId, stageId, scenarioSha256, artifactKind, visibility}`. `artifactKind` is `preview` or `final`; `visibility` is `private` or `out`. All fields are bound when verifying a bundle. `deriveArtifactDirectory(root, identity)` derives separate paths without creating them. This identity labels provenance, not a guarantee that caller-selected files are free of private content.

Example from the repository root:

```js
import {createEvidenceBundle, verifyEvidenceBundle} from './tools/benchmark/capacity/evidence/OfflineEvidence.mjs';
const identity = {
  runId: 'run-1', attemptId: 'attempt-1', stageId: 'stage-1',
  scenarioSha256: '...64 lowercase hex characters...',
  artifactKind: 'final', visibility: 'out',
};
await createEvidenceBundle({sourceRoot, destinationRoot, identity,
  files: ['summary.json', 'bitmap.bin'], requiredPaths: ['summary.json', 'bitmap.bin']});
await verifyEvidenceBundle(destinationRoot, identity);
```

The caller supplies explicit roots and manifests; no WSL, account, IP, container or deployment identity is embedded. Existing `VerifyAckCursors.mjs` remains the separate guarded database cursor verifier; it is not reimplemented here. The module tests are external integration-validation fixtures, not part of this branch's product changes.

Missing source limits: supplied `DeliveryAudit` exports raw bitmaps. Final streaming compression/per-value restoration/CRC and fixed-written-ring reader implementations are absent from the supplied dependency closure, so those capabilities are **not** advertised or fabricated. No capacity, real database, devices, real cluster or crash-injection test has been run for this integration.
