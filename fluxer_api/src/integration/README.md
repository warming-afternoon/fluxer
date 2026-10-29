# Fluxer 集成进程

使用现有 `fluxer_api` 构建流程，在 API 镜像中运行 `node dist/IntegrationEntrypoint.js`。开发命令为 `pnpm --filter fluxer_api start:integration`。集成进程复用原生仓储、Snowflake ID、账户初始化、资产存储、密码逻辑和会话，不启动原生公共 API 或定时任务。

启动前必须在原生 Cassandra keyspace 中应用 `schema.cql`。身份权威存储仅支持 Cassandra。现有内部 NATS/JetStream 配置保持独立，原生服务、网关调用和任务发布仍使用内部代理。

| 环境变量 | 含义 |
| --- | --- |
| `INTEGRATION_NATS_URL` | 独立外部集成消息代理地址 |
| `INTEGRATION_NATS_USER` / `INTEGRATION_NATS_PASSWORD` | 当前进程独立凭据 |
| `INTEGRATION_EXCHANGE_KEY` | 64 位十六进制 AES-256 密钥；所有集成副本共享并保持稳定 |
| `INTEGRATION_MAX_INFLIGHT` | 每副本最大并发 RPC；默认 32，上限 256 |
| `INTEGRATION_ALLOWED_REPLY_PREFIXES` | 默认 `_INBOX.forum.,_INBOX.bot.` |
| `INTEGRATION_FORUM_REPLY_PREFIX` | 默认 `_INBOX.forum.`；所有鉴权 RPC 只能回复到此命名空间 |
| `INTEGRATION_HEALTH_PORT` | 默认 8091；提供 `GET /_ready` 和 `GET /_live` |

原生 API 和 worker 使用各自只允许发布事件的集成代理凭据，变量名相同但值不同。不能向它们发放集成 RPC 服务凭据。Bot 可以调用身份预建/查询，但不能调用会话交换或读取 Forum 回复。Forum 是受信身份断言方，必须完成 Discord OAuth、验证成员资格后才发送 Discord 主体和新鲜验证时间。Bot 也必须验证预建成员来源。NATS ACL 是调用方鉴权边界，不能直接转发浏览器提供的未验证身份。

## RPC 合约

请求统一为 `{version:1,request_id:<16..128位ASCII标识>,...字段}`。响应为 `{ok:true,data:...}` 或 `{ok:false,error:{code,message,retryable}}`。请求最多 16 KiB。身份 ID 使用十进制字符串；会话哈希为 SHA-256 的 base64url 编码；仅接受 `flx_` 原生会话令牌。

| Subject | 额外请求字段 | 返回 data |
| --- | --- | --- |
| `rpc.integration.v1.service_info` | 无 | 检查 Cassandra 和缓存后返回 `{service,version,ready}` |
| `rpc.identity.v1.ensure_discord` | `discord_user_id,profile,operation_id` | `{user_id,discord_user_id,created}` |
| `rpc.identity.v1.lookup_discord` | `discord_user_ids`，1–100 项 | `{bindings:[{discord_user_id,user_id,version}]}` |
| `rpc.identity.v1.profiles` | `user_ids`，1–100 项 | `{profiles:[{user_id,username,display_name,avatar_url}]}` |
| `rpc.auth.v1.external.exchange` | `exchange_id,discord_user_id,verified_at,profile,origin` | `{token,user_id}` |
| `rpc.auth.v1.session.resolve` | `token` | `{user_id,discord_user_id,session_id_hash,username,display_name,avatar_url}` |
| `rpc.auth.v1.session.revoke_current` | `token` | `{revoked:true}`，可幂等重试 |
| `rpc.auth.v1.external.prove` | `purpose:"set_initial_password",token,discord_user_id,verified_at,operation_id` | `{proof,expires_in:120}` |

`profile` 为 `{username,display_name:string|null,avatar_url:string|null}`；`origin` 为 `{ip,user_agent:string|null,client_os:string|null}`。`verified_at` 使用 ISO-8601，最多早于当前时间 120 秒或晚于当前时间 30 秒。新交换验证时间新鲜度；匹配的重试可在十分钟内获取原有结果。`request_id`、`exchange_id` 和 `operation_id` 仅接受字母、数字、下划线、连字符。一个 `exchange_id` 只能对应一份不可变请求，重试时仅 `request_id` 可以变化。

## 身份、创建和重试

Bot 预建与 Forum 外部登录共用 `ensureDiscordAccount`。每个 Discord 身份独立分区，正反向占用均采用条件写入。未完成占用保留以便崩溃恢复，先写历史再将绑定标记为完成。不能释放、重分配占用或通过用户名/邮箱推断绑定。已完成绑定指向缺失原生账户时拒绝处理，不重新建号。

初始账户没有密码、合成邮箱或共享密码，使用原生用户名预留、条件创建、索引和默认设置。显示名经过原生校验，用户名包含原生 ID 以避免歧义。头像只从对应 Discord 身份的 CDN 路径导入，禁止重定向、限制为 2 MiB，并经过原生资产处理。没有自定义头像时传 `null`。后续资料以 Fluxer 为权威，不由 Discord 登录覆盖。

交换元数据永久占用操作 ID，令牌密文十分钟过期，并以交换 ID 作为认证附加数据。密文在唯一一次原生会话创建尝试之前持久化。创建结果不确定时重试相同交换，服务只检查原先准备的令牌，不创建第二个会话。`EXCHANGE_UNCERTAIN` 表示尚未观察到已持久化会话；如果原操作始终没有提交，需要重新完成显式身份验证以开始新登录。重放不能复活已撤销会话。各副本及重试期间必须保持加密密钥稳定。

## 会话与事件限制

新的会话解析绕过原生短期会话缓存，读取原生会话与当前账户状态。失效事件为加速提示，采用尽力交付，没有持久化 outbox。若只有发布者连接故障、Forum 连接仍正常，Forum 不一定更换缓存代次；未收到事件的已有正缓存可能保持到原先最长一小时的 TTL，不能保证立即撤销。新的 RPC 解析仍读取权威状态并拒绝失效会话。

原生仓储撤销与账户状态变更发送顶层事件：

- `events.auth.v1.session_invalidated`：`{event_id,occurred_at,user_id,session_id_hash}`
- `events.auth.v1.user_invalidated`：`{event_id,occurred_at,user_id}`
- `events.identity.v1.binding_changed`：`{event_id,occurred_at,discord_user_id,user_id,version}`

事件与错误响应不包含令牌、密码或证明。`INVALID_TOKEN` 和 `ACCOUNT_UNAVAILABLE` 表示鉴权失败；`UNAVAILABLE`、`STORAGE_UNAVAILABLE`、`BUSY`、`EXCHANGE_UNCERTAIN` 表示可重试的依赖/处理失败，不能作为鉴权成功。`PROOF_NOT_AVAILABLE` 表示正常登录可以继续，但不满足首次密码设置条件。

## 首次密码与验证

证明绑定用途、用户和当前会话，两分钟后过期，由 `POST /users/@me/discord-password` 原子消费。原生接口核对权威会话及新鲜账户状态，保留已启用的 MFA/sudo 校验，校验新密码并轮换原生会话。普通 SSO 账户不能获得这一能力。正常外部登录不额外增加第二次 MFA。

运行 `vitest run src/integration` 执行本地测试。可选真实 NATS 测试仅在设置 `INTEGRATION_LIVE_TEST_CONNECTION` 后启用；该变量指向包含 `port`、`forum_password`、`fluxer_password` 的隔离代理测试元数据 JSON。此测试使用真实消息传输和 ACL，原生仓储使用内存测试实现。离线 API 测试替换生产就绪探测，不启动 Cassandra/NATS。尚需在目标环境验证真实 Cassandra 的条件写入及完整容器启动。
