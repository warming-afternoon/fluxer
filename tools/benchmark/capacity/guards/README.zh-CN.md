# 可选资源与进程所有权守护

本目录将候选工具的通用安全契约提取为显式调用的库。导入没有采样、创建日志、启动计时器或停止进程的副作用；没有 WSL、Docker、私有账号、固定容器数量或阶段速率。产品编译不依赖这些模块或诊断 NIF。

## 追加日志与新鲜度

`openResourceLog({enabled:false})` 默认不触碰文件。启用时必须指定 `file`、`maxRows`、`maxBytes`；上限分别为100000行和64MiB。打开既有日志采用追加模式，并获取同路径 `.lock` 单写者锁；不会清空历史。达到预算返回 `false`，调用方必须停止采样并将覆盖标为不足，不能补点。写失败保留 partial、关闭写端并抛错。已有不完整尾行拒绝继续追加。崩溃遗留锁需要核对原写者已停止后人工处理，不自动抢占。

`readLatestResourceRecord(file,{maxTailBytes:65536})` 只读有界尾部的最后完整JSON行，忽略正在写入的partial；缺完整行、超长尾行、坏UTF-8/JSON明确失败。将读出的记录交给 `assertFreshResourceSample(sample, policy)` 核对bootId、精确纳秒、最大年龄、完整性、资源下限及可选的精确进程身份清单。采样来源由调用者提供，不把宿主/容器身份推测出来。

```js
import {openResourceLog, readLatestResourceRecord} from './ResourceLog.mjs';
import {assertFreshResourceSample} from './ResourceGuard.mjs';
const log = openResourceLog({enabled: true, file: outputPath, maxRows: 1000, maxBytes: 1024 * 1024});
log.append({bootId, monoNs: String(nowNs), complete: true, availableBytes: {host: available}, processIds, errors: []});
log.close();
assertFreshResourceSample(readLatestResourceRecord(outputPath), {
  bootId, nowNs: String(nowNs), maxAgeNs: '1000000000',
  minimumAvailableBytes: {host: requiredAvailable}, expectedProcessIds: processIds,
});
```

不得把调用者传入的 `complete:true` 解释为本库已经访问或证明真实监控源。调用方需采集并验证真实来源，完整性失败应传false或停止推进。

## CPU窗口与额外余量

`generatorIntervalEnvelope({byWorker,workerIds,startNs,endNs,cellNs,maxIntervalNs,maxCells})` 对真实连续区间生成保守最大值包络。时间必须为十进制字符串或BigInt，拒绝已舍入的Number、空洞、重叠、乱序、超长区间、缺尾部以及过大输出网格。记录源行SHA256和精确覆盖范围；派生网格不是独立原始采样。`byWorker` 是Map，区间行为 `{startNs,endNs,cpuPercent,loopP99Ms}`。

`assessHeadroom(input)` 保留R22“原规则全部成立后再加保守线性筛查”的规则。输入显式指定currentRate、nextRate、limitsByRole、before/after的同bootId/同实例CPU累计纳秒及时间。角色行为 `{role,identity,restartCount,cpuUsageNs}`。只有原continuation、资源覆盖/安全、投递及WebSocket验证均为true，真实唯一实收等于期望且missing为0，并且各角色预测CPU严格低于限制，才返回mayAdvance。唯一计数同样用十进制字符串/BigInt。预测不是容量证明，也不替代WS clean close证明。

没有把实验的12核、35K/40K、3.6/10.8核、八worker或360秒写成默认值。虚拟机CPU总量若需参与筛查，应由可靠采样器按同一角色累计计数契约提供；没有凭快照计时器数量伪造覆盖。

## 精确所属进程停止接口

`stopOwnedProcess(owner,{openHandle,timeoutMs,signal:'SIGTERM'})` 只接受owner的 `{pid,bootId,startToken,runId}` 与**身份绑定句柄适配器**，验证前不请求停止，退出收据也必须绑定同一身份。不提供PID名称搜索、整组kill、SIGKILL升级或自动停止CLI。

适配器需实现：`identityBound:true`、`inspect()`、`terminate({signal,expected})`、`waitForExit({timeoutMs,expected})`、`close()`。所有方法必须操作同一内核实例句柄（如pidfd）或具备等价身份校验的协作式实例端点。先读取 `/proc` 再 `kill(pid)` 有PID重用竞态，不满足契约。`waitForExit` 必须尊重timeoutMs；打开/查询/停止/关闭的期限及取消行为由平台适配器负责，本包装器不承诺整个异步操作的全局超时。

本次仅提供并离线验证接口，**未提供或执行真实Linux/Windows句柄适配器**。不能据mock测试声称平台进程停止已经验收。

## 来源与验证

- `ResourcePressure.mjs`、`OwnedRuntime.mjs`：有界日志、完整尾行、新鲜度、精确身份规则；剥离原平台路径/部署/固定容器拓扑。
- `GeneratorIntervalCoverage.mjs`、`GeneratorIntervalCampaign.mjs`：真实区间连续覆盖和保守网格；参数化时长/worker/格宽，并严格拒绝重叠。
- R22 `finish-contract.mjs`：只提取额外余量规则，不执行字符串改写和固定阶段生成器。
- R22 `stop-wsl-monitor-r22.mjs` / `stop-windows-monitors-r22.ps1`：启动身份与退出收据；改为不可退回PID-only的适配器契约。
- clock-52脚本是特定跨Windows/WSL时钟装置，未伪装为通用采样器迁入；本库只验证提供的同bootId单调时间。

离线测试位于交付包验证材料，不进入产品分支。没有启动监控、容器、压测或停止任何实际进程。

## 可直接使用的精确容器停止适配器

`OwnedContainers.mjs` 提供 `stopOwnedContainers(owner,{execute,gracefulSeconds,timeoutMs})`，来自 `OwnedRuntime.stop` 的实际算法。owner为 `{project,services:[{id,imageId,role}]}`，必须使用64位完整容器ID和完整sha256镜像ID，数量有界且ID/角色唯一。

显式调用会先 `docker inspect` 冻结清单，核对镜像及Compose项目/角色标签，再仅对仍运行的**完整ID**执行 `docker stop --timeout <gracefulSeconds> -- <ids>`，最后再次inspect确认全部停止。不按名字查找，不替换缺失对象，不处理清单外容器。`execute` 默认Node的execFileSync，可注入离线假执行器；导入本身不执行命令。

注意：Docker自身在gracefulSeconds宽限期后可能强制终止容器，这不是纯SIGTERM承诺。只有明确获准停止这些容器时才调用。每个命令受timeoutMs限制，整段流程可能包含三个命令，不承诺全局timeoutMs期限。返回 `cleanWebSocketCloseProven:false`，容器停止绝不是真实WebSocket clean close证据。本次只使用假Docker离线验证，未连接Docker daemon。
