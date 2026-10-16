#!/usr/bin/env node
/** Streaming import of the canonical PostgreSQL COPY fixture into an isolated Cassandra keyspace.
 * No PostgreSQL SQL is executed. No credentials or row contents are written to logs/reports.
 * Commands: schema, inspect (offline), import, validate. See cassandra_fixture.README.md.
 */
import {createReadStream, readFileSync, readdirSync, statfsSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(ROOT, 'fluxer_api/package.json'));
export const driver = require('cassandra-driver');
const GIB = 2 ** 30;
const MIB = 2 ** 20;
const MASK = (1n << 256n) - 1n;
class SafeError extends Error {}
function check(condition, message) { if (!condition) throw new SafeError(message); }
function identifier(value) { check(/^[a-z][a-z0-9_]*$/.test(value), 'Unsafe identifier'); return value; }
function quoted(value) { return `"${identifier(value)}"`; }
function json(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function emit(value) { process.stderr.write(`${JSON.stringify(value)}\n`); }
function save(file, value) { mkdirSync(path.dirname(path.resolve(file)), {recursive: true, mode: 0o700}); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600, flag: 'wx'}); }

export function parseType(text) {
  const source = text.replace(/\s+/g, ''); let i = 0;
  function parse() {
    const match = /^[a-z][a-z0-9_]*/.exec(source.slice(i));
    check(match, 'Invalid target CQL type'); i += match[0].length;
    const node = {name: match[0], args: []};
    if (source[i] === '<') {
      i++;
      for (;;) { node.args.push(parse()); if (source[i] === '>') { i++; break; } check(source[i++] === ',', 'Invalid CQL type arguments'); }
    }
    return node;
  }
  const result = parse(); check(i === source.length, 'Trailing CQL type data'); return result;
}
function plainType(type) { return type.name === 'frozen' ? plainType(type.args[0]) : type; }
export function loadSchema(file = path.join(ROOT, 'tools/dev/cassandra_target_schema.json')) {
  const raw = readFileSync(file); const source = JSON.parse(raw);
  const udts = new Map(source.user_types.map(x => [identifier(x.name), {...x, fields: x.fields.map(c => ({...c, ast: parseType(c.type)}))}]));
  const tables = new Map(source.tables.map(x => {
    identifier(x.name); const pk = x.primary_key.match(/[a-z][a-z0-9_]*/g);
    const partition = /^\(\(([^)]+)\)/.exec(x.primary_key)?.[1].match(/[a-z][a-z0-9_]*/g) ?? [pk[0]];
    return [x.name, {...x, pk, partition, columns: x.columns.map(c => ({...c, ast: parseType(c.type)}))}];
  }));
  return {source, udts, tables, sha256: sha(raw)};
}

export function sourceMetadata() {
  const columns = new Map();
  const dir = path.join(ROOT, 'fluxer_api/src/api/database/types');
  for (const name of readdirSync(dir).filter(n => n.endsWith('.ts'))) {
    const source = readFileSync(path.join(dir, name), 'utf8');
    for (const match of source.matchAll(/export const (\w+_COLUMNS) = \[(.*?)\]/gs)) columns.set(match[1], [...match[2].matchAll(/'([^']+)'/g)].map(m => m[1]));
  }
  const source = readFileSync(path.join(ROOT, 'fluxer_api/src/api/Tables.ts'), 'utf8');
  const tables = new Map();
  const names = text => [...text.matchAll(/'([^']+)'/g)].map(m => m[1]);
  for (const match of source.matchAll(/\(\{\s*name:.*?\n\}\);/gs)) {
    const name = /name: '([^']+)'/.exec(match[0])?.[1];
    const columnName = /columns: (\w+)/.exec(match[0])?.[1];
    const primary = /primaryKey: \[(.*?)\]/s.exec(match[0])?.[1];
    const partition = /partitionKey: \[(.*?)\]/s.exec(match[0])?.[1] ?? primary;
    if (name && columns.has(columnName) && primary) tables.set(name, {columns: columns.get(columnName), pk: names(primary), partition: names(partition)});
  }
  return tables;
}
export function validateSourceRow(item, metadata) {
  const table = metadata.get(item.name); check(table, 'Source table metadata unavailable');
  check(item.raw && typeof item.raw === 'object' && !Array.isArray(item.raw), 'Fixture row is not an object');
  check(Object.keys(item.raw).length === table.columns.length && table.columns.every(c => Object.hasOwn(item.raw, c)), `Source columns differ: ${item.name}`);
  const key = columns => columns.map(c => JSON.stringify(item.raw[c])).join('\x1f');
  check(table.pk.every(c => item.raw[c] != null) && key(table.pk) === item.rowKey && key(table.partition) === item.partitionKey, `Source COPY key mismatch: ${item.name}`);
}

/** Reverse PostgreSQL text COPY escaping once, leaving JSON's own escapes intact. */
export function copyUnescape(value) {
  check(value !== '\\N', 'Null COPY metadata field');
  return value.replace(/\\(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|[\s\S])/g, escaped => {
    const s = escaped.slice(1);
    if (/^[0-7]{1,3}$/.test(s)) return String.fromCharCode(parseInt(s, 8));
    if (/^x[0-9a-fA-F]{1,2}$/.test(s)) return String.fromCharCode(parseInt(s.slice(1), 16));
    return ({b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v'})[s] ?? s;
  });
}
export function decodeValue(value, originalType, schema) {
  if (value == null) return null;
  const type = plainType(originalType);
  if (value && typeof value === 'object' && '__fluxer_type' in value) {
    const expected = {bigint: ['bigint', 'counter', 'varint'], date: ['timestamp'], local_date: ['date'], set: ['set'], map: ['map']};
    check(expected[value.__fluxer_type]?.includes(type.name), 'Typed fixture tag does not match Cassandra schema');
    value = value.value;
  }
  switch (type.name) {
    case 'bigint': case 'counter': {
      check(typeof value === 'string' && /^-?\d+$/.test(value), 'Invalid bigint fixture value');
      const integer = BigInt(value); check(integer >= -(1n << 63n) && integer < (1n << 63n), 'Bigint out of range');
      return driver.types.Long.fromString(value);
    }
    case 'varint': return driver.types.Integer.fromString(value);
    case 'timestamp': { const date = new Date(value); check(Number.isFinite(date.getTime()), 'Invalid timestamp fixture value'); return date; }
    case 'date': check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Invalid local date fixture value'); return driver.types.LocalDate.fromString(value);
    case 'boolean': check(typeof value === 'boolean', 'Invalid boolean fixture value'); return value;
    case 'int': case 'smallint': case 'tinyint': {
      const bits = {int: 32, smallint: 16, tinyint: 8}[type.name];
      check(Number.isSafeInteger(value) && value >= -(2 ** (bits - 1)) && value < 2 ** (bits - 1), 'Invalid integer fixture value'); return value;
    }
    case 'float': case 'double': check(typeof value === 'number' && Number.isFinite(value), 'Invalid floating fixture value'); return value;
    case 'text': case 'ascii': case 'varchar': check(typeof value === 'string', 'Invalid text fixture value'); return value;
    case 'uuid': return driver.types.Uuid.fromString(value);
    case 'timeuuid': return driver.types.TimeUuid.fromString(value);
    case 'set': case 'list': {
      check(Array.isArray(value), 'Invalid collection fixture value');
      const converted = value.map(v => decodeValue(v, type.args[0], schema));
      return type.name === 'set' ? new Set(converted) : converted;
    }
    case 'map': {
      check(Array.isArray(value) || (typeof value === 'object' && value), 'Invalid map fixture value');
      const entries = Array.isArray(value) ? value : Object.entries(value);
      check(entries.every(e => Array.isArray(e) && e.length === 2), 'Invalid map entries');
      return new Map(entries.map(([k, v]) => [decodeValue(k, type.args[0], schema), decodeValue(v, type.args[1], schema)]));
    }
    default: {
      const udt = schema.udts.get(type.name); check(udt, `Unsupported CQL type: ${type.name}`);
      check(value && typeof value === 'object' && !Array.isArray(value), 'Invalid UDT fixture value');
      check(Object.keys(value).every(k => udt.fields.some(f => f.name === k)), 'Unknown UDT field');
      return Object.fromEntries(udt.fields.map(f => [f.name, decodeValue(value[f.name], f.ast, schema)]));
    }
  }
}
/** Canonical schema-ordered representation. Cassandra null/empty collections are equivalent. */
export function normalizeValue(value, originalType, schema) {
  if (value == null) return null;
  const type = plainType(originalType);
  switch (type.name) {
    case 'bigint': case 'counter': case 'varint': case 'date': case 'uuid': case 'timeuuid': return value.toString();
    case 'timestamp': return value.toISOString();
    case 'list': case 'set': {
      const entries = [...value].map(v => normalizeValue(v, type.args[0], schema));
      if (!entries.length) return null;
      if (type.name === 'set') entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return entries;
    }
    case 'map': {
      const entries = [...(value instanceof Map ? value.entries() : Object.entries(value))].map(([k, v]) => [normalizeValue(k, type.args[0], schema), normalizeValue(v, type.args[1], schema)]);
      if (!entries.length) return null;
      entries.sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0]))); return entries;
    }
    default: {
      const udt = schema.udts.get(type.name);
      return udt ? udt.fields.map(f => normalizeValue(value[f.name], f.ast, schema)) : value;
    }
  }
}
export function canonicalRow(row, table, schema) { return JSON.stringify(table.columns.map(c => normalizeValue(row[c.name], c.ast, schema))); }
export function convertRow(raw, table, schema) {
  const columns = new Map(table.columns.map(c => [c.name, c]));
  check(Object.keys(raw).every(k => columns.has(k)), `Unknown fixture column in ${table.name}`);
  const row = Object.fromEntries(table.columns.map(c => [c.name, decodeValue(raw[c.name], c.ast, schema)]));
  check(table.pk.every(k => row[k] != null), `Null primary key in ${table.name}`); return row;
}
class Digests {
  constructor() { this.tables = new Map(); }
  add(name, canonical) {
    const hash = sha(canonical); const number = BigInt(`0x${hash}`);
    const stat = this.tables.get(name) ?? {count: 0, sum: 0n, xor: 0n};
    stat.count++; stat.sum = (stat.sum + number) & MASK; stat.xor ^= number; this.tables.set(name, stat); return hash;
  }
  result() { return Object.fromEntries([...this.tables].sort(([a], [b]) => a.localeCompare(b)).map(([name, s]) => [name, {count: s.count, sumSha256: s.sum.toString(16).padStart(64, '0'), xorSha256: s.xor.toString(16).padStart(64, '0')}])); }
}
export async function* seedRows(file, state) {
  const input = createReadStream(file); const unzip = createGunzip(); const gzipHash = createHash('sha256');
  input.on('data', chunk => gzipHash.update(chunk));
  input.on('error', error => unzip.destroy(error)); input.pipe(unzip);
  const lines = createInterface({input: unzip, crlfDelay: Infinity});
  let streamError; unzip.on('error', error => { streamError = error; lines.close(); });
  let inCopy = false, copies = 0, ended = false, lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      check(line.length < 4 * MIB, 'COPY line exceeds bounded maximum');
      if (line.startsWith('COPY ')) {
        check(/^COPY (fluxer_kv|benchmark_seed_rows) \(table_name,partition_key,row_key,row_data\) FROM STDIN;$/.test(line), 'Unexpected COPY header');
        check(!copies++, 'Multiple COPY blocks are not supported'); inCopy = true; continue;
      }
      if (!inCopy) continue;
      if (line === '\\.') { inCopy = false; ended = true; continue; }
      const parts = line.split('\t'); check(parts.length === 4, `Invalid COPY column count on line ${lineNumber}`);
      const [name, partitionKey, rowKey, raw] = parts.map(copyUnescape);
      identifier(name);
      yield {name, partitionKey, rowKey, raw: JSON.parse(raw)};
    }
    if (streamError) throw new SafeError('Compressed fixture stream failed');
    check(copies === 1 && ended && !inCopy, 'Truncated or missing fixture COPY block');
    state.gzipSha256 = gzipHash.digest('hex');
  } finally { lines.close(); input.destroy(); unzip.destroy(); }
}
function guard(options) {
  const disk = statfsSync(options.diskPath); const freeGiB = Number(disk.bavail) * Number(disk.bsize) / GIB;
  const rssMiB = process.memoryUsage().rss / MIB;
  // 离线检查支持 macOS；数据库导入仍要求 Linux 的可用内存指标。
  const mem = process.platform === 'linux' ? readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m) : null;
  check(process.platform === 'linux' || options.command === 'inspect', 'Database operations require Linux memory protection');
  const availableMiB = mem ? Number(mem[1]) / 1024 : os.freemem() / MIB;
  check(freeGiB >= options.minFreeGiB, 'Minimum disk headroom reached');
  check(rssMiB <= options.maxRssMiB, 'Importer RSS limit reached');
  check(availableMiB == null || availableMiB >= options.minAvailableMiB, 'Minimum host memory headroom reached');
  return {freeGiB: +freeGiB.toFixed(2), rssMiB: +rssMiB.toFixed(1), availableMiB: availableMiB == null ? null : +availableMiB.toFixed(1)};
}
function clientFor(options, useKeyspace = true) {
  return new driver.Client({
    contactPoints: [options.host], localDataCenter: options.datacenter,
    protocolOptions: {port: options.port, maxSchemaAgreementWaitSeconds: 60},
    keyspace: useKeyspace ? options.keyspace : undefined,
    credentials: process.env.CASSANDRA_USERNAME ? {username: process.env.CASSANDRA_USERNAME, password: process.env.CASSANDRA_PASSWORD ?? ''} : undefined,
    encoding: {map: Map, set: Set},
    queryOptions: {consistency: driver.types.consistencies.localOne, isIdempotent: true, readTimeout: options.timeoutMs},
    socketOptions: {connectTimeout: 15000, readTimeout: options.timeoutMs},
    pooling: {coreConnectionsPerHost: {[driver.types.distance.local]: 1, [driver.types.distance.remote]: 0}},
  });
}
export function schemaStatements(schema, keyspace) {
  identifier(keyspace); const result = [], done = new Set(), todo = [...schema.udts.values()];
  while (todo.length) {
    const index = todo.findIndex(t => t.fields.every(f => (f.type.match(/[a-z][a-z0-9_]*/g) ?? []).every(n => !schema.udts.has(n) || done.has(n))));
    check(index >= 0, 'Cyclic UDT dependencies'); const [type] = todo.splice(index, 1);
    result.push(`CREATE TYPE IF NOT EXISTS ${quoted(keyspace)}.${quoted(type.name)} (${type.fields.map(f => `${quoted(f.name)} ${f.type}`).join(', ')})`); done.add(type.name);
  }
  for (const table of schema.tables.values()) {
    result.push(`CREATE TABLE IF NOT EXISTS ${quoted(keyspace)}.${quoted(table.name)} (${table.columns.map(c => `${quoted(c.name)} ${c.type}`).join(', ')}, PRIMARY KEY ${table.primary_key})${table.options ? ` WITH ${table.options}` : ''}`);
  }
  for (const index of schema.source.indexes) result.push(`CREATE INDEX IF NOT EXISTS ${quoted(index.name)} ON ${quoted(keyspace)}.${quoted(index.table)} (${index.expression})`);
  return result;
}
async function schemaState(client, keyspace) {
  const options = {prepare: true};
  const tables = (await client.execute('SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?', [keyspace], options)).rows;
  const columns = (await client.execute('SELECT table_name,column_name,type,kind,position,clustering_order FROM system_schema.columns WHERE keyspace_name = ?', [keyspace], options)).rows;
  const types = (await client.execute('SELECT type_name,field_names,field_types FROM system_schema.types WHERE keyspace_name = ?', [keyspace], options)).rows;
  const indexes = (await client.execute('SELECT index_name,table_name,options FROM system_schema.indexes WHERE keyspace_name = ?', [keyspace], options)).rows;
  return {tables, columns, types, indexes};
}
async function ensureEmpty(client, keyspace, state) {
  for (const table of state.tables) {
    const result = await client.execute(`SELECT * FROM ${quoted(keyspace)}.${quoted(table.table_name)} LIMIT 1`);
    check(!result.rowLength, `Keyspace is not empty: ${table.table_name}; no reset or truncation was performed`);
  }
}
export function normalizedType(type, keyspace, schema) {
  let result = type.replaceAll(`${keyspace}.`, '').replace(/["\s]/g, '').toLowerCase();
  let previous;
  do {
    previous = result;
    for (const name of schema.udts.keys()) result = result.replaceAll(`frozen<${name}>`, name);
  } while (result !== previous);
  return result;
}
async function verifySchema(client, schema, keyspace) {
  const state = await schemaState(client, keyspace);
  check(state.tables.length === schema.tables.size, 'Target table count differs');
  for (const table of schema.tables.values()) {
    const columns = state.columns.filter(c => c.table_name === table.name);
    check(columns.length === table.columns.length, `Column count differs: ${table.name}`);
    for (const column of table.columns) {
      const actual = columns.find(c => c.column_name === column.name);
      check(actual && normalizedType(actual.type, keyspace, schema) === normalizedType(column.type, keyspace, schema), `Column type differs: ${table.name}.${column.name}`);
    }
    const partition = columns.filter(c => c.kind === 'partition_key').sort((a, b) => a.position - b.position).map(c => c.column_name);
    const clustering = columns.filter(c => c.kind === 'clustering').sort((a, b) => a.position - b.position);
    check(JSON.stringify(partition) === JSON.stringify(table.partition), `Partition key differs: ${table.name}`);
    check(JSON.stringify([...partition, ...clustering.map(c => c.column_name)]) === JSON.stringify(table.pk), `Primary key differs: ${table.name}`);
    for (const col of clustering) {
      const descending = new RegExp(`\\b${col.column_name}\\s+DESC\\b`).test(table.options);
      check(col.clustering_order === (descending ? 'desc' : 'asc'), `Clustering order differs: ${table.name}.${col.column_name}`);
    }
  }
  check(state.types.length === schema.udts.size, 'Target UDT count differs');
  for (const type of schema.udts.values()) {
    const actual = state.types.find(t => t.type_name === type.name);
    check(actual && JSON.stringify(actual.field_names) === JSON.stringify(type.fields.map(f => f.name)) && JSON.stringify(actual.field_types.map(t => normalizedType(t, keyspace, schema))) === JSON.stringify(type.fields.map(f => normalizedType(f.type, keyspace, schema))), `UDT differs: ${type.name}`);
  }
  check(state.indexes.length === schema.source.indexes.length, 'Target index count differs');
  for (const index of schema.source.indexes) {
    const actual = state.indexes.find(i => i.index_name === index.name && i.table_name === index.table);
    const target = actual?.options instanceof Map ? actual.options.get('target') : actual?.options?.target;
    check(actual && target?.replaceAll('"', '') === index.expression, 'Target index differs');
  }
  return state;
}
async function applySchema(options, schema) {
  const bootstrap = clientFor(options, false);
  try {
    await bootstrap.connect();
    const existing = await schemaState(bootstrap, options.keyspace);
    check(existing.tables.every(t => schema.tables.has(t.table_name)), 'Unknown table in dedicated keyspace');
    await ensureEmpty(bootstrap, options.keyspace, existing);
    await bootstrap.execute(`CREATE KEYSPACE IF NOT EXISTS ${quoted(options.keyspace)} WITH replication = {'class':'NetworkTopologyStrategy','${identifier(options.datacenter)}':1}`);
  } finally { await bootstrap.shutdown(); }
  // A fresh keyspace-bound client resolves all unqualified nested UDT names consistently.
  const client = clientFor(options);
  try {
    await client.connect();
    for (const statement of schemaStatements(schema, options.keyspace)) { guard(options); await client.execute(statement); }
    await verifySchema(client, schema, options.keyspace);
    return {ok: true, command: 'schema', keyspace: options.keyspace, targetSchemaSha256: schema.sha256, userTypes: schema.udts.size, tables: schema.tables.size, indexes: schema.source.indexes.length};
  } finally { await client.shutdown(); }
}

function validateSummary(summary, schema) {
  check(summary?.rowCounts && typeof summary.rowCounts === 'object', 'Missing fixture rowCounts');
  for (const [name, count] of Object.entries(summary.rowCounts)) {
    check(schema.tables.has(name) && Number.isSafeInteger(count) && count > 0, 'Unknown table or invalid row count in summary');
  }
}
async function consume(options, schema, summary, client) {
  const digests = new Digests(), streamState = {}, samples = {}, prepared = new Map(), pending = new Set();
  const metadata = sourceMetadata();
  let failure = null, total = 0, inserted = 0; const started = Date.now();
  const expectedTotal = Object.values(summary.rowCounts).reduce((a, b) => a + b, 0);
  const initial = guard(options); emit({stage: client ? 'import_start' : 'inspect_start', expectedRows: expectedTotal, concurrency: client ? options.concurrency : 0, ...initial});
  const timer = setInterval(() => {
    try { emit({stage: client ? 'import' : 'inspect', rows: total, acknowledged: inserted, expectedRows: expectedTotal, elapsedSeconds: +((Date.now() - started) / 1000).toFixed(1), ...guard(options)}); }
    catch (error) { failure ??= error; }
  }, 15000);
  try {
    for await (const item of seedRows(options.seed, streamState)) {
      if (failure) throw failure;
      const table = schema.tables.get(item.name); check(table && summary.rowCounts[item.name], 'Fixture table missing from schema/summary');
      validateSourceRow(item, metadata);
      const row = convertRow(item.raw, table, schema);
      const canonical = canonicalRow(row, table, schema); const digest = digests.add(item.name, canonical);
      const count = digests.tables.get(item.name).count;
      check(count <= summary.rowCounts[item.name], `Fixture has excess rows: ${item.name}`);
      if (count === 1 || count === Math.ceil(summary.rowCounts[item.name] / 2) || count === summary.rowCounts[item.name]) {
        (samples[item.name] ??= []).push({ordinal: count, primaryKey: table.pk.map(k => normalizeValue(row[k], table.columns.find(c => c.name === k).ast, schema)), sha256: digest});
      }
      total++; if (total % 1000 === 0) guard(options);
      if (!client) continue;
      if (!prepared.has(item.name)) prepared.set(item.name, `INSERT INTO ${quoted(options.keyspace)}.${quoted(item.name)} (${table.columns.map(c => quoted(c.name)).join(',')}) VALUES (${table.columns.map(() => '?').join(',')})`);
      let request;
      request = client.execute(prepared.get(item.name), table.columns.map(c => row[c.name] == null && !table.pk.includes(c.name) ? driver.types.unset : row[c.name]), {prepare: true, isIdempotent: true})
        .then(() => { inserted++; }, error => { failure ??= new SafeError(`Insert failed in ${item.name} (${error.name}, code ${error.code ?? 'none'}); partial import requires a fresh empty keyspace`); })
        .finally(() => pending.delete(request));
      pending.add(request);
      if (pending.size >= options.concurrency) await Promise.race(pending);
    }
    await Promise.all(pending); if (failure) throw failure;
    check(total === expectedTotal, 'Fixture total does not match summary');
    const results = digests.result();
    for (const [name, count] of Object.entries(summary.rowCounts)) check(results[name]?.count === count, `Fixture row count mismatch: ${name}`);
    return {ok: true, command: client ? 'import' : 'inspect', keyspace: client ? options.keyspace : null, seed: summary.seed, targetSchemaSha256: schema.sha256, sourceGzipSha256: streamState.gzipSha256, digest: 'schema-ordered normalized rows; SHA-256 multiset sum modulo 2^256 and XOR; empty collections equal null', rows: total, acknowledged: inserted, elapsedSeconds: +((Date.now() - started) / 1000).toFixed(3), tableDigests: results, samples, resources: guard(options), createdAt: new Date().toISOString()};
  } finally { clearInterval(timer); await Promise.all(pending); }
}
async function importFixture(options, schema, summary) {
  check(options.confirmEmptyKeyspace === options.keyspace, 'Import requires --confirm-empty-keyspace equal to --keyspace');
  const client = clientFor(options);
  try {
    await client.connect(); const state = await verifySchema(client, schema, options.keyspace); await ensureEmpty(client, options.keyspace, state);
    return await consume(options, schema, summary, client);
  } finally { await client.shutdown(); }
}
async function validateFixture(options, schema, summary) {
  check(options.report, 'Validate requires --report from import or inspect');
  const expected = json(options.report);
  check(expected.ok && expected.targetSchemaSha256 === schema.sha256 && expected.seed === summary.seed, 'Report schema or seed mismatch');
  check(expected.keyspace == null || expected.keyspace === options.keyspace, 'Report keyspace mismatch');
  for (const [name, count] of Object.entries(summary.rowCounts)) check(expected.tableDigests?.[name]?.count === count, 'Report row counts differ from summary');
  const client = clientFor(options), digests = new Digests(); let sampleChecks = 0, total = 0; const started = Date.now();
  try {
    await client.connect(); await verifySchema(client, schema, options.keyspace);
    // Read back complete rows by full primary key, including fields omitted in the input.
    for (const [name, samples] of Object.entries(expected.samples)) {
      const table = schema.tables.get(name); check(table, 'Unknown report sample table');
      const query = `SELECT * FROM ${quoted(options.keyspace)}.${quoted(name)} WHERE ${table.pk.map(k => `${quoted(k)} = ?`).join(' AND ')}`;
      for (const sample of samples) {
        const params = sample.primaryKey.map((value, i) => decodeValue(value, table.columns.find(c => c.name === table.pk[i]).ast, schema));
        const result = await client.execute(query, params, {prepare: true});
        check(result.rowLength === 1 && sha(canonicalRow(result.first(), table, schema)) === sample.sha256, `Sample readback mismatch: ${name}`); sampleChecks++;
      }
    }
    emit({stage: 'samples_verified', samples: sampleChecks});
    for (const [name, table] of schema.tables) {
      guard(options);
      if (!summary.rowCounts[name]) {
        check(!(await client.execute(`SELECT * FROM ${quoted(options.keyspace)}.${quoted(name)} LIMIT 1`)).rowLength, `Unexpected non-fixture table data: ${name}`); continue;
      }
      let pageState; let tableRows = 0;
      do {
        const result = await client.execute(`SELECT * FROM ${quoted(options.keyspace)}.${quoted(name)}`, [], {fetchSize: options.fetchSize, pageState, autoPage: false});
        for (const row of result.rows) { digests.add(name, canonicalRow(row, table, schema)); total++; tableRows++; }
        pageState = result.pageState; guard(options);
        if (tableRows % (options.fetchSize * 20) === 0) emit({stage: 'validate_scan', table: name, rows: tableRows, totalRows: total, ...guard(options)});
      } while (pageState);
      const actual = digests.result()[name];
      check(JSON.stringify(actual) === JSON.stringify(expected.tableDigests[name]), `Full-scan count/content digest mismatch: ${name}`);
      emit({stage: 'table_verified', table: name, rows: tableRows});
    }
    check(total === expected.rows, 'Full-scan total mismatch');
    return {ok: true, command: 'validate', keyspace: options.keyspace, seed: summary.seed, targetSchemaSha256: schema.sha256, sourceGzipSha256: expected.sourceGzipSha256, rows: total, samplesVerified: sampleChecks, emptyNonFixtureTables: schema.tables.size - Object.keys(summary.rowCounts).length, tableDigests: digests.result(), elapsedSeconds: +((Date.now() - started) / 1000).toFixed(3), resources: guard(options), createdAt: new Date().toISOString()};
  } finally { await client.shutdown(); }
}
export function parseArgs(args) {
  const options = {command: args[0], host: '127.0.0.1', port: 9042, datacenter: 'datacenter1', keyspace: 'fluxer_benchmark', concurrency: 32, timeoutMs: 120000, fetchSize: 1000, minFreeGiB: 6, maxRssMiB: 768, minAvailableMiB: 256};
  const mapping = {'--host': 'host', '--port': 'port', '--datacenter': 'datacenter', '--keyspace': 'keyspace', '--concurrency': 'concurrency', '--timeout-ms': 'timeoutMs', '--fetch-size': 'fetchSize', '--min-free-gib': 'minFreeGiB', '--max-rss-mib': 'maxRssMiB', '--min-available-mib': 'minAvailableMiB', '--disk-path': 'diskPath', '--seed': 'seed', '--summary': 'summary', '--output': 'output', '--report': 'report', '--confirm-empty-keyspace': 'confirmEmptyKeyspace'};
  check(['schema', 'inspect', 'import', 'validate'].includes(options.command), 'Command must be schema, inspect, import, or validate');
  for (let i = 1; i < args.length; i += 2) { const key = mapping[args[i]]; check(key && args[i + 1] != null, 'Unknown or missing command argument'); options[key] = typeof options[key] === 'number' ? Number(args[i + 1]) : args[i + 1]; }
  check(['127.0.0.1', 'localhost', '::1'].includes(options.host), 'Only a loopback isolated Cassandra instance is supported');
  check(/^fluxer_benchmark(?:_[a-z0-9_]+)?$/.test(options.keyspace) && options.keyspace.length <= 48, 'Keyspace must be fluxer_benchmark or fluxer_benchmark_<suffix>, up to 48 characters');
  identifier(options.datacenter);
  for (const key of ['port', 'concurrency', 'timeoutMs', 'fetchSize', 'maxRssMiB']) check(Number.isSafeInteger(options[key]) && options[key] > 0, `Invalid ${key}`);
  for (const key of ['minFreeGiB', 'minAvailableMiB']) check(Number.isFinite(options[key]) && options[key] >= 0, `Invalid ${key}`);
  check(options.port <= 65535 && options.concurrency <= 256 && options.fetchSize <= 10000, 'Unsafe port/concurrency/fetch-size bound');
  if (options.command !== 'schema') check(options.seed && options.summary, 'Command requires --seed and --summary');
  options.diskPath ??= path.dirname(path.resolve(options.seed ?? '.'));
  check(options.output, 'Command requires --output; existing reports are never overwritten');
  return options;
}
export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args); const schema = loadSchema(); guard(options);
  // Reserve output before any database mutation; never silently replace another run's evidence.
  const reservation = `${options.output}.running`;
  const fs = await import('node:fs'); check(!fs.existsSync(options.output) && !fs.existsSync(reservation), 'Output or running reservation already exists');
  save(reservation, {command: options.command, keyspace: options.keyspace, startedAt: new Date().toISOString()});
  let result;
  try {
    if (options.command === 'schema') result = await applySchema(options, schema);
    else {
      const summary = json(options.summary); validateSummary(summary, schema);
      if (options.command === 'inspect') result = await consume(options, schema, summary, null);
      if (options.command === 'import') result = await importFixture(options, schema, summary);
      if (options.command === 'validate') result = await validateFixture(options, schema, summary);
    }
    save(options.output, result); fs.unlinkSync(reservation);
    process.stdout.write(`${JSON.stringify({ok: true, command: result.command, rows: result.rows, samplesVerified: result.samplesVerified, report: path.resolve(options.output)})}\n`);
  } catch (error) {
    // Keep the .running marker as evidence of incomplete execution; never auto-reset a database.
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    emit({ok: false, error: error instanceof SafeError ? error.message : `${error.name ?? 'Error'} (details suppressed to protect fixture contents and credentials)`}); process.exitCode = 1;
  });
}
