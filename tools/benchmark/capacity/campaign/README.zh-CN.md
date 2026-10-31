# 可配置的连续容量运行链路

本目录将 R22 链路整理为可进入 `test` 的通用工具。它包含实际 HTTP/WebSocket 驱动与只读 Cassandra 游标验证器，但不会部署或停止服务、选择容器、创建账号、更改成员关系，也不会推断运行主机。配置不能加载任意外部代码模块。

## 安全入口与操作顺序

从仓库根目录执行，Node 必须支持原生 WebSocket：

```sh
node tools/benchmark/capacity/campaign/cli.mjs validate --config /explicit/scenario.json
node tools/benchmark/capacity/campaign/cli.mjs plan --config /explicit/scenario.json --output /new/private/plan
node tools/benchmark/capacity/campaign/cli.mjs offline-example --output /new/private/examples --attempt try-1
```

`validate` 检查不可变 V2 负载、运行策略及配置中的生成器采样整除约束，不证明端点、凭据、就绪、观测覆盖或容量。`plan` 还需要 `actorOwners: {actorId: workerId}`，只是声明分配的离线计划，实际运行仍以初始化后的真实所有权为准。计划包含 planning-only 标记；按编号顺序拼接 `.json-part` 后才能解析 JSON。上述命令不建立网络连接。

`offline-example` 使用注入时钟、模拟传输、观测及审计走完三个阶段，仅用于生命周期演示，不是压测通过或容量结论。

只有以下显式授权入口会产生真实流量；本交付未执行该命令：

```sh
node tools/benchmark/capacity/campaign/cli.mjs run --live \
  --config /explicit/scenario.json --credentials /private/credentials.json
```

输出 attempt 目录必须不存在。重跑请更换 `attemptId`，不得复用旧运行状态。实际运行退出码：0 表示所有预留阶段及终稿证据通过；2 表示已关闭连接，但有失败、未知或未运行阶段；1 表示命令或执行失败。SIGINT/SIGTERM 会取消本工具的调度并保留部分证据。CLI 不打印可能含凭据、端点的原始异常文本。

## 配置与凭据

复制 `scenario.template.json` 后逐项修改。示例 ID、端点、场景哈希、时钟证明、阈值均为占位或说明性值，不对应真实部署，不能直接当作已经验证的配置。

顶层字段是 `capacity`、`campaign`、`assessment`、`observation`、`transport`；离线计划另需 `actorOwners`。场景配置不得包含密钥，凭据单独存放。

### 负载与身份：capacity

沿用 `config/CapacityConfig.mjs`：

- `runId`、`attemptId`、`environment`、源 `scenarioSha256`、绝对路径 `outputRoot`。
- 唯一 `workerIds`；`actors: [{id,cohort:'member'|'browser',threadId}]`；`authorIds`；`maxMessagesPerStage` 分配上限。
- `phases: [{id,kind,durationSeconds,targetFanoutRate,drainNs,ackIntervalMs}]`。

必须先有一个 warmup，再有 steady 阶段；全程保持同一 ACK 间隔。单帖子计划根据实际 worker/actor 所有权生成精确整数扇出、连续序号和整数纳秒调度，不以预估接收人数替代真实受众。

`scenarioSha256` 是操作者声明的源绑定，不代表工具自动找到了外部源文件。CLI 另外对实际输入配置文件原始字节计算 SHA256，记录到私有 CONFIG provenance，不引入自引用哈希；程序调用则记录 `JSON.stringify(input)` 的哈希。凭据文件不参与这些哈希，也不写入产物。

### 运行策略：campaign

显式提供 `sequenceStart`（序号，不是时间），以及精确十进制纳秒字段：`startLeadNs`、`maxInterstageGapNs`、`checkpointSettleNs`、`finalAckTimeoutNs`、`failureTailTimeoutNs`、`operationTimeoutNs`。时间必须为正且不超过一天；最终 ACK 超时必须长于合法 ACK 间隔。

阶段间隔从上一阶段 formal end 算起，包括 WS 短排空、检查点、游标、观测、审计与下一阶段提前量。超限即不再是合格的连续运行，不会悄悄重连、重置或重新供给。

### 审计与升档：assessment

显式非负延迟阈值：`maxScheduleLagMs`、`maxHttpLatencyMs`、`maxWsLatencyMs`；非空资源阈值 `resourceLimits: {metricName:{max:number}}`。可选 `nextStageLimits` 仅作额外线性余量筛查，不是容量证明。

`trend` 的窗口、比率与边界字段：`rollingWindowSeconds`、`rollingStepSeconds`、`endpointToleranceMs`、`minSupplyRatio`、`minReceiveRatio`、`minPassingWindowFraction`、`maxShortfallSeconds`、`backlogWindowSeconds`、`maxBacklogSlopeRatio`、`maxBacklogIncreaseSeconds`、`maxPendingAgeMs`、`maxTailMs`、`maxEndBacklogSeconds`、`maxLatencyGrowthRatio`、`maxLatencyGrowthMs`。

源算法的 continuation 配置还包括 `endpointSupplyRatio`、`rollingReceiveRatio`、`latencySlopeMsPerSecond`、`latencyTailJitterMs`、`scheduledLagMaxMs`、`generatorCpuMaxPercent`、`generatorLoopP99MaxMs`、`generatorLoopFraction`、`latencyComparisonWindows`、`latencyTailWindowCount`、`scheduledLagConsecutiveWindows`。模板显式列值；算法兼容值不是已验证的环境安全线。窗口必须适配每个阶段。证据缺失或不足保持 unknown，不能获得继续升档许可。详见 `audit/StageAudit.mjs` 及 continuation 实现。

### 实际传输与只读准入：transport

详见 `../transport/README.md` 和构造器。必须显式给出 API/gateway URL，并发、请求、连接、watch/heartbeat、消息与证据预算。`transport.cassandra` 只传给游标适配器，不混入传输驱动选项；其中 `queryConcurrency` 是有界只读查询并发，模板为 8，并非设备环境推断。

私有凭据文件包含 `actors`（接收者及所需独立 reader 凭据的 ID、token、guildId、ACK 资格声明）、可选 Cassandra 身份验证，以及 `observationHeaders: {providerId: headers}`。

建立 socket 前必须完成权威线程成员列表分页读取和精确集合比较。`credentials.admission` 包含 `readerId`、`threadId`、全部 `expectedFollowerIds`（包括离线 follower）。reader 必须是有权调用该只读接口的 bot 凭据，可与受众分离；不要把该 bot 自动计为接收者。传输配置需 `membershipPageSize` 和 `maxMembershipRows`。member 受众必须在集合内，browser 受众必须不在集合内。缺少证明阻止初始化。工具不会自动配置成员或修复账号。浏览者 ACK 资格仍须显式确认，不能靠更改成员关系取得资格。

### 资源观测与生成器：observation

详见 `../observation/README.md`。CLI provider 类型是 `http-json`、`own-node`，其余字段对应 `createObservationSession`。所需指标、时钟域、源身份、新鲜度、样本数量/大小/总量、采样间隔全部显式配置。

HTTP 指标必须提供源时间戳及同一声明时钟域中的身份证明；本地收到 HTTP 响应的时间不能证明远端数据新鲜。own-node 只观测生成器进程，不代表 gateway、服务器或 VM。

模板明确选择一个 `generatorProcess:true` 的 own-node provider，真实 CPU/事件循环区间用于生成器审计；多个逻辑 worker 不得重复计为多台物理机器。只要配置生成器 provider，就会在运行前验证 `observation.intervalMs` 精确整除每个 `durationSeconds*1000`，own-node 的 `resolutionMs` 必须为正且小于采样间隔。模板提前量留有多个采样周期；自定义提前量也应留出首个有效直方图区间。

`node.loopP99Ms` 不列为初始化必需指标：初始空直方图是未知，不是零。正式阶段仍须通过真实 generator loop/interval 覆盖审计，不宣称已证明初始化 loop。必需指标未知、provider 失败、资源超线、采样间隙等会立即取消正在运行的供给，而不只是阻止下一档。资源日志会在成功和失败路径关闭。

## 完整生命周期

`runCampaign({config,driver,observation,clock?,signal?})` 只初始化一个会话。准入和 socket 初始化前就启动安全观测，初始化完成后保存 safety-only 证据；这段观测不计入正式性能窗口。缺少初始化资源证明不能开始供给。

每阶段依次执行实际所有权计划、观测开始、连续供给、该阶段 WS 排空、检查点、已提交 ACK 的只读游标审计、观测结束与共享阶段审计。阶段之间不强制 ACK 排空。证据包括 HTTP 实际响应、受众位图、逐消息记录、累积合法 ACK 事件、数据库前沿、供给/积压采样、延迟和资源判定。

失败或未知的门槛保留已运行阶段结论，后续阶段标记 `not-run/not-evaluated`，不能伪造为已测容量失败。最终处理是性能窗口外的合法周期 ACK 排空、received/ACK/持久化游标精确比较、真实 clean socket close，再为**每个阶段**单独取得最终检查点。最终检查点、游标和观测从已落盘且经哈希校验的字节重建后复审，不能只审内存对象。preview 不会通过改名变成 final。

`reservedStagesComplete`/`complete` 表示预留阶段是否全部执行；`performancePassed` 另要求全部预览与终稿审计通过。额外余量筛查阻止升档不会抹去此前各档结果。关闭期间额外帧的完整观测仍明确为 unknown。

所有异步操作有超时与中止竞争。安全故障立即取消。如果供给已结束且未出现安全故障，失败路径可先做有界合法尾部排空再取消；运行中或不安全故障则先取消，再保留只读部分尾部证据。尾部成功不能将失败运行提升为通过。外部适配器必须配合 abort/cancel；对不配合的任意外部进程，本工具不会擅自 kill。

## 产物、重跑与范围限制

产物默认私有：`outputRoot/runId/attemptId/private`，目录 0700、文件 0600。可能含账号、线程、消息和完整 follower ID，未经审核不能公开。凭据不写入产物。

大 JSON 按 16 MiB 字节分片，清单记录每片及重建文档 SHA256。`readArtifact(root,ref)` 校验后恢复 Map 与位图字节。成功结束前重新读取验证所有产物，再写清单；失败清单保留已完成部分并明确 partial。每个文件均小于 20 MB。

未带入 Windows/WSL、本机容器身份、真实生产账号、固定环境、旧运行状态或设备资格缓存基础设施。当前是单进程逻辑分区，不冒称验证了多进程/多源 IP 拓扑。源包未包含应用源 IP 审计器，`requireSourceIpProof:true` 会在 I/O 前拒绝，而不是虚构证明。

本交付仅运行离线模拟和审计测试；真实服务兼容性、账号资格、源 IP 分布、Cassandra 权限、资源时钟/启动身份及容量，必须由操作者在明确配置并授权的测试环境中另行验证。未运行实际压测，未操作 Windows/WSL 服务，未自动 push。
