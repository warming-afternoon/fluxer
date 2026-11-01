# Adaptive guild member pagination

Startup loads use disjoint ranges. Each database page contains at most 1,000 rows, with a 1,001-row query to detect continuation. When existing concurrency configuration enables parallel loading, pages and endpoint probes share at most four slots. Only one probe runs at a time, with at most `slots × 64` probes per load. A probe reads one ascending and one descending ID sequentially within the same range. It never counts members or closes the open root range.

The API reports the first and last database IDs and row count before user mapping. Unknown user references may disappear from mapped output, but the cursor still covers the original database page. The gateway validates ranges, strictly increasing member IDs, counts and cursors, and never publishes a partial result. IDs remain bigint, Erlang integers or decimal strings, never floating-point numbers.

If an old API omits all three coverage fields, the coordinator discards collected chunks and stops remaining tasks before restarting from the open root using the legacy sequential `guild_collection` protocol. Partially missing or malformed coverage fields are errors, not compatibility triggers. Malformed or empty mapped continuation pages on the legacy protocol can still fail explicitly; they do not publish incomplete role indexes.

Probe failures only remove a split hint and preserve paging of the original range. Permanent page errors, exhausted retries, deadlines and caller exit stop the whole load. `members_complete` is published only after every page succeeds. This remains a weakly consistent keyset view: keys inserted behind an already advanced cursor are not guaranteed to appear. It is not a database snapshot.

Upgrade the API/schema before the Gateway. Mixed nodes can fall back safely without equivalent performance guarantees. There is no dependency on observation modules, NIFs or device eligibility caches. Unit tests and simulated SQL checks do not replace live PostgreSQL/Cassandra, rolling-deployment or full-service build verification; see the delivery verification report for this package.
