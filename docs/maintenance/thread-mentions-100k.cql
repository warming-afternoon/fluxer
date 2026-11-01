-- 此文件是兼容迁移入口。先查看 system_schema.columns，再仅执行缺失列的 ALTER。
-- Cassandra 不支持所有版本通用的 ADD IF NOT EXISTS，因此不要整文件盲目重复执行。
-- 将 <keyspace> 替换为已核实的业务 keyspace；不要修改或删除真实成员/设备订阅。
-- SELECT column_name, type FROM system_schema.columns
-- WHERE keyspace_name = '<keyspace>' AND table_name = 'thread_state';
ALTER TABLE thread_state ADD deleting boolean;
ALTER TABLE thread_state ADD delete_ticket text;
ALTER TABLE thread_state ADD delete_prepared_state_version int;
ALTER TABLE thread_state ADD delete_dispatched boolean;

-- 保留旧 delete_prepared_version bigint 列，禁止 DROP/同名重加。
-- 若该列存在，分页扫描全部 thread_state 行，保存原 thread_id/state_version/
-- deleting/delete_ticket/delete_prepared_version/delete_prepared_state_version。
-- 仅在旧值为精确 int 范围、原票据非空且新值为 null 时执行下列逐行 LWT 模板。
-- 停止旧删除写入并保持读路径可用；每次核实 [applied]，失败重新读取，不强行覆盖。
-- UPDATE thread_state SET delete_prepared_state_version = <original_prepared_int>
-- WHERE thread_id = <original_thread_id>
-- IF state_version = <original_state_version> AND delete_ticket = '<original_ticket>'
-- AND delete_prepared_state_version = null;
-- 新旧值不一致、缺票据、超 int 范围或旧候选已开始 purge 的行必须人工恢复，不能猜值。
-- delete_dispatched 的 null 按 false 解释；禁止为旧候选批量标 true。

CREATE TABLE IF NOT EXISTS thread_message_mention_decisions (
    channel_id bigint,
    message_id bigint,
    decision_text text,
    warnings text,
    PRIMARY KEY ((channel_id), message_id)
);
