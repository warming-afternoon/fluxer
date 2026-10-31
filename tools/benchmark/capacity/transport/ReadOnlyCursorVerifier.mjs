// SPDX-License-Identifier: AGPL-3.0-or-later
import {createRequire} from 'node:module';
import {createReadOnlyCursorReader} from '../../VerifyAckCursors.mjs';
/** Concrete Cassandra adapter: explicit connection only, no default host/account/keyspace. */
export function createCursorVerifier({connection, credentials, driver} = {}) {
	const c = connection;
	if (
		!c ||
		!Array.isArray(c.contactPoints) ||
		!c.contactPoints.length ||
		c.contactPoints.some((v) => typeof v !== 'string' || !v) ||
		typeof c.localDataCenter !== 'string' ||
		!c.localDataCenter ||
		typeof c.keyspace !== 'string' ||
		!c.keyspace ||
		!Number.isSafeInteger(c.port) ||
		c.port < 1 ||
		c.port > 65535 ||
		!Number.isSafeInteger(c.maxRows) ||
		c.maxRows < 1 ||
		!Number.isSafeInteger(c.fetchSize) ||
		c.fetchSize < 1 ||
		!Number.isSafeInteger(c.readTimeoutMs) ||
		c.readTimeoutMs < 1 ||
		(c.queryConcurrency !== undefined &&
			(!Number.isSafeInteger(c.queryConcurrency) || c.queryConcurrency < 1 || c.queryConcurrency > 128))
	)
		throw Error('Explicit bounded Cassandra connection required');
	const lib =
		driver ?? createRequire(new URL('../../../../fluxer_api/package.json', import.meta.url))('cassandra-driver');
	return async ({entries, signal}) => {
		if (signal?.aborted) throw Error('Cursor read cancelled');
		let client;
		try {
			client = new lib.Client({
				contactPoints: c.contactPoints,
				localDataCenter: c.localDataCenter,
				keyspace: c.keyspace,
				protocolOptions: {port: c.port},
				socketOptions: {readTimeout: c.readTimeoutMs},
				...(credentials
					? {authProvider: new lib.auth.PlainTextAuthProvider(credentials.username, credentials.password)}
					: {}),
			});
			await client.connect();
			const reader = createReadOnlyCursorReader({
				client,
				types: lib.types,
				maxRows: c.maxRows,
				fetchSize: c.fetchSize,
				queryConcurrency: c.queryConcurrency ?? 1,
				signal,
			});
			const result = await reader(entries);
			if (signal?.aborted) throw Error('cancelled');
			return result;
		} catch {
			throw Error('Read-only cursor verification failed');
		} finally {
			if (client) await client.shutdown().catch(() => {});
		}
	};
}
