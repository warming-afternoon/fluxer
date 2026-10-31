# 帖子仅提及设备通知与十万关注

帖子消息仅对明确 direct/reply mention 和合格角色候选产生设备 Push。everyone/here 保留显示与 WebSocket 语义，但不触发帖子设备通知或自动加入。普通频道、DM、通话及通知清理契约不变。单角色持有人 3001 时排除该角色；剩余角色去重 union 到 3001 时全部角色不展开。未知索引跳过角色，不影响 direct。原稳定排序、剩余额度和最多 250 角色增补在权限/策略过滤前执行，不补位。最终设备订阅检查保留，不包含设备资格缓存。

私有消息决策持久化于 thread_message_mention_decisions。重试沿用同一决策并复查实际权限，公开 warning 仅含原因码，无人数、名单或 decision。消息与帖子删除同时清理私有决策。

## 兼容 schema 与部署

迁移入口是 thread-mentions-100k.cql，目标 schema 是 tools/dev/cassandra_target_schema.json。先查实际 Cassandra 列，再逐条执行缺列 ALTER，新增 deleting boolean、delete_ticket text、delete_prepared_state_version int、delete_dispatched boolean 及 decision 表。空布尔值按 false 读取。Postgres KV 使用已有通用行存储，不新增专用 SQL 表。最终频道/state 清理使用已有 atomic batch 接口：Cassandra logged batch 或 Postgres 事务；logged batch 不代表跨分区读取隔离。

保留旧 delete_prepared_version bigint，禁止 DROP/同名重加。旧列存在时分页审计全量行，保留原票据和版本，仅将精确 int 范围旧值按 CQL 文件中的 LWT 模板回填空的新列，每次核实 applied，失败重读。新旧值冲突、缺票据、版本越界或旧候选已经部分 purge 的记录需先明确恢复，不能从残缺受众猜测原快照。没有 owner 已处理证据不得将 delete_dispatched 批量置 true。迁移及旧节点排空前保留旧列与旧读写路径。

先兼容 schema，再部署所有 Gateway/API/worker。每个 API/worker 使用稳定独立的 FLUXER_THREAD_MENTION_INSTANCE_ID。Gateway 配置 FLUXER_GATEWAY_THREAD_MENTIONS_ENABLED，并用逗号分隔的 FLUXER_GATEWAY_THREAD_MENTIONS_EXPECTED_API_INSTANCE_IDS / FLUXER_GATEWAY_THREAD_MENTIONS_EXPECTED_WORKER_INSTANCE_IDS 明确完整实例名单；人数配置必须等于无重复名单长度。标识只允许 ASCII 字母、数字、点、下划线、冒号和连字符，长度 1–128。对应 JSON 在 services.gateway.thread_mentions，默认关闭。排空旧 API/worker 后至少等待完整 60 秒 lease，再核实所有活动 Gateway 能力租约和消息字段，最后发布客户端提示。能力不全走有界 direct-only 路径；旧 Gateway 拒绝新的专用帖子 RPC，不能收到旧广播载荷。direct 失败必须报错，不得降级广播。

十万准入常量不是 mentions 开关控制，必须保持新增加入流量排空，直到全部加载和生命周期路径兼容。满员时已有成员加入保持幂等；冷加载使用 1000 条页及逐帖预算，错误不得发布半结果。

## 删除与重启恢复

准备在 guild owner 外按版本与精确人数读取受众，再 CAS 冻结成员并持久化票据/准备版本。API 原 5 秒 RPC 预算保持不变；快照总截止 4 秒，单页至多 2 秒，reserve/install 分别 250/500 ms。超时明确失败，不得继续 purge，也不延长压测超时。

本次区别于输入候选：带票据删除必须由 owner 处理确认后，才清理完整成员、频道与 state。分发前 keeper 丢失/过期可从仍冻结且完整的 DB 关系重建原票据；人数/版本不匹配则失败。owner 确认通过票据已被消费验证，不能把入队成功当成成功。API 以原版本与票据保护写入 delete_dispatched=true。部分清理失败重试时复用该标志，不再重新准备受众。所有辅助清理后，频道与 state 在同一最终 logged batch/事务中删除。guild 级联现在也删除普通频道主行及频道索引。

这是 owner 处理边界的至少一次语义，**不是 exactly-once，也不是设备或 WebSocket 实收 ACK**。owner 处理后、持久标志写入前崩溃可能重复幂等删除事件。没有新增后台恢复扫描器或全局 outbox，失败请求需要重试；既有 relay/session 投递保证不变。旧候选已部分 purge 的记录不会自动修复。

取消归档发起有界成员恢复，精确票据超时消息避免工作进程无声失败后永久卡队列；溢出/失败使用既有完整重载。该流程恢复状态，不承诺每条 WebSocket 事件恰好回放一次。

## 验证与回退

以最终整合 ZIP 验证报告中的实际命令结果为准，历史 WSL 收据不能替代本次验证。离线测试不代表已执行真实 Cassandra/Postgres 迁移、正常 API 十万删除、多节点重启或容量阶梯。

回退先停止新行为和超旧上限加入，保留已有大帖的读取、分页加载、票据/decision、退出与删除能力。禁止截断成员、丢弃票据或恢复 plain 设备广播。存在新版本待处理删除时，不能直接退回旧候选先 purge 后分发实现，需先完成或明确恢复。
