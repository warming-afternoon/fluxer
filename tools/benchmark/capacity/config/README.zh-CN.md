# 共用容量配置与精确阶段计划

本目录是从补充材料 `R12InputPaths.resolveAttemptOutputPaths` 的路径绑定和索引内 `StaircasePlan.materializeStage` 的整数调度算法抽取的小型可移植适配，不是缺失的 `ConfigurationSourcesMentionsOnlyR*` 或最终 R22 runner。不会读取环境变量、创建目录、连接服务、启动 worker，也不代表获得压测授权。

`createCapacityConfig(input)` 是运行身份、环境标签、绝对输出父目录、worker/actor/author 和阶段列表的唯一输入边界。返回深冻结配置，复制白名单字段，不保留外部可变引用，也不复制 actor 凭据。路径仅派生一次：`outputRoot/runId/attemptId/{record.json,private,out}`。`assertAttemptOutputBinding(config,{recordPath,record})` 核对实际记录的身份及两处输出路径与配置一致。这是词法路径检查；实际打开文件前仍需调用方控制权限与符号链接。

必要参数：

- `runId`、`attemptId`、`environment` 为明确稳定标签；runId 必须是可移植的单层目录名。
- `scenarioSha256` 显式绑定原场景字节的 SHA256，不以新计划哈希冒充来源。
- `outputRoot` 为执行平台上的绝对目录，不内置私有路径。
- `workerIds` 唯一；`actors` 为唯一的 `{id,cohort:'member'|'browser',threadId}`；`authorIds` 只能引用已配置 member，且不重复。
- `phases` 是唯一的 `{id,kind:'warmup'|'steady',durationSeconds,targetFanoutRate,drainNs,ackIntervalMs}`。时长、速率及ACK间隔要求正的安全整数；`drainNs` 接受无符号精确整数字符串、bigint或安全整数，ACK间隔须在定时器范围内。
- `maxMessagesPerStage` 默认100000、最多1000000；actor、worker、phase集合亦有硬上界，防止无限分配。

`materializeStage(config,{phaseId,actorsByWorker,startNs,sequenceStart})` 接受工厂生成的配置和真实 worker 所有权 Map。每个 worker 至少拥有一个actor；配置中的全部actor必须恰好出现一次，cohort和thread不能改变，保留每个worker内部实际顺序。保留原源码的**单帖子阶段模型**，移除4000人、8worker、200作者和固定档位等实验常量。

消息数按 BigInt 精确计算 `(targetFanoutRate * durationSeconds) / recipients`，无法整除或超过分配上限则在创建数组前拒绝。时间为 `start + index * duration / count`，时间与序号始终是十进制字符串，不丢失超过 Number.MAX_SAFE_INTEGER 的值。`plannedHttpRate` 返回精确分子/分母，`plannedUnique` 仅代表计划扇出，不是实收、ACK、持久游标或clean-close证明。`legalAckDrainBetweenLevels:false` 保留连续阶段要求；真实调度器运行与最终排空仍由调用方完成。

没有向目标分支新增测试文件。外部离线测试覆盖大整数、所有权、不可变输入、非法参数、非整数消息数、路径身份和分配边界。
