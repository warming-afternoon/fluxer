# Metric subprocess output contract

`metrics-probe.mjs`, `push-metrics-probe.mjs`, and `gateway-probe.mjs` collect newline-delimited JSON using `ChildJsonLines.mjs`. Tail validation happens only after the child's `close` event. An `exit` event does not mean that stdout has drained.

Each record must be valid UTF-8 containing a JSON object terminated by a newline, with a default limit of 16 MiB per record. Complete records append to the existing JSONL file. Truncation, invalid records, output-write failures, nonzero child exit codes, and termination signals fail the probe. Invalid or incomplete records are retained in the corresponding `.partial` file; errors append to `.errors.jsonl`. Oversized records are streamed to the partial sink instead of accumulating without bounds in memory. Output paths and instance identity continue to use the explicit environment settings in `environment.mjs`. No automatic startup or production instrumentation is added.

This contract verifies only the metric collector's output pipes. It does not establish clean application WebSocket closure, durable ACKs, cursor equality, or capacity success. Child exit or container shutdown must not be reported as a clean client close.

This change addresses code found in the existing test branch: two probes exited immediately on child `exit`, while another swallowed parsing failures. The supplied package lacks the final capacity runner, finish-contract, and offline-contract sources. This collector is not a port of those tools and does not claim their gzip/CRC, actor ordering, stage-artifact identity, or fixed ring frontier checks.
