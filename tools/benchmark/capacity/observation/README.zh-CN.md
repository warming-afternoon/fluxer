# R22 有界观测

`createObservationSession` 提供 `beginStage(plan)`、`sample()`、`endStage(plan)`、
`cancel()`、`close()`、`setViolationHandler(handler)`。构造不会开始采样；运行器先安装
安全中止回调，再开始阶段。阶段时间必须属于显式声明的本机单调时钟域。

必填参数：`providers`、`intervalMs`、`providerTimeoutMs`、`maxSamples`、
`maxSampleBytes`、`maxTotalBytes`、`maxErrors`、`maxGapNs`、`maxAgeNs`、
`requiredMetrics`、`clockDomain`。`limits:{指标:{max:数值}}` 为显式上限，不携带历史
机器固定阈值。`log` 复用现有有界 `ResourceLog`，默认禁用；结束整个运行后 `close()`。
完整参数及 JSON 字段示例见英文 README。

HTTP JSON provider 为显式 URL 的有界流式只读 GET，禁止重定向，只保存白名单数字，
不保存凭证、URL 或完整响应。`timestampPath`、`sourceClockDomain` 指向真实源采样时间；
`sourceIdentityPath` 与 `expectedSourceIdentity` 核对启动/实例身份。缺少或不匹配只能
作为诊断。接收响应时间不证明源数据新鲜；不同主机单调时钟不能直接相减，也不能通过把
域名字串改成一样伪造同步。跨主机需要另行审核的有界校时适配器，本实现不制造该证明。

已有 MetricHttpClient 适配器只复用调用方拥有的 `read()`，不启动或终止进程；未补充
源时钟证明时仅诊断。Node provider 仅观察当前 Node 进程 RSS/heap、真实 CPU 区间增量
（单核百分比）及实际事件循环直方图。空直方图不生成 p99；不要在首个真实区间前将其
列为必需项。当前进程绝不能代表网关、虚拟机或整机 CPU。

必需指标缺失、采样失败/超时、时钟不明/过期、轮询空洞、超阈值会在阶段运行中调用安全
回调。失败 provider 在该阶段不再重试，避免未完成读取无限堆积。回调用于停止供给，
不会操作任何系统服务。完整结果要求真实覆盖整个正式窗口、全部必需指标新鲜且无错误。
输出保留原始样本、时钟域、形式窗口、覆盖、错误总量及有界错误详情；取消始终不完整。

轮询覆盖仅是离散采样，不等同连续 CPU 区间覆盖。实际区间、启动身份、新鲜度及 CPU
升档证明继续复用 `IntervalCoverage`/`ResourceGuard`；不从仪表瞬时值伪造连续区间。
延迟继续由传输层与 `DeliveryAudit` 的真实收发证据提供，分位桶保留上下界。
原生调度器/NIF 注入、旧 WSL/Docker 操作均排除；缺少能力保持 unknown。

产物复用 campaign 私有/导出目录及 `OfflineEvidence` 的身份与摘要校验；不复制 Docker
文件、不覆盖旧尝试、不压缩不存在的历史源码产物、不控制服务。所有本次验证使用假时钟、
假读取及内存 Response，未执行真实网络或压测。

## 准入安全与物理生成器证据

`beginSafety()` / `endSafety()` 使用同一采样及即时中止机制覆盖登录/连接准入阶段。
结果单独采用 `benchmark.observation-safety.v1`，`safetyOnly:true`，没有正式性能窗口，
不能把准入安全完成写成性能通过；失败取消保留部分安全证据。

仅当该 Node 进程确实承载生成器时，显式设置一个 provider 的 `generatorProcess:true`。
不得用逻辑 actor/worker 分区重复计算同一物理进程 CPU。初始必需安全指标可选真实 CPU/
RSS，不伪造空直方图 p99；正式阶段另检验真实配对 CPU/loop 区间。

`result.generator` 直接复用 `generatorIntervalEnvelope`：实际源区间必须连续无空洞、
无重叠，并覆盖完整正式窗口；区间长度受显式 `maxGapNs` 限制。显式 `intervalMs` 必须
整除正式时长，形成精确网格，每格对重叠真实源区间取保守 CPU/loop 最大值，保留跨窗口
边界的源区间。`rawWorkerIntervals`、带源摘要的 proof 和派生格子均保留。
`monoNs` 为派生格子的中点，并非虚构原始采样时刻；`derivedConservativeEnvelope` 与
proof 明确标记其不是独立原始样本。期望数量来自配置网格，绝不等于观察到多少就期望多少。
覆盖不能证明时 `known:false`；不得将这些保守格子宣称为实测瞬时 CPU 点。
