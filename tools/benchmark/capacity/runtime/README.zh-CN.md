# 可移植 worker 运行契约

这些模块按需调用，从补充包已校验索引的 R21 源码抽取通用契约。不是缺失的最终生成版 MixedAudienceCoordinatorMentionsOnlyR22、完整容量 runner、部署工具或新的容量结论。

- JsonLineWorkerPort 保留先登记等待再发送、worker/request 身份和有界等待/帧/写队列；复用既有 probes/ChildJsonLines 的 UTF-8、完整帧和原始 partial 处理。必须注入 onPartial(Buffer) 同步证据持久化回调，不能静默丢弃；回调写盘失败使 completion 失败。同时等待响应和 completion，单个响应之后仍可能出现异常退出。兼容 exit 事件改为 child close 且 stdout/stderr 排空后触发；进程正常收尾不是 WebSocket clean close 证明。
- ThrottledAckQueue 是周期性用户/频道最新游标 ACK 与最终排空，不替换既有三秒 FrontendAckQueue。注入 send 仅可在核实服务端实际持久 ACK 后成功返回，不能仅凭 HTTP 状态。Snowflake 保留十进制字符串和 BigInt 比较。close 返回 drained、failedDuringClose 与脏游标，返回对象不等于成功。maxKeys 默认100000限制保留键数。
- WatchRetryController 抽取实际 worker 的 nonce/cycle/世代校验；匹配 ACK 取消旧重试，包括 timer 已清但回调已入队的竞争。调用者须先校验 ACK 及 lease 内容，本模块不是完整 WS 续租实现。
- orderedActorsByWorker 按 initialize 实际所有权 Map 插入顺序生成索引，不使用凭据顺序；数量/分组期望由参数指定，不写死八 worker/4000 actor。可直接传入 config/StagePlan。

cancel 只向本实例持有的子进程输入发送 EOF 并拒绝等待，不按名称扫描/杀进程或停止容器；不合作的子进程仍需身份绑定的专用停止接口，不能把取消请求说成已经停止。所有模块导入无副作用，无私有身份/地址、WSL 路径、产品观测默认开关。

## 来源及修订

JsonLineWorkerPort 来源是索引中的 future-host/MixedAudienceCoordinatorR20.mjs；最终 R22 offline-contract 明确要求1MiB/15MiB完整帧及真实截断拒绝。本次用已有共享 close/drain 解析器替换 R20 的 exit 提前判定，这是明确的新适配，不冒称已恢复缺失的 R22 生成源码。

ThrottledAckQueue 来源为同名 future-runtime 文件，新增边界和明确结果；WatchRetryController 来源为 MixedAudienceWorker 的 ACK/重试竞争保护，未迁入其私有完整运行器；ActorRoster 来源为同名模块，去除特定场景数量约束。

只运行交付验证目录中的离线正确性夹具。真实 WS、持久 ACK/游标和容量验证仍需单独授权与现场配置。
