# Clear batch transport (disabled by default)

The Gateway `services.gateway.clear_batch_enabled` / `FLUXER_GATEWAY_CLEAR_BATCH_ENABLED` sender and Push `FLUXER_PUSH_CLEAR_BATCH_ENABLED` receiver must be configured explicitly. Roll out receiver support first to **every** member of the `push.job.clear` NATS queue group, then enable senders. Disable senders and drain outstanding batches before rolling back receiver support. Mixed enabled/disabled receivers cause rejected requests and retries, not silent success; there is no compatibility fallback that can acknowledge an unprocessed item.

Version 1 requests remain supported. Version 2 groups at most 32 contiguous clear entries, waits at most 5ms, and preserves each original user/channel/message/after-message frontier and stable item identity through retries. A message/ring entry is a FIFO grouping barrier. Gateway in-flight 96 and Push queue capacity count logical entries, not envelopes. Every outcome must match exactly one original item. Missing, duplicate, failed, timed-out or unversioned replies retry the affected item(s); successful siblings remain settled. The existing expiry/backoff and after-message followup rules apply.

This is transport grouping and lookup reuse, not semantic cursor coalescing or durable delivery. Gateway queues and Push completion deduplication remain process memory. Restart/loss guarantees are unchanged. No task shedding, limit increase, CAS change, subscription-batcher concurrency change, or read frontier widening is introduced.

For benchmarking, all five variants use the same product build and config except the explicit B/C/D switches, with receiver and sender D switches toggled together. Permission/directory browsing subscriptions remain part of the product source. Unit/provider/NATS correctness gates and measured no-loss audit are required before choosing a production default.

Deploy these changes using container/process restart. This version does not migrate in-memory outbox entries during an OTP live-code upgrade; do not enable batching on an already-running pre-upgrade queue.
