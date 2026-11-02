-- 只用于已安装第一版集成 schema 的环境；每条 ALTER 仅执行一次。
-- 全新部署仅执行 schema.cql。升级完成后再执行 schema.cql 创建新增表。
ALTER TABLE integration_user_identities ADD canonical_user_id bigint;
ALTER TABLE integration_user_identities ADD rebind_operation text;
ALTER TABLE integration_user_identities ADD binding_version bigint;
ALTER TABLE integration_user_identities ADD binding_operation text;
CREATE TABLE IF NOT EXISTS integration_event_journal (
 shard int, entry_key text, version bigint, fingerprint text, subject text, payload text,
 PRIMARY KEY ((shard), entry_key)
);
