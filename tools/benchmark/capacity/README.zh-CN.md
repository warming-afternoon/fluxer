# 可移植容量工具模块

这里是经过筛选、参数化的**工具库**，不是完整历史 R22 coordinator，也不是一条可直接启动压测的命令。导入模块不会启动监控、连接服务、修改网络、停止进程或生成负载。既有 `tools/benchmark` 的语料、ACK/游标、HTTP helper 保留，不重复搬运部署流程。

## 单一配置入口

先用 `config/CapacityConfig.mjs` 生成一个不可变配置，再把相同字段传给各层。场景字节/hash、run/attempt/environment、worker/actor所有权、输出目录和阶段列表不应分别手填到生成脚本。下面只生成离线计划，不建立目录或运行负载；真实运行的所有权 Map 必须来自实际成功初始化，不能替换为凭据文件顺序。

```js
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createCapacityConfig} from './config/CapacityConfig.mjs';
import {materializeStage} from './config/StagePlan.mjs';
import {orderedActorsByWorker} from './runtime/ActorRoster.mjs';
import {deriveArtifactDirectory} from './evidence/ArtifactIdentity.mjs';
import {openResourceLog} from './guards/ResourceLog.mjs';

const scenario = {
  workerIds: ['worker-a'],
  actors: [{id: 'actor-a', cohort: 'member', threadId: 'thread-a'}],
  authorIds: ['actor-a'],
  phases: [{id: 'phase-a', kind: 'steady', durationSeconds: 1,
    targetFanoutRate: 1, drainNs: '1000000000', ackIntervalMs: 120000}],
};
const scenarioBytes = Buffer.from(JSON.stringify(scenario));
const config = createCapacityConfig({...scenario, runId: 'offline-example',
  attemptId: 'attempt-a', environment: 'offline', outputRoot: path.resolve('results'),
  scenarioSha256: createHash('sha256').update(scenarioBytes).digest('hex'),
  maxMessagesPerStage: 100});
const actualOwnership = new Map([['actor-a', 'worker-a']]); // 仅为离线示例的合成所有权。
const roster = orderedActorsByWorker(config.actors, config.workerIds, actualOwnership);
const plan = materializeStage(config, {phaseId: config.phases[0].id,
  actorsByWorker: roster, startNs: '9007199254740993000', sequenceStart: '9007199254740993001'});
const identity = {runId: config.runId, attemptId: config.attemptId,
  stageId: plan.stageId, scenarioSha256: config.scenarioSha256,
  artifactKind: 'preview', visibility: 'private'};
const previewDirectory = deriveArtifactDirectory(config.paths.baseRoot, identity);
const disabledLog = openResourceLog({enabled: false});
console.log({plannedUnique: plan.plannedUnique, previewDirectory});
```

`config.paths.outRoot` 是 `outputRoot/runId/attemptId`，record/private/out路径由此派生；阶段工件通过 `deriveArtifactDirectory` 再明确阶段、输出域和预览/终稿身份。`scenarioSha256` 必须来自实际场景字节，配置工厂不自行读取或认证原始文件。实际文件权限和符号链接防护由打开路径的一方负责。

## 各层接口

- **配置与精确计划：** `createCapacityConfig`、`assertAttemptOutputBinding`、`materializeStage`。严格精确整数、有界分配、真实所有权，无固定八worker/4000受众/档位假设。计划保持单帖子模型；`plannedUnique` 永远是计划扇出，不是实收证明。
- **worker/ACK/watch：** `JsonLineWorkerPort` 必须显式传入子进程命令和partial原始字节保存函数，同时核对响应及 `completion` 结果。stdio排空、进程close不等于WebSocket clean close。`ThrottledAckQueue` 的send必须在真实权威ACK成功后才resolve；最终阶段调用 `close()` 并核对排空/失败。`WatchRetryController` 只接受当前nonce/cycle的已验证ACK来取消过时retry。实际连接服务前先阅读runtime示例。
- **证据：** `DeliveryAudit` 接受同一worker受众映射为 `{id,cohort,channelIds:[threadId]}`、精确消息计划和边界。记录实际测得的 `record` 事件，导出 `exportBitmap` 并 `finalize`，再以完整配置worker/actor清单和真实位图字节调用 `mergeSnapshots` 校验；`checkpoint` 只是预览。`ArtifactIdentity`/`OfflineEvidence` 区分run/attempt/stage/来源hash、private/out、preview/final，显式创建副本失败保留partial。它们不证明持久ACK、数据库游标或WS关闭；既有游标验证工具仍按自己的实库契约单独使用。
- **资源与所有权：** `generatorIntervalEnvelope` 使用同一 `config.workerIds` 和显式实测区间。`assertFreshResourceSample` 需要真实boot/进程身份、单调时间与调用方阈值；`assessHeadroom` 仅在原质量、实收及WS条件都通过后附加保守余量筛查。`openResourceLog` 默认关闭，显式启用后才按预算追加。`stopOwnedProcess` 要求身份绑定的平台句柄适配器，不提供PID-only/通配kill，也没有内置原生进程句柄适配器。另有显式 `stopOwnedContainers` Docker完整ID适配，先核对身份；宽限期后可能强制终止，不能当作WS关闭证据。

所有真实操作仍由调用方明确执行。计划存在、监控进程退出或传入 `complete:true`，都不会在本库里自动成为“阶段已经完成”的证明。

## 来源与残余缺项

补充包的R21执行源码索引完整，通用算法从对应源码逐项抽取。R22 `offline-contract.mjs` 明确1MiB/15MiB终帧完整及真实截断拒绝；worker端口按该规则修正和测试，没有执行原字符串改写/部署脚本。R22 `finish-contract.mjs` 的额外保守余量规则被参数化，不保留机器档位阈值。

仍缺最终生成的 `MixedAudienceCoordinatorMentionsOnlyR22.mjs`、`run-staircase-diagnostics-r22.mjs`、`ConfigurationSourcesMentionsOnlyR*`及相关runner闭包、包含fixed-written-ring读取器的最终analysis源码、逐值流式压缩恢复/CRC实现。原始位图审计**不冒充**这些缺失工具。clock-52的Windows/WSL装置、instrumented NIF、私有部署资产和固定实验生成器明确排除。交付包来源审计列出具体文件缺项和hash。

本轮只运行相关离线正确性检查，没有启动实际容量阶梯、服务、部署、网络namespace、进程停止、数据库或设备验证。测试位于交付验证材料，不进入产品补丁。各子目录双语README说明完整接口和限制。
