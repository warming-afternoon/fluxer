# Forum initialization lock versions

## Patch scope

Target branch: `dev`, fetched and verified at `6ae9c3ab012f664614fbf13f458f98b77675a521` on 2026-11-06 UTC. The repository's default `main` points elsewhere and is not this patch's baseline.

Only the two initialization versions in `IntegrationContentService.ts` change:

- Create: `forum_initializing`, user `0`, kind `lock`, active `true`, version **1**.
- Successful non-deferred completion: same channel/user/source, active `false`, version **2**, after the operation result is persisted.

The repository's positive safe integer validation, independent source names, native permissions, and first-post policy checks are unchanged. The narrow starter bypass still ignores only a `forum_initializing` lock; independent locks and user send restrictions continue to apply. A later version cannot be overwritten by a stale initialization retry.

Deferred creation still does not automatically unlock. Forum's `work_task_worker.py` task-ID version protocol is not changed and is outside this repository checkout. Before rollout, verify pending and newly created unlock task IDs are positive safe integers strictly greater than 1. An unlock with task ID 1 would conflict with the active initializer at version 1; do not replace task IDs globally with a constant.

## Running diagnostic build is a separate baseline

The reported running diagnostic image is `publication-diag-72122ef`; its candidate source was reported at `C:\Users\Administrator\Documents\Codex\2026-11-06\task-2\publication-diagnostics-candidate`. This cloud checkout does not have that Windows working tree or its uncommitted changes. The parent’s read-only PC comparison reports diagnostic commit `72122ef586f35a17611e48bfa0419e4996cc4b86`: the content service differs from dev by a `publicationStage` import, 13 diagnostic calls and removed comments, with unchanged initialization business logic. The candidate also contains a separate 771-line test file; do not overwrite it with this new dev test. A direct fetch of that full SHA from GitHub returned `not our ref`, so this report uses the PC comparison as evidence, not a cloud-side source verification. An image tag or abbreviated Git revision is not evidence that its contents equal current dev. No running image has been modified or deployed by this work.

Before adapting this change to that image:

1. Obtain the immutable image digest, build provenance/full source commit, and candidate's tracked diff plus untracked diagnostic source files. Do not include secrets or configuration credentials.
2. Compare its `IntegrationContentService`, `ThreadPolicyRepository`, `CassandraVersion`, `ThreadPolicyService`, `MessageSendService`, creation flow and Forum worker version behavior against this patch. Preserve diagnostic changes explicitly rather than overwriting them with dev files.
3. Apply the two version changes to the verified running-source baseline if that is the intended deployment target. Run these regression tests against the adapted source, including actual native permission checks and deferred task completion.
4. Record final source commit, patch hash, image digest and test results. A clean patch application against dev alone does not prove compatibility with the running diagnostic build.

## Data and recovery preflight

There is no automatic database migration in this patch. The unmodified repository rejects version 0 before insertion. If that exact code served the failed request, retrying the original operation after this fix can reuse its persisted plan without changing the operation ID.

A diagnostic fork might have allowed zero-version rows. Inventory affected `thread_external_policies` rows using a bounded set of known affected thread IDs, plus matching `integration_operations`, native thread/starter state and Forum jobs. Do not run a full-cluster scan or expose payloads in logs. Keep a protected backup of affected rows and inspect their source/user/kind/version/active values. Preserve each unrelated channel, user and policy source.

- No row / never-created resource: replay the same immutable operation request and ID after installing the fix.
- Active `forum_initializing` version 0: the normal repository cannot read this version. Only after confirming the owning creation and intended state, conditionally migrate that exact thread/user-0/source row from version 0 to active version 1. Do not unlock it. A data operator must review and execute the migration separately.
- Inactive version 0, or version 1 with ambiguous provenance: determine whether completion was durable and whether native creation and required Forum jobs actually finished. Do not infer completion from `active=false` alone or blindly re-lock/unlock it. Use a reviewed exact-row CAS plan preserving the intended state and monotonic version.
- A durable successful normal-create result with unlock/projection still pending: replay the same operation. It skips native creation and repeats version-2 unlock/projection idempotently.
- Deferred create: leave its lock active until the existing Forum dependency jobs complete and the task-ID-versioned unlock succeeds. Keep ordinary moderation locks intact.
- A newer version already exists: do not decrement it; investigate any mismatch rather than overwriting it.

Pause concurrent affected recovery/job writers for any reviewed migration, verify conditional updates actually applied, then re-read state and resume the original jobs. Do not delete operation records or allocate a replacement operation ID as a recovery shortcut. Do not flush all locks or relax global validation.

## Rollout and rollback gates

This deliverable does not authorize push, database writes, image publication or deployment. Validate a candidate against a disposable environment, then separately approve rollout. Exercise ordinary creation, deferred creation, retry after persisted result/projection failure, independent locks, user penalties and native permission denial, including multiple channels and processes. Verify stored version/source values, native lock projection and exactly one thread/starter per operation.

Before any rollback, account for version-1/2 records and completed operation logs. Do not restore the broken zero-version writer or decrement stored versions. Keep the tested version protocol in any rollback candidate; use a forward fix if needed.
