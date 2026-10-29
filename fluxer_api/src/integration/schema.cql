-- 启动集成进程前，在原生 Fluxer Cassandra keyspace 中应用本文件。
-- 每个身份使用独立分区；身份占用不自动过期，也不会被重新分配。
CREATE TABLE IF NOT EXISTS integration_discord_identities (
 discord_user_id text PRIMARY KEY, user_id bigint, operation_id text,
 username text, display_name text, avatar_url text, state text, version int, created_at timestamp
);
CREATE TABLE IF NOT EXISTS integration_user_identities (
 user_id bigint PRIMARY KEY, discord_user_id text
);
CREATE TABLE IF NOT EXISTS integration_identity_history (
 discord_user_id text, version int, user_id bigint, operation_id text, occurred_at timestamp,
 PRIMARY KEY ((discord_user_id), version)
) WITH CLUSTERING ORDER BY (version DESC);
CREATE TABLE IF NOT EXISTS integration_exchanges (
 exchange_id text PRIMARY KEY, fingerprint text, encrypted_token text, user_id bigint, state text, expires_at timestamp
);
