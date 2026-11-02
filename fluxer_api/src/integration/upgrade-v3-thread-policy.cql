-- 既有原生 Fluxer 库在启用外部策略前执行一次，不能由集成 CREATE IF NOT EXISTS 替代。
-- 也可使用更新后的 tools/dev/cassandra_target_schema.json 执行原生 schema apply。
-- 全新原生库使用最新目标 schema 创建后，不重复执行这些 ALTER。
ALTER TABLE thread_state ADD native_locked boolean;
ALTER TABLE thread_state ADD native_archived boolean;
ALTER TABLE thread_state ADD external_locked boolean;
