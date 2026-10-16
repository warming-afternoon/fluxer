import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, rmSync} from 'node:fs';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {copyUnescape, decodeValue, normalizeValue, loadSchema, parseType, convertRow, canonicalRow, schemaStatements, parseArgs, seedRows, driver, normalizedType, sourceMetadata, validateSourceRow} from './cassandra_fixture.mjs';
const schema = loadSchema();
const tagged = (type, value) => ({__fluxer_type: type, value});
const decode = (value, type) => decodeValue(value, parseType(type), schema);
const normalize = (value, type) => normalizeValue(value, parseType(type), schema);

test('COPY escaping is reversed exactly once, preserving JSON and Chinese text', () => {
  const raw = JSON.stringify({text: '中文\n\t\\n\\backslash\r'});
  const escaped = raw.replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r');
  assert.equal(copyUnescape(escaped), raw);
  assert.equal(copyUnescape('a\\011b\\x09c'), 'a\tb\tc');
  assert.throws(() => copyUnescape('\\N'));
});
test('bigints are lossless and reject overflow', () => {
  assert.equal(decode(tagged('bigint', '9223372036854775807'), 'bigint').toString(), '9223372036854775807');
  assert.equal(decode(tagged('bigint', '-9223372036854775808'), 'bigint').toString(), '-9223372036854775808');
  assert.throws(() => decode(tagged('bigint', '9223372036854775808'), 'bigint'));
  assert.throws(() => decode(123, 'bigint'));
  assert.throws(() => decode(tagged('date', '2026-01-01'), 'bigint'));
});
test('timestamp/local date/set/map/UDT decoding matches driver types', () => {
  const date = decode(tagged('date', '2026-10-14T10:00:00.000Z'), 'timestamp');
  assert.equal(date.toISOString(), '2026-10-14T10:00:00.000Z');
  assert.equal(decode(tagged('local_date', '1990-01-01'), 'date').toString(), '1990-01-01');
  const set = decode(tagged('set', [tagged('bigint', '55'), tagged('bigint', '12')]), 'set<bigint>');
  assert(set instanceof Set); assert.deepEqual(normalize(set, 'set<bigint>'), ['12', '55']);
  const map = decode(tagged('map', [[tagged('bigint', '9'), {type: 1, allow_: tagged('bigint', '64'), deny_: tagged('bigint', '0')}]]), 'frozen<map<bigint, permission_overwrite>>');
  assert(map instanceof Map); assert.deepEqual(normalize(map, 'frozen<map<bigint, permission_overwrite>>'), [['9', [1, '64', '0']]]);
  const nested = decode([{title: 'Chinese 中文', fields: [{name: 'a', value: 'b', inline: false}]}], 'frozen<list<message_embed>>');
  assert.equal(nested[0].title, 'Chinese 中文'); assert.equal(nested[0].fields[0].inline, false);
});
test('canonical row equates empty Cassandra collections with null and target-only columns', () => {
  const table = schema.tables.get('users');
  const one = convertRow({user_id: tagged('bigint', '123456789012345678'), traits: tagged('set', [])}, table, schema);
  const two = {...one, traits: null};
  assert.equal(canonicalRow(one, table, schema), canonicalRow(two, table, schema));
  assert.equal(one.has_verified_phone, null);
  assert.throws(() => convertRow({user_id: tagged('bigint', '1'), unknown: false}, table, schema));
  assert.throws(() => convertRow({}, table, schema));
});
test('schema emits all objects with dependencies first and correct primary keys', () => {
  const statements = schemaStatements(schema, 'fluxer_benchmark_test');
  assert.equal(statements.length, schema.tables.size + schema.udts.size + schema.source.indexes.length);
  assert.equal(schema.tables.size, 190); assert.equal(schema.udts.size, 19);
  const before = (first, second) => assert(statements.findIndex(s => s.includes(`."${first}" (`)) < statements.findIndex(s => s.includes(`."${second}" (`)));
  before('mute_config', 'channel_override'); before('message_embed_author', 'message_embed'); before('message_embed_child', 'message_embed');
  assert.deepEqual(schema.tables.get('channels').partition, ['channel_id', 'soft_deleted']);
  assert.deepEqual(schema.tables.get('messages').pk, ['channel_id', 'bucket', 'message_id']);
});
test('CLI refuses non-loopback hosts, unsafe keyspaces and unbounded workers', () => {
  const base = ['schema', '--output', '/tmp/schema-test.json'];
  assert.equal(parseArgs(base).concurrency, 32);
  assert.throws(() => parseArgs([...base, '--host', '10.1.2.3']));
  assert.throws(() => parseArgs([...base, '--keyspace', 'fluxer']));
  assert.throws(() => parseArgs([...base, '--concurrency', '99999']));
  assert.throws(() => parseArgs([...base, '--min-free-gib', '-1']));
});
test('stream parser accepts one COPY block and requires complete gzip and COPY terminator', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'cassandra-fixture-test-'));
  try {
    const file = path.join(temp, 'seed.sql.gz');
    const source = 'BEGIN;\nCOPY fluxer_kv (table_name,partition_key,row_key,row_data) FROM STDIN;\nusers\tkey\tkey\t{"user_id":null}\n\\.\nANALYZE fluxer_kv;\n';
    writeFileSync(file, gzipSync(source)); const state = {}, rows = [];
    for await (const row of seedRows(file, state)) rows.push(row);
    assert.equal(rows.length, 1); assert.equal(rows[0].name, 'users'); assert.equal(state.gzipSha256.length, 64);
    writeFileSync(file, gzipSync(source.replace('\\.\n', '')));
    await assert.rejects(async () => { for await (const _ of seedRows(file, {})) {} });
    writeFileSync(file, gzipSync(source).subarray(0, 25));
    await assert.rejects(async () => { for await (const _ of seedRows(file, {})) {} });
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('Cassandra implicit frozen UDT wrappers compare equivalently, preserving frozen collections', () => {
  const canonical = normalizedType('frozen<map<bigint, permission_overwrite>>', 'fluxer_benchmark', schema);
  assert.equal(normalizedType('frozen<map<bigint, frozen<permission_overwrite>>>', 'fluxer_benchmark', schema), canonical);
  assert.equal(normalizedType('frozen<list<frozen<message_embed>>>', 'fluxer_benchmark', schema), 'frozen<list<message_embed>>');
  assert.notEqual(normalizedType('list<frozen<message_embed>>', 'fluxer_benchmark', schema), 'frozen<list<message_embed>>');
});
test('source metadata enforces exact original columns and serialized COPY keys', () => {
  const metadata = sourceMetadata();
  const table = metadata.get('users_by_email');
  assert.deepEqual(table.pk, ['email_lower', 'user_id']);
  const raw = {email_lower: 'synthetic@benchmark.invalid', user_id: tagged('bigint', '123')};
  const item = {name: 'users_by_email', raw, rowKey: table.pk.map(k => JSON.stringify(raw[k])).join('\x1f'), partitionKey: table.partition.map(k => JSON.stringify(raw[k])).join('\x1f')};
  validateSourceRow(item, metadata);
  assert.throws(() => validateSourceRow({...item, rowKey: 'wrong'}, metadata));
  assert.throws(() => validateSourceRow({...item, raw: {...raw, extra: null}}, metadata));
});

test('offline inspect CLI writes private digest evidence and refuses overwriting it', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'cassandra-inspect-test-'));
  try {
    const seed = path.join(temp, 'seed.sql.gz'), summary = path.join(temp, 'summary.json'), output = path.join(temp, 'inspection.json');
    const metadata = sourceMetadata().get('users_by_email');
    const escape = value => value.replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r');
    const rows = ['11', '22'].map(id => {
      const raw = {email_lower: `synthetic${id}@benchmark.invalid`, user_id: tagged('bigint', id)};
      return ['users_by_email', metadata.partition.map(k => JSON.stringify(raw[k])).join('\x1f'), metadata.pk.map(k => JSON.stringify(raw[k])).join('\x1f'), JSON.stringify(raw)].map(escape).join('\t');
    });
    writeFileSync(seed, gzipSync(`COPY fluxer_kv (table_name,partition_key,row_key,row_data) FROM STDIN;\n${rows.join('\n')}\n\\.\n`));
    writeFileSync(summary, JSON.stringify({seed: 'test', rowCounts: {users_by_email: 2}}));
    const args = [fileURLToPath(new URL('./cassandra_fixture.mjs', import.meta.url)), 'inspect', '--seed', seed, '--summary', summary, '--output', output, '--min-free-gib', '0', '--min-available-mib', '0'];
    const result = spawnSync(process.execPath, args, {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.rows, 2); assert.equal(report.tableDigests.users_by_email.count, 2); assert.equal(report.samples.users_by_email.length, 2);
    assert.equal(report.sourceGzipSha256.length, 64); assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(existsSync(`${output}.running`), false);
    assert.equal(spawnSync(process.execPath, args, {encoding: 'utf8'}).status, 1);
  } finally { rmSync(temp, {recursive: true, force: true}); }
});
