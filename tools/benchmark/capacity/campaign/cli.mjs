#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {materializeStage} from '../config/StagePlan.mjs';
import {createCampaignConfig} from './CampaignConfig.mjs';

function args(argv) {
	const [mode, ...rest] = argv,
		options = {};
	if (!['validate', 'plan', 'offline-example', 'run'].includes(mode))
		throw Error('Mode required: validate | plan | offline-example | run --live');
	for (let i = 0; i < rest.length; i++) {
		const key = rest[i];
		if (!['--config', '--credentials', '--output', '--attempt', '--live'].includes(key) || Object.hasOwn(options, key))
			throw Error('Unknown or duplicate argument');
		if (key === '--live') options[key] = true;
		else {
			if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw Error('Argument value required');
			options[key] = rest[++i];
		}
	}
	if (mode !== 'run' && options['--live']) throw Error('--live only valid with run');
	return {mode, options};
}
async function json(file) {
	if (!file) throw Error('Explicit input file required');
	const bytes = await readFile(file);
	if (bytes.length >= 20 * 1024 * 1024) throw Error('Input must be below20MB');
	return JSON.parse(bytes);
}
/** No connection is created by validate/plan. run requires deliberate live authorization. */
export async function main(argv = process.argv.slice(2)) {
	const {mode, options} = args(argv);
	if (mode === 'offline-example') {
		if (!options['--output']) throw Error('Explicit offline output root required');
		const {runOfflineExample} = await import('./OfflineExample.mjs');
		const result = await runOfflineExample({
			outputRoot: path.resolve(options['--output']),
			attemptId: options['--attempt'] ?? 'example',
		});
		return {
			mode,
			synthetic: true,
			capacityClaim: false,
			complete: result.result.complete,
			stages: result.result.results.length,
		};
	}
	const configBytes = await readFile(options['--config']);
	if (configBytes.length >= 20 * 1024 * 1024) throw Error('Input must be below20MB');
	const input = JSON.parse(configBytes),
		config = createCampaignConfig(input, {inputSha256: createHash('sha256').update(configBytes).digest('hex')});
	if (mode === 'validate')
		return {
			mode,
			valid: true,
			scope: 'workload and campaign policy only; no runtime, credentials, readiness or performance verified',
			phases: config.capacity.phases.map((p) => p.id),
		};
	if (mode === 'plan') {
		if (!options['--output']) throw Error('Explicit plan output directory required');
		const root = path.resolve(options['--output']);
		await mkdir(root, {mode: 0o700});
		// Planning uses declared ownership only; runtime always replaces this with actual initialized ownership.
		if (!input.actorOwners || Object.keys(input.actorOwners).length !== config.capacity.actors.length)
			throw Error('Explicit actorOwners required for offline plan');
		const actorsByWorker = new Map(config.capacity.workerIds.map((id) => [id, []]));
		for (const actor of config.capacity.actors) {
			const worker = actorsByWorker.get(input.actorOwners[actor.id]);
			if (!worker) throw Error('Invalid declared worker owner');
			worker.push(actor);
		}
		let sequence = BigInt(config.policy.sequenceStart),
			start = 0n;
		for (const phase of config.capacity.phases) {
			const plan = materializeStage(config.capacity, {
				phaseId: phase.id,
				actorsByWorker,
				startNs: start,
				sequenceStart: sequence,
			});
			const bytes = Buffer.from(`${JSON.stringify({planningOnly: true, actualReadinessVerified: false, ...plan})}\n`);
			// Byte chunks concatenate to a JSON document, including split UTF-8 code points.
			for (let offset = 0, index = 0; offset < bytes.length; offset += 16 * 1024 * 1024, index++)
				await writeFile(
					path.join(root, `${phase.id}.${index}.json-part`),
					bytes.subarray(offset, offset + 16 * 1024 * 1024),
					{flag: 'wx', mode: 0o600},
				);
			sequence += BigInt(plan.messages.length);
			start = BigInt(plan.drainEndNs) + BigInt(config.policy.startLeadNs);
		}
		return {mode, planningOnly: true, output: root};
	}
	if (options['--live'] !== true) throw Error('Live execution requires run --live');
	const credentials = await json(options['--credentials']);
	const {createTransportDriver} = await import('../transport/MixedAudienceTransport.mjs');
	const {createCursorVerifier} = await import('../transport/ReadOnlyCursorVerifier.mjs');
	const {createObservationSession} = await import('../observation/ObservationSession.mjs');
	const {createHttpJsonProvider, createNodeProcessProvider} = await import('../observation/Providers.mjs');
	const {runCampaign} = await import('./RunCampaign.mjs');
	const providers = (config.observation.providers ?? []).map((provider) => {
		if (provider.type === 'http-json')
			return createHttpJsonProvider({...provider, headers: credentials.observationHeaders?.[provider.id] ?? {}});
		if (provider.type === 'own-node') return createNodeProcessProvider(provider);
		throw Error('Unknown observation provider type');
	});
	const observation = createObservationSession({
		...config.observation,
		providers,
		limits: config.assessment.resourceLimits,
	});
	const cursorVerifier = createCursorVerifier({
		connection: config.transport.cassandra,
		credentials: credentials.cassandra,
	});
	const driver = createTransportDriver({
		config: config.capacity,
		credentials,
		transport: Object.fromEntries(Object.entries(config.transport).filter(([key]) => key !== 'cassandra')),
		cursorVerifier,
	});
	const abort = new AbortController(),
		onInterrupt = () => abort.abort(Error('Operator interrupt'));
	process.once('SIGINT', onInterrupt);
	process.once('SIGTERM', onInterrupt);
	try {
		const result = await runCampaign({config, driver, observation, signal: abort.signal});
		return {mode, complete: result.complete, performancePassed: result.performancePassed, skipped: result.skipped};
	} finally {
		process.removeListener('SIGINT', onInterrupt);
		process.removeListener('SIGTERM', onInterrupt);
		await observation.close?.();
		await cursorVerifier.close?.();
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main()
		.then((result) => {
			process.stdout.write(`${JSON.stringify(result)}\n`);
			if (result.mode === 'run' && !result.performancePassed) process.exitCode = 2;
		})
		.catch(() => {
			process.stderr.write(
				'Capacity command failed. Inspect private partial artifacts; credentials and endpoint errors are intentionally not printed.\n',
			);
			process.exitCode = 1;
		});
}
