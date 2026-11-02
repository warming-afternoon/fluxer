# Odysseia 社区部署

本目录独立维护社区部署，基线为 `dev` 的 `718c7ba54`。默认 Cassandra、单 API，保留社区已采用的组合请求、批量通知和资源上限配置。同步上游时应逐项审查镜像、环境变量和服务变更，不用上游部署脚本覆盖本目录。

## 服务与信任边界

`nats-integration` 是单独的消息代理；`fluxer-integration` 是执行身份业务和会话 RPC 的独立进程，复用同一份 Fluxer 原生服务代码及数据库。它不启动原生公共 API，也不提供任意函数调用。现有内部 NATS 保持独立，不通过 route、leafnode 或 gateway 暴露给 Forum。

浏览器直接请求 Forum Python API 和 Fluxer 原生 API，二者使用同一个原生 `flx_` 会话。Forum 缓存命中不经过 Fluxer；缓存未命中才通过 WireGuard 网络请求 RPC。公开 HTTP 不经过 NATS。身份同步 Bot 使用单独凭据调用幂等身份服务，不能签发登录会话。

| NATS 账号 | 权限 |
| --- | --- |
| `forum-service` | 会话解析、Discord 登录交换和短期证明、当前会话撤销、批量身份/资料查询、失效事件、自己的服务信息回复、预建内容消费者拉取 |
| `discord-sync` | 创建/查询 Discord 绑定、查询资料、探测 Forum 和 integration 服务信息；不能调用任何会话签发接口 |
| `fluxer-integration` | 接收明确列出的 RPC，发布失效/绑定事件，限次限时回复 |
| `fluxer-api` | API 发布会话失效事件；不能订阅或调用身份 RPC |
| `fluxer-worker` | worker 使用独立凭据发布会话失效事件；不能订阅或调用身份 RPC |
| `integration-admin` | 管理指定内容流及消费者；仅离线预建时使用 |

服务注册是凭据、subject 合约、队列订阅和健康接口的组合，没有额外注册中心。Forum 使用一个服务账号。外部服务不直接写 Fluxer 或 Forum 数据库。

Bot 可向 `rpc.forum.v1.service_info` 与 `rpc.integration.v1.service_info` 发送 `{version:1,request_id:<随机标识>}`，回复限定在自己的 `_INBOX.bot.` 命名空间。健康探测不包含会话或用户资料，不需要管理账号或任何鉴权 RPC 权限。

## 准备与启动

当前提交不会启动生产部署或迁移实际数据。所有以下命令应在目标 Linux 主机由运维显式执行；Windows 工作树只用于修改和验证。

1. 复制 `.env.example` 为 `.env`。填写所有 `CHANGE_ME`、域名、原生密钥、VAPID 和 S3 配置。六个 NATS 密码必须各不相同，包含独立的 `INTEGRATION_WORKER_PASSWORD`，并使用随机长密码；`INTEGRATION_EXCHANGE_KEY` 为独立随机 32 字节的十六进制编码。不要复用 Bot token。为本次社区构建填入不可变 `FLUXER_PRODUCT_BUILD_TAG` 和实际 `FLUXER_SOURCE_SHA`。
2. `COMPOSE_PROFILES=bundled-cassandra` 使用本机单节点 Cassandra，默认上限 4 GiB；这是单节点部署，不提供数据库高可用。使用已有集群时清空该 profile，并配置 `FLUXER_CASSANDRA_*`，自行管理认证、复制、备份和容量。容器内地址不能使用宿主机 localhost。
3. 在正确 Cassandra keyspace 中应用原生 Fluxer schema，再应用 `fluxer_api/src/integration/schema.cql`。已安装第一版集成身份表时，先逐条执行一次 `fluxer_api/src/integration/upgrade-v2.cql`，再应用 `schema.cql` 创建新增表；全新部署不要执行 ALTER 升级文件。原生仓库提供 `pnpm dev:cassandra:apply` 工具，先核对其目标配置。集成 schema 不创建 keyspace、不导入用户。缺表或缺列时 integration readiness 失败；不能靠重启代替迁移。
4. 配置 WireGuard：`wireguard/` 是两端配置示例。为两台服务器生成各自密钥，将 endpoint/公钥替换为实际值。broker 仅绑定 `${INTEGRATION_WG_IP}:4223`，不公开 8222 监控端口。Forum 连接 `nats://10.77.0.1:4223`，使用 `forum-service`。只允许指定 WireGuard peer 访问；不要将此明文 NATS 端口映射到公网。选择公网传输时必须另行配置 NATS TLS 和服务端证书验证，不能直接沿用此监听方案。

   内容操作还须配置 `INTEGRATION_GUILD_ID` 和逗号分隔的四个 `INTEGRATION_FORUM_CHANNEL_IDS`，与 Forum 的普通、普通 NSFW、深渊、深渊 NSFW 四分类一致。未配置或数量不为四时内容 RPC 失败关闭。`FLUXER_THREAD_POLICY_ENABLED=true` 同时传入 API、worker、integration；安装策略 schema 后再启用。受信 Forum 管理组使用 `rpc.identity.v1.rebind_service` 显式发起换绑，普通登录不自动合并账号。完整内容合约见 `fluxer_api/src/integration/README.md`。
5. 使用 `docker compose --env-file .env config --quiet` 校验，再执行 `docker compose --env-file .env build` 和经过审查的启动命令。本地社区 API、worker、integration、gateway、push 必须使用本分叉构建，不替换成缺少新增入口的上游 API 镜像。
6. 配置 Forum `FORUM_AUTH_MODE=fluxer` 之前完成用户迁移。具体顺序见 Forum 的 `docs/fluxer-online-migration.md`：准备分支、预建正式用户、导入权威映射、在线回填和审计，最后停掉全部旧写入者（含 Bot/worker）、补齐差异、执行 runtime 迁移、切换功能代码。新表没有实体外键。身份不齐或审计非零时不切换；不执行破坏性回滚。

公开流量接入前必须完成注册策略门禁：通过原生管理后台的实例配置，将注册模式设置为 `closed`，保存后重新读取实际配置并确认已生效，再验证匿名普通注册被拒绝。上游默认注册模式为 `open`，本部署文件不会自动改写已有站点设置，也不能用隐藏网页注册按钮代替后端策略。不要向公众分发原生管理后台签发的注册链接；受信任 Discord 账号预建仍由集成身份服务执行。未确认后端关闭公开注册时，不得开放公网入口。

默认不会启用两个 API。可选多实例需要先用 Compose 导出解析后的 JSON（含敏感配置，应限制文件权限），然后运行本目录 `render-multi-api.mjs --input <resolved.json> --output <generated.json> --caddy-output <absolute-path> --instances 2 --host-memory-mib <目标服务器内存MiB>`。它复用上游路由生成器，但保留社区 API/edge 内存上限和 heap 配置，按目标服务器检查预算。不能使用 Windows 开发机的内存替代服务器预算。默认 1 实例无需生成。

## 网页与首次密码

Forum 配置 `FLUXER_API_URL` 为浏览器能直接访问的 HTTPS API 基址（包含实际 `/api/v1` 前缀）。Fluxer `FLUXER_APP_ORIGIN_ALIASES` 必须包含精确 Forum 网页 origin；Forum CORS 与 OAuth 回调/领取 origin 必须对应同一个网页。不要填写 `*`。

Discord 登录经过成员资格和一次性 state 校验后，网页仅收到 60 秒的一次性领取码；原生会话不放入 URL。领取接口同时验证浏览器绑定。初次设置原生密码需要新鲜 Discord 登录签发的 120 秒证明，证明绑定用户和当前会话，仅消费一次；已有 MFA 仍需验证，成功后更换原生会话。已有密码不能使用此入口重置。

密码登录直接调用 Fluxer，支持原生 Altcha、TOTP/备用码、邮件 IP 确认和 WebAuthn。WebAuthn 还需要 `FLUXER_PASSKEY_ADDITIONAL_ALLOWED_ORIGINS` 与合法 RP ID：两个网页应部署在同一可用 RP ID 的子域，不能仅通过 CORS 让完全不同注册域名共享 passkey。

## 缓存、失效与故障

Forum 仅缓存会话 token 的 SHA256 键及最小身份结果。正缓存从解析开始最多一小时，命中不续期；明确无效的负缓存 5 秒。RPC、Redis 或 NATS 不可用返回 503，不伪装成未登录，也不继续使用断线前缓存。失效事件与并发缓存写入通过 Redis 代次检查防止旧结果回填；重连更换缓存代次。

API、worker 和 integration 均需具备其各自事件发布凭据。身份停用/会话撤销必须通过原生服务入口；手工修改数据库不会触发事件。事件发布采用尽力交付，没有持久化 outbox：如果只有发布者连接故障而 Forum 连接正常，Forum 不一定切换缓存代次，未收到事件的既有正缓存可能持续到原先最长一小时的 TTL；不能保证立即撤销。新的 RPC 解析会读取权威会话/账户状态并拒绝失效会话。监控 integration `/_ready`（8091，仅容器内）和 Forum RPC 服务信息，并监控原生进程的事件发布失败日志；区分鉴权无效与基础设施故障。不要记录 token、OAuth code、NATS 密码或 RPC 原始请求。

## 本地部署回归验证

安装工作区依赖后运行 `node --test deploy/Odysseia-deploy/deployment.test.mjs`。测试使用已安装的 YAML 解析器展开合并键，检查 Cassandra 后端、依赖图、构建文件路径、凭据隔离、健康端点，以及多 API 资源保留和预算边界。此测试不启动 Docker、WSL、数据库或生产服务，也不替代目标 Linux 主机的 `docker compose config`、镜像构建和实际启动验证。

## 内容事件预留

`nats/content-stream.json` 和 `nats/forum-consumer.json` 定义预建 JetStream 流及 durable pull 消费者。安装仓库依赖后，显式设置 `INTEGRATION_NATS_URL`、`INTEGRATION_ADMIN_PASSWORD` 并运行 `node deploy/Odysseia-deploy/provision-content.mjs`。业务账号不能建流、删流或创建任意消费者。

本阶段不接入实际帖子生产/搜索索引回填，也不启动会丢弃事件的空消费者。未来事件至少包含 event_id、版本、来源、资源 ID、变更版本和时间；消费者在幂等落库后 ACK，失败重试和死信处理需随实际功能实现。当前流保留 7 天、4 GiB，达到容量拒绝新消息，生产者必须检查发布确认；这不是无限历史存档。
