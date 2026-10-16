# Canonical fixture → isolated Cassandra

`cassandra_fixture.mjs` imports the existing typed PostgreSQL-KV COPY gzip without generating a second dataset. It uses the repository's installed `cassandra-driver` and target schema JSON. It never executes SQL from the gzip, creates accounts, starts services, truncates tables, or resets a keyspace.

## Safety and evidence

- Only loopback hosts and `fluxer_benchmark` / `fluxer_benchmark_<suffix>` keyspaces are accepted. Use an independently isolated, disposable Cassandra process; the name guard alone is not process isolation.
- `schema` requires every existing table in the keyspace to be empty. It creates all 19 UDTs, 190 tables and one index, then verifies names, column types, partition/clustering keys, clustering order, UDT fields and the index. Implicit Cassandra `frozen<UDT>` wrappers are normalized; frozen collection differences are not ignored.
- `import` independently verifies the schema and emptiness of every table, and requires the exact keyspace name again in `--confirm-empty-keyspace`. It rejects unknown/missing source columns, malformed COPY records, source partition/row-key mismatches and manifest count differences.
- Only 32 prepared inserts are outstanding by default (maximum 256). Each scalar, collection and UDT is converted according to the target CQL type. Bigints never pass through JavaScript `Number`. Null non-key fields use the driver's `unset`, avoiding deletion tombstones in an empty keyspace.
- Gzip input and database validation are streamed. RAM use does not grow with the corpus. Disk headroom, importer RSS and Linux host `MemAvailable` are checked regularly. These are supplementary guards: monitor Cassandra/process-tree or cgroup memory separately with the supervisor. `--disk-path` must be on the Cassandra data filesystem if that differs from the seed filesystem.
- Reports contain counts, digests, sample primary keys and resource observations, never row contents or credentials. They are created with mode `0600`, without overwriting existing files. A `.running` marker remains after failure. An incomplete import must be investigated and repeated in an explicitly authorized fresh empty keyspace; this helper will not silently resume or reset it.
- Full `validate` checks first/middle/last point samples, then independently scans every fixture row in bounded pages. It compares each table's exact count and order-independent SHA-256 multiset sum/XOR with the import report, and verifies all non-fixture tables remain empty. Run it **before** bootstrapping or exercising the application, which may legitimately create more rows.
- Canonical digests include every target schema column in schema order. Collections are normalized by type; sets/maps are order-independent. Empty collections and null are treated equivalently because Cassandra may store empty non-frozen collections as null. Target-only columns are expected null. This validates logical content, not raw PostgreSQL/Cassandra physical representation. Multiset digests are collision-resistant checks, not a claim of mathematical proof or a duplicate-key precheck; overwritten duplicate rows cause the subsequent exact database count check to fail.

## Commands

From the repository root, with the dedicated Cassandra process already listening on port 29042:

```sh
node --test tools/benchmark/seed/cassandra_fixture.test.mjs

node tools/benchmark/seed/cassandra_fixture.mjs schema \
  --host 127.0.0.1 --port 29042 --datacenter datacenter1 \
  --keyspace fluxer_benchmark \
  --disk-path /absolute/path/private-benchmark --min-free-gib 4 \
  --output /absolute/path/private-benchmark/cassandra-schema.json

node tools/benchmark/seed/cassandra_fixture.mjs import \
  --host 127.0.0.1 --port 29042 --datacenter datacenter1 \
  --keyspace fluxer_benchmark --confirm-empty-keyspace fluxer_benchmark \
  --seed /absolute/path/private-benchmark/generated/seed.sql.gz \
  --summary /absolute/path/private-benchmark/generated/summary.json \
  --disk-path /absolute/path/private-benchmark --min-free-gib 4 \
  --concurrency 32 --max-rss-mib 768 --min-available-mib 256 \
  --output /absolute/path/private-benchmark/cassandra-import.json

node tools/benchmark/seed/cassandra_fixture.mjs validate \
  --host 127.0.0.1 --port 29042 --datacenter datacenter1 \
  --keyspace fluxer_benchmark \
  --seed /absolute/path/private-benchmark/generated/seed.sql.gz \
  --summary /absolute/path/private-benchmark/generated/summary.json \
  --report /absolute/path/private-benchmark/cassandra-import.json \
  --disk-path /absolute/path/private-benchmark --min-free-gib 4 \
  --fetch-size 1000 \
  --output /absolute/path/private-benchmark/cassandra-validation.json
```

`schema` uses `NetworkTopologyStrategy`, the specified datacenter and replication factor one, appropriate only to the dedicated single-node benchmark. It does not change an existing keyspace's replication settings.

`inspect` is an offline alternative to `import` that parses/converts/digests the entire gzip without connecting to any service. It requires `--seed`, `--summary`, `--output` and the same resource options; no private fixture credentials are required. Its report can also serve as `validate --report` input.

Defaults: host `127.0.0.1`, port `9042`, datacenter `datacenter1`, keyspace `fluxer_benchmark`, concurrency `32`, page size `1000`, driver read timeout `120000` ms, free disk floor `6` GiB, importer RSS ceiling `768` MiB, host available-memory floor `256` MiB. Override intentionally for the supervised environment. Existing report files must use a new output filename on subsequent runs. Optional authentication comes from `CASSANDRA_USERNAME` / `CASSANDRA_PASSWORD` environment variables, never command-line arguments or logs.
