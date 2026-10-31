// SPDX-License-Identifier: AGPL-3.0-or-later
import {createHash} from 'node:crypto';
import {createCapacityConfig, parseExactUnsigned} from '../config/CapacityConfig.mjs';

/** Campaign policy is separate from the immutable V2 workload configuration. */
export function createCampaignConfig(input, {inputSha256} = {}) {
	const provenance = {
		sha256: inputSha256 ?? createHash('sha256').update(JSON.stringify(input)).digest('hex'),
		encoding: inputSha256 ? 'source-file-bytes' : 'JSON.stringify(input)',
	};
	if (!/^[a-f0-9]{64}$/.test(provenance.sha256)) throw Error('Invalid configuration provenance hash');
	if (input.transport?.requireSourceIpProof === true)
		throw Error('Required application source-IP proof is unsupported by available source');
	const capacity = createCapacityConfig(input.capacity);
	const generators = (input.observation?.providers ?? []).filter((provider) => provider.generatorProcess === true);
	if (generators.length) {
		const interval = input.observation.intervalMs;
		if (
			!Number.isSafeInteger(interval) ||
			interval <= 0 ||
			capacity.phases.some((p) => (BigInt(p.durationSeconds) * 1000n) % BigInt(interval) !== 0n)
		)
			throw Error('Generator sampling interval must divide every phase duration');
		if (
			generators.some(
				(p) =>
					p.type === 'own-node' &&
					(!Number.isSafeInteger(p.resolutionMs) || p.resolutionMs <= 0 || p.resolutionMs >= interval),
			)
		)
			throw Error('Generator histogram resolution must be positive and below sampling interval');
	}
	const source = input.campaign;
	if (!source || typeof source !== 'object') throw Error('Explicit campaign policy required');
	const duration = (key) => {
		const value = parseExactUnsigned(source[key], key);
		if (value <= 0n || value > 86400000000000n) throw Error(`${key} must be positive and at most one day`);
		return String(value);
	};
	const policy = Object.freeze({
		sequenceStart: String(parseExactUnsigned(source.sequenceStart, 'sequenceStart')),
		startLeadNs: duration('startLeadNs'),
		maxInterstageGapNs: duration('maxInterstageGapNs'),
		checkpointSettleNs: duration('checkpointSettleNs'),
		finalAckTimeoutNs: duration('finalAckTimeoutNs'),
		failureTailTimeoutNs: duration('failureTailTimeoutNs'),
		operationTimeoutNs: duration('operationTimeoutNs'),
	});
	if (BigInt(policy.startLeadNs) + BigInt(policy.checkpointSettleNs) >= BigInt(policy.maxInterstageGapNs))
		throw Error('Interstage gap must allow start lead and checkpoint settling');
	if (capacity.phases[0].kind !== 'warmup' || capacity.phases.slice(1).some((p) => p.kind !== 'steady'))
		throw Error('A campaign requires one initial warmup followed by steady stages');
	if (capacity.phases.length < 2) throw Error('At least one steady stage required');
	if (new Set(capacity.phases.map((p) => p.ackIntervalMs)).size !== 1)
		throw Error('Continuous campaign must preserve one ACK interval');
	if (BigInt(policy.finalAckTimeoutNs) <= BigInt(capacity.phases[0].ackIntervalMs) * 1000000n)
		throw Error('Final ACK timeout must exceed the legal ACK interval');
	if (!input.assessment || typeof input.assessment !== 'object') throw Error('Explicit assessment policy required');
	return Object.freeze({
		provenance: Object.freeze(provenance),
		capacity,
		policy,
		assessment: structuredClone(input.assessment),
		observation: structuredClone(input.observation ?? {}),
		transport: structuredClone(input.transport ?? {}),
	});
}
