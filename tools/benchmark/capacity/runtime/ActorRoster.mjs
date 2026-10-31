// SPDX-License-Identifier: AGPL-3.0-or-later

/** 以真实 initialize 所有权 Map 的插入顺序构造 actor 索引，不以凭据顺序替代。 */
export function orderedActorsByWorker(actors, workerIds, actorOwner, {expectedPerWorker, expectedCohorts} = {}) {
	if (!Array.isArray(actors) || !Array.isArray(workerIds) || !(actorOwner instanceof Map))
		throw new TypeError('Actors, workers and actual ownership Map required');
	if (
		workerIds.length === 0 ||
		new Set(workerIds).size !== workerIds.length ||
		workerIds.some((id) => typeof id !== 'string' || !id)
	)
		throw new Error('Invalid worker roster');
	const byId = new Map();
	for (const actor of actors) {
		if (!actor || typeof actor.id !== 'string' || !actor.id || byId.has(actor.id))
			throw new Error('Invalid or duplicate actor');
		byId.set(actor.id, actor);
	}
	if (actorOwner.size !== byId.size) throw new Error('Incomplete actor ownership');
	const parts = new Map(workerIds.map((id) => [id, []]));
	for (const [id, workerId] of actorOwner) {
		const actor = byId.get(id),
			part = parts.get(workerId);
		if (!actor || !part) throw new Error('Unknown actor or worker ownership');
		part.push(actor);
	}
	for (const part of parts.values()) {
		if (
			expectedPerWorker != null &&
			(!Number.isSafeInteger(expectedPerWorker) || expectedPerWorker < 0 || part.length !== expectedPerWorker)
		)
			throw new Error('Per-worker actor count mismatch');
		if (expectedCohorts) {
			const actual = new Map();
			for (const actor of part) actual.set(actor.cohort, (actual.get(actor.cohort) ?? 0) + 1);
			for (const [cohort, count] of Object.entries(expectedCohorts)) {
				if (!Number.isSafeInteger(count) || count < 0 || (actual.get(cohort) ?? 0) !== count)
					throw new Error('Per-worker cohort count mismatch');
				actual.delete(cohort);
			}
			if (actual.size) throw new Error('Unexpected actor cohort');
		}
	}
	return parts;
}
