# 容量证据审计

本实现按功能提取 R22 的实际收件人、HTTP 供给、ACK 游标、升档和最终产物门禁；
复用现有 `DeliveryAudit` / `mergeSnapshots`，没有另造位图记录器。
导入模块不会联网、启动负载、修改数据库或操作服务。

- 实际位图逐位核对收件人和 padding；检查 run/attempt/scenario、actor 顺序、
  stage 计划摘要、每条消息的 API ID 与实际 WS ID、实际提交时刻及唯一实收总数。
  计划 fanout 不能冒充实收。
- ACK 依据真实请求事件检查合法时隙、完成回执、请求计数和水位。
  中间档允许已完成 ACK ≤ 数据库 ≤ 最新接收（水位查询期间 ACK 可合法前进）；
  最终排空要求接收 = 成功 ACK = 持久化游标。档间不强制排空。
- 缺少证据、采样覆盖或显式阈值时禁止继续；warmup 仅作质量门，不声称稳态容量。
  最终审计要求实际 close 和 final 位图，不将 preview 自动升级为 final。
  未运行的预留档位单独列出；“观察到关连接全过程的所有额外帧”仍为 unknown。
- 供给、积压、延迟、资源和额外线性余量阈值均由 policy 显式传入，
  无历史速率、真实 ID、固定环境 CPU 数或本机路径默认值。
- `ContinuationRules.mjs` 保留原 continuation.v1 的滚动供给与连续欠供给、
  全样本 OLS 积压斜率及 pending-age 连续上升、首末合并直方图、Theil–Sen
  延迟斜率、尾窗抖动、计划提交延迟突发及发生器 CPU/loop 压力规则。
  360 秒 / 六个 60 秒窗与原源码进行逐项结果回归；短窗必须显式配置，
  不假称短测试证明六分钟容量。发生器只计一个真实进程，不将逻辑分区复制成
  独立 CPU 样本；实际区间生成的保守网格包络保留原始证据，不是独立原始采样。
- 只读 Cassandra 分页 SELECT 从原 `VerifyAckCursors.mjs` 抽成共用导出；
  原 CLI 继续复用，驱动延迟加载。明确上限并拒绝重复键、分页环。
  调用方负责明确连接配置与生命周期，不提供 PostgreSQL 或写库适配。
- 原始 ArtifactAudit 源码没有 gzip/CRC 实现，未虚构提取；产物文件复读 SHA
  及分块大小限制由 campaign/ArtifactStore 负责。

完整 API / policy 字段详见同目录 README.md。ZIP 外置测试仅使用合成证据和模拟
Cassandra；未运行真实压测、DB、HTTP/WS 服务或 Windows/WSL 操作。
