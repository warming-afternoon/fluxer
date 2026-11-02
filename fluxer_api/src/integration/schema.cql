-- 启动集成进程前，在原生 Fluxer Cassandra keyspace 中应用本文件。
-- 每个身份使用独立分区；身份占用不自动过期，也不会被重新分配。
CREATE TABLE IF NOT EXISTS integration_discord_identities (
 discord_user_id text PRIMARY KEY, user_id bigint, operation_id text,
 username text, display_name text, avatar_url text, state text, version int, created_at timestamp
);
CREATE TABLE IF NOT EXISTS integration_user_identities (
 user_id bigint PRIMARY KEY, discord_user_id text, canonical_user_id bigint, rebind_operation text, binding_version bigint, binding_operation text
);
CREATE TABLE IF NOT EXISTS integration_identity_history (
 discord_user_id text, version int, user_id bigint, operation_id text, occurred_at timestamp,
 PRIMARY KEY ((discord_user_id), version)
) WITH CLUSTERING ORDER BY (version DESC);
CREATE TABLE IF NOT EXISTS integration_exchanges (
 exchange_id text PRIMARY KEY, fingerprint text, encrypted_token text, user_id bigint, state text, expires_at timestamp
);
-- 共用操作日志承载恢复上下文与永久幂等结果，不保存原始令牌。
CREATE TABLE IF NOT EXISTS integration_operations (
 operation_id text PRIMARY KEY, fingerprint text, actor_id bigint,
 payload text, result text, resource_owner text
);
-- 原生 thread 通用策略，user_id=0 代表 thread 级外部锁，其余为用户发言处罚。
CREATE TABLE IF NOT EXISTS thread_external_policies (
 thread_id bigint, user_id bigint, source text, kind text, active boolean,
 version bigint, expires_at timestamp,
 PRIMARY KEY ((thread_id), user_id, source)
);
-- 分片日志同时保存资源跟踪、独立快照版本与待发事件；无 TTL，收到 PubAck 后删除 p: 行。
CREATE TABLE IF NOT EXISTS integration_event_journal (
 shard int, entry_key text, version bigint, fingerprint text, subject text, payload text,
 PRIMARY KEY ((shard), entry_key)
);
