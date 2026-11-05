# Forum NSFW / V2 preferences 独立复核

复核日期：2026-11-05 UTC。复核对象是基于 Fluxer `9a4d9cd5b`、最终实现 HEAD `ce4efcf99` 的本地 display-only 候选，而非生产部署批准。结论：**本轮约定的 display-only 范围内，未发现未修复的新权限或确认语义阻塞，本地候选可交接**。这不等于完成真实服务上线验收，也不以历史测试或旧设计替代当前源代码证据。

## 范围和判定标准

- 只增加配置的 `INTEGRATION_GUILD_ID` 上的显示偏好。缺失或未确认的偏好不授予显示权限；raw `show_nsfw=true` 回到原生权限路径，不补授年龄、角色或私密线程成员资格。
- 年龄行为的判定基准是“不比 `9a4d9cd5b` 更宽松”。本次不改全站 DOB、bot、policy 或用户写入协议，也不把旧原生年龄并发问题作为本功能上线前置条件。
- Forum 最终 clean 候选：`0b4b84c`；Web：`e18143c`，独立重放到实际 `dev-new` 基线，不依赖暂停的 V1 bridge。
- 本复核未修改生产实现，只维护本报告。所有执行均为本地、离线验证；没有使用真实凭据、生产服务、推送或部署。

## 最终修复闭环

1. 新增分类批量读取的 503 映射已修复：`NsfwVisibility.readChannels` 包装新增读取，`GuildOperationsService`、`GlobalSearchService` 和新增的 `GuildSearchService` 分类读取使用该入口。保留原基线读取行为；unit 与真实路由 harness 故障注入已独立通过。API checkpoint：`ea08b85a8`。
2. Gateway 异常退出的 socket 确认窗口已修复。原 `revoke/1` 的 normal/noproc 成功不能证明 socket 结束，且原 `handle_session_down` 只发 INVALID_SESSION、不关闭 socket；离线最小 actor 模型曾重现 ACK 时 socket 仍活。最终实现独立保存 socket 证据，不再依赖 session 存活：
   - identify 在任何 READY 发送前登记，resume 在任何 replay 前登记；插入后比较当前 preference/fence，拒绝迟到快照并主动关闭新 socket。
   - session detach 不删除 socket 行。begin/sync 先推进水位，再独立枚举 socket、发 close 并等待实际 DOWN。
   - timeout 或 noconnection 不当作死亡，保留记录和未完成 intent。ETS owner 监控并只清理确认死亡的记录，owner 重启重新监控。
   - 新增回归覆盖 session normal 无回复、noproc 残留、detach 先于扫描、close 超时与重试、stale identify/resume、监控断连不当死亡。最终独立 54 项 Gateway 回归覆盖这套关闭协议及后续缓存收尾。socket checkpoint：`8e2ba5b84`。

上述都是本补丁自己的边界修复，没有借此扩大原生年龄工作。

## 原生年龄与权限基线比较

- `BaseChannelAuthService` 相对基线只在原有 guild/visitor 路径前增加 `NsfwVisibility.assertVisible`。原 `skipNsfwValidation`、AgeUtils 调用和直接未成年请求 403 语义未修改。raw true 不新增年龄旁路。
- Gateway `guild_visitor_permissions.erl`、`session_visits.erl` 与基线无差异；`admit` 原有 `adult_content_allowed`、原 `hidden_nsfw`、`evict_minors` 保留。visitor snapshot 只在原 view 上附加显示过滤。
- 普通成员 Gateway 基线不存在本次曾探索的年龄缓存。已删除新增 sticky age、`USER_UPDATE` 年龄特判、资格版本和 push/backstop 年龄分支，没有永久 false 或新的生日恢复行为。
- `api_native_permissions` 是内部 API 查询的临时上下文，只短路新增 display gate；原角色覆盖、私密线程成员与 visitor 年龄逻辑继续执行。read-model 只改临时快照，actor 查询包装返回原 State，cache key 区分原生查询，未向 WS 持久化该标记。
- Forum RPC 的 `nsfw_eligible` 只用原 `canUserAccessNsfwContent(availableUser)` 计算。它与 raw show 分开返回；Forum 内容过滤取两者 conjunction，不写资格、不把显示偏好当成年证明。
- `AgeUtils`、`DateOfBirth`、`UserDataRepository`、`UserAccountRepository`、`RpcSessionStartService` 及实例配置写入实现相对基线没有本功能的资格协议改动。

旧原生年龄读/更新/会话注册之间的并发风险属于上游机制限制，不是本补丁新引入，也不作为此次 display-only 候选的阻塞。本次曾提出的资格 epoch、pending nonce 和 policy 协议均未落入生产实现。旧资格 checkpoint、依赖已删除函数的实验脚本及复核者的 options 已移出产品仓库，不应打包进生产 patch。

## 显示权威、CAS 和故障恢复

1. `UserGuildNsfwRepository` 对 `show_nsfw/nsfw_version` 使用独立 LWT。普通 guild settings 保存排除此 pair。初始 null 版本受普通 row version 辅助保护，但普通设置争用只触发有限重读重试；NSFW 版本变化才是 STALE，持续争用是可重试 BUSY。
2. 目标 guild 的权威单项读取使用 SERIAL。启动在一般 settings 批量读取后，对实际参与目标 guild 的用户单独读取并替换目标项；不把全体其他 guild settings 查询改成 SERIAL。缺失、版本 0 的 true 和非法版本不授予显示。
3. 服务先读并验证 expected；随后为每次调用写唯一 `nsfw:g:u:uuid` durable intent，包含原授权目标和 expected，避免并发调用互删。
4. CAS 前 begin 全节点 fence 并停止旧会话，CAS 后同步已提交版本，再完成普通设置传播和清除本调用 intent，才返回确认。相同 expected、相同目标的已提交结果允许幂等确认；更高不同赢家不能被覆盖。
5. 恢复在权威仍为 expected 时重做 begin 和原授权 CAS；权威已推进时只同步当前赢家，不回写旧值。每次恢复只删除自己的 intent。恢复有界扫描，但故障或积压时不保证固定完成时限。
6. preference/version/fence 位于一个原子 ETS 行；旧 begin 或 commit 不能消除更新的 fence。启动导入不能解除未完成 fence。每个节点 begin 都读取当前原生权威，处理恢复已提交并清 intent 后、旧 begin 在重启节点迟到的情况。

逐窗口结论：

- intent 之前失败：未写偏好、未 fence，不需要恢复；读取冲突也在 intent 之前拒绝。
- intent 后、CAS 前失败：偏好可能仍旧，但 durable intent 可完成原授权操作；调用方必须把失败视为未确认，不能假设未提交。
- 部分节点 fence 后失败：不执行 CAS；已有 fence 保持 fail-closed，恢复需要完整节点可达。
- CAS 结果未知或进程在 CAS 后崩溃：intent 留存；重读 authority 后同步赢家，不能从超时推断未写入。
- commit sync、普通传播或清 intent 失败：已写入可能生效，仍不返回成功；恢复和同 expected 重试处理不确定结果。
- 清 intent 后旧调用迟到：节点本地水位或 begin 强读防止重新建立已完成低版本 fence；不能假设只有原请求进程会重试。

## Gateway、列表、搜索和旁路事件

- fanout 使用显式完整 `INTEGRATION_NSFW_GATEWAY_NODES`、当前节点和曾观察节点的并集。集群模式缺配置、scope 不符或节点分区不空确认。全体节点同 scope 和一致部署仍是运维前提，scope 不支持运行期热切换。sync 的 mismatch 拒绝不代表错误配置下所有 startup/join 都 fail-closed：例如 API 宣告 guild 2、Gateway 固定 guild 1 时，guild 2 可能被当作非目标；此类配置偏差必须在放流量前排除，不在本轮增加多 scope 系统。
- 注册先于本地水位核对，断连可重放 session 也在撤销集合；目标 session transfer 要重新 identify。未参与目标 guild 的用户不注册，新 join/visit 不能借其他设备缓存绕过注册。
- 目标 guild 的 async connect finalize 总以当前 actor state 重算，覆盖偏好没变而 channel/category/guild 分类或角色已变的竞态。
- 成员/visitor/list/thread/最终 dispatch 都附加 display deny。缓存包含完整显示版本与 fence，避免 false/true/false ABA 复用旧计算；相同角色用户不能互借显示结果。目标 visitor map 达 256、ETS 达 1024 后在 miss 写入时清历史项，非目标缓存不改；ETS 是清理触发阈值，不能称并发下的严格 quota。线程按 parent/category/guild 继承，目标内无法确认的资源 fail-closed。
- HTTP 直接隐藏资源返回 404；列表和搜索过滤隐藏结果。原有权限/年龄检查仍在，raw true 并不把既有 403 改成成功。依赖故障不伪装成隐藏资源。
- READY/ACK 的 legacy 未标记 read state 也按实际 channel 过滤。找不到实际资源的 null guild 孤儿记录不返回；已知 DM/其他 guild 有效资源仍保留。内部 scope marker 不进入客户端 payload，预编码事件也覆盖。
- push 最终发布出口再次检查本地显示水位，包括重试任务；steady WS 投递路径没有新增每条消息外部查询。

## 原生 UI 和 Forum / V2

- 原生开关仅在 guild privacy 中出现，要求 scoped boolean setting。直接、非 coalesced PATCH；客户端核验确认中的 guild、raw bool 和恰好 expected+1。普通设置保存不混入 NSFW pair。
- V2 GET 不创建普通偏好行；已有 legacy 行不是首次。省略、null、空列表语义分开，作者 lazy hydration 返回 DTO 而非读时修改 ORM。
- 普通偏好沿用既有数据表与 Discord 主 guild；写锁按 canonical 用户和 guild 定界，覆盖首次并发创建和局部写入。NSFW 使用独立 native guild RPC，不与普通字段混合提交。
- 继承的频道 ID 属于 Discord。显式原生频道指定 `platform=fluxer`；虚拟频道优化和反选不错误命中 native 同数字 ID。
- homepage RequiredSetupGate 与旧 `/me` 接入 V2；服务器首次状态不被本地完成标记绕过。dirty draft 与身份切换隔离；搜索真正省略未设置的默认字段。
- Web NSFW 保存基于一次完整成功显示快照；加载、刷新、失败、无效 scope/version 时禁用。写入绑定 session/user/guild/expected，发网前重验 session，返回完整 schema 和 exact+1 校验，409 不自动重试。

## 本复核者实际执行的测试

以下是独立执行，不把其他执行者汇报或重复快照相加：

- Forum Python client/schema：`test_fluxer_preferences_client.py`、`test_fluxer_preferences_contract.py`，使用 `FLUXER_CONTRACT_ROOT` 指向 native 候选，54 passed；在最终 display-only 原生候选上再次独立复跑，非真实 NATS。
- 最终 display-only API：5 文件 70 passed。repository 10、service 11、visibility 19、HTTP harness 13、integration preferences 17。HTTP harness 覆盖未成年 raw true 的原生 403、离线调用、隐藏资源与依赖故障；明确 `--isolate`。
- 最终 display-only Gateway：独立编译 410 个模块，54 EUnit passed。包括 raw true 成员权限与原路径相等、visitor raw true 不绕过 adult=false、显示更新、独立 socket 关闭、bootstrap/fence/cache/thread 竞态，以及连续 1100 个版本、ABA 旧 key 不复用和非目标缓存不清理。
- 旧资格候选的 75 项 API/45 项 Gateway 和缺口脚本是历史 checkpoint，不是当前最终通过数。先前非隔离运行曾暴露 shared-worker mock 缓存问题，已改真实 dispatch stub；最终命令继续显式隔离。

API（`fluxer_api` 下）：

```sh
API_TEST_MAX_WORKERS=1 node_modules/.bin/vitest run --project=api --isolate --reporter=default \
  src/api/user/repositories/UserGuildNsfwRepository.test.ts \
  src/api/user/NsfwDisplayPreferenceService.test.ts \
  src/api/channel/utils/NsfwVisibility.test.ts \
  src/api/channel/tests/IntegrationNsfwVisibility.test.ts \
  src/integration/IntegrationPreferences.test.ts
```

Gateway（仓库根）：

```sh
NSFW_TEST_EBIN=/tmp/nsfw-review-beam bash fluxer_gateway/scripts/test-nsfw-display.sh
```

需要 OTP 27 的 `erl`/`erlc` 在 PATH。离线编译有缺少 cowboy behavior module 的 warning，不能称为完整生产 release build。最终本地 200-device 微基准 p50 79 µs、p95 150 µs，追踪外部 RPC 0；只代表本地 actor 测试，不是集群或端到端容量保证。

## 未测、发布条件与既有边界

- 本复核没有运行真实 Cassandra 多副本/LWT、NATS ACL、Gateway 多节点分区、真实 socket 多设备 reconnect 或生产 push/media。其他执行者的 PG/Web/类型检查总数应单独列示，不能与本报告重复子集累加。
- 先做 schema-before-code；真实环境验证 CAS/普通保存竞争、提交结果未知、恢复 crash/restart、完整节点不可达和重加入。
- 全部 Gateway 节点升级并排空旧版本；配置一致 guild 和完整节点列表，明确节点退役/改名程序。验证确认前旧 socket 与 replay 停止、新 identify、Forum 离线用户和 API 列表/直接请求一致。
- 请求按其读取快照工作，不保证撤回已经开始处理的 HTTP 响应。已经下载的内容、客户端缓存、已签发媒体 URL、已被 broker/设备 OS 接收的通知不可由此开关撤回。
- 年龄风险保持上游既有范围，不因本显示开关额外授予资格，也不把全站年龄改造列为本次发布前置。
- V1 与 V2 过渡期保留旧入口。按用户明确范围，旧 V1 Discord 投影入口的 NSFW 风险属于已接受的短期风险，不是本次上线前置；V2 前端不使用该入口，待 V2 正式使用一段时间后再另行关闭。不能把本报告理解为旧 V1 入口已完成同步过滤。
