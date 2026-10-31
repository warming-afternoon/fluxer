# 可重跑的 R22 HTTP / Gateway 传输

入口：`createTransportDriver`（`MixedAudienceTransport.mjs`），由 campaign 调度器调用；不要直接运行原始 R22 脚本。没有默认服务地址、容器、账户或历史运行状态。

## 必需配置

`transport` 显式提供：`apiBase`、`gatewayUrl`；以下均为正整数：

- `loginConcurrency`、`identifyGapMs`、`readyTimeoutMs`
- `httpTimeoutMs`、`closeTimeoutMs`、`sendConcurrency`
- `membershipPageSize`（最多 100）、`maxMembershipRows`
- `telemetryIntervalMs`、`maxEvidenceEvents`
- `watchAckTimeoutMs`、`watchRetryDelayMs`、`watchMaxAttempts`、`watchRenewalMs`、`watchLeaseMs`
- `maxFrameBytes`、`maxResponseBytes`、`maxBitmapBytes`、`windowSeconds`

watch 续约与重试总窗口必须小于租约长度；所有阶段的 ACK 周期必须相同。未知字段拒绝。`requireSourceIpProof:true` 明确拒绝：材料缺少应用侧 IP 审计器，不能以客户端地址或连接数替代。可省略该字段或显式 false，不会宣称已验证来源 IP。

只支持未压缩 JSON Gateway；URL 查询只接受 `v`、`encoding=json`，不允许把凭据放进 URL。任何重连请求均结束本次尝试，不隐式恢复会话。一个进程包含多个**逻辑** worker 分区，不是历史 R22 多进程压测；CPU 不能按逻辑 worker 重复累加。

## 私有凭据与准入

`credentials.actors` 为私有数组，每项包含 `id`、`guildId`、`token`；所有接收者还需明确 `ackEligibilityVerified:true`。作者必须有对应凭据。此标记是操作员提供的 ACK 授权前提，不是假称已经执行了浏览者授权审计。

另提供：

```text
credentials.admission = {
  readerId: 独立的只读 bot 身份（也存在于 credentials.actors，但不列入 capacity.actors）,
  threadId: 本次单帖子目标,
  expectedFollowerIds: 完整预期关注者 ID 数组（包括不建立 WS 的关注者）
}
```

该 reader 的 token 需带产品要求的 `Bot ` 前缀，并具有读取目标帖成员的权限。初始化在任何 WS 和消息提交之前，使用产品现有 bot-only `GET /channels/:id/thread-members` 做有界分页，验证精确完整集合、成员受众在集合内、浏览受众不在集合内。未提供清单、无权限、分页不一致或受众错误均阻止运行。不会自动加入、退出、创建或修改账户/关注关系。需在隔离的一次性 fixture 中避免并发外部成员变更；分页读取不是全库事务快照。

凭据永不写入错误或 checkpoint；接收者/频道/消息 ID、HTTP 行、位图仍是**私有**证据，不得放入公开输出。远端响应错误正文不保留。

## 生命周期与证据

`initialize()` 返回实际就绪顺序的 `actorsByWorker` 与准入摘要。`runStage(plan,{signal})` 保持前后阶段同一组连接，不强制排空 ACK。`checkpoint({stageId,final:false})` 带全部 worker 的 V2 原始快照、位图 Map、逐消息 Map、HTTP 行、ACK 事件和游标、采样点。Map/Buffer 需要由 artifact writer 编码，不可直接 JSON.stringify 后声称保存了完整证据。

最终顺序是合法 ACK drain、只读游标验证、真实关闭连接、**逐 stageId** 封存 checkpoint；关闭前请求 final 仍然只会得到 preview。`realCloseVerified` 仅表示真实 close 事件都已发生；还必须要求 `cleanCloseVerified`、errors 为空，不能将异常 close 当成功。关闭期间仍处理到来的消息，未封存先前阶段。

`ReadOnlyCursorVerifier.mjs` 提供具体 Cassandra 适配器：明确 `contactPoints`、`port`、`localDataCenter`、`keyspace`、`maxRows`、`fetchSize`、`readTimeoutMs`；认证用户名密码另行私有传入。使用现有 `fluxer_api` 依赖中的 cassandra-driver 与公共 VerifyAckCursors reader。只执行 prepared SELECT，最终总是关闭自有 client。阶段读取保留前后 ACK 水位，由 audit 验证允许区间；最终要求冻结、已排空且精确一致。不会把缺失 ACK 填成伪造游标。

离线回归通过注入 fetch/WebSocket/Cassandra 客户端执行，不能作为真实压测或设备容量结论。参见交付包验证报告。

### 游标查询并发与时限

`cursor.connection.queryConcurrency` 可显式设置为 1–128；模板为 8。旧调用未提供时兼容为 1（串行），不应假定几千个用户在很短的级间预算内完成。用户分区并行但各分区分页有序，输出保持输入用户及频道顺序；错误或取消后不再安排新用户，并等待当前请求结束再关闭 client。`readTimeoutMs` 限制单次数据库请求，不等于整次全受众游标审计耗时；总时限由 campaign 的 cursor timeout 明确控制，实际容量/延迟未运行验证。
