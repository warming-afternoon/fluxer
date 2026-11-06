# Fluxer 集成进程

使用现有 `fluxer_api` 构建流程，在 API 镜像中运行 `node dist/IntegrationEntrypoint.js`。开发命令为 `pnpm --filter fluxer_api start:integration`。集成进程复用原生仓储、Snowflake ID、账户初始化、资产存储、密码逻辑和会话，不启动原生公共 API 或定时任务。

先使用最新原生目标 schema 创建或升级原生库；已有原生库也可逐条执行一次 `upgrade-v3-thread-policy.cql` 补齐 thread 原生基态列。全新集成部署再应用 `schema.cql`；已安装第一版身份表的环境先逐条执行一次 `upgrade-v2.cql`，再应用 `schema.cql` 创建新增表。已有集成身份表还须逐条执行一次 `upgrade-v4-forum-guild.cql`，增加首次创建来源和目标服务器列；不回填历史行。不能只运行 `CREATE TABLE IF NOT EXISTS` 升级既有列。身份权威存储仅支持 Cassandra。现有内部 NATS/JetStream 配置保持独立，原生服务、网关调用和任务发布仍使用内部代理。

| 环境变量 | 含义 |
| --- | --- |
| `INTEGRATION_NATS_URL` | 独立外部集成消息代理地址 |
| `INTEGRATION_NATS_USER` / `INTEGRATION_NATS_PASSWORD` | 当前进程独立凭据 |
| `INTEGRATION_EXCHANGE_KEY` | 64 位十六进制 AES-256 密钥；所有集成副本共享并保持稳定 |
| `INTEGRATION_MAX_INFLIGHT` | 每副本最大并发 RPC；默认 32，上限 256 |
| `INTEGRATION_ALLOWED_REPLY_PREFIXES` | 默认 `_INBOX.forum.,_INBOX.bot.` |
| `INTEGRATION_FORUM_REPLY_PREFIX` | 默认 `_INBOX.forum.`；所有鉴权 RPC 只能回复到此命名空间 |
| `INTEGRATION_HEALTH_PORT` | 默认 8091；提供 `GET /_ready` 和 `GET /_live` |
| `INTEGRATION_GUILD_ID` | 明确指定 Forum 新账号自动加入及内容操作唯一允许的服务器；不得按现有唯一服务器推断 |
| `INTEGRATION_FORUM_CHANNEL_IDS` | 逗号分隔的四个原生论坛 ID，分别对应普通、普通 NSFW、深渊、深渊 NSFW；未配置时内容操作失败关闭 |
| `FLUXER_THREAD_POLICY_ENABLED` | 安装 schema 后在 API、worker 和 integration 一致设为 `true`，启用原生 thread 策略与合并主帖能力 |

原生 API 和 worker 使用各自只允许发布事件的集成代理凭据，变量名相同但值不同。不能向它们发放集成 RPC 服务凭据。Bot 可以调用身份预建/查询，但不能调用会话交换或读取 Forum 回复。Forum 是受信身份断言方，必须完成 Discord OAuth、验证成员资格后才发送 Discord 主体和新鲜验证时间。Bot 也必须验证预建成员来源。NATS ACL 是调用方鉴权边界，不能直接转发浏览器提供的未验证身份。

## RPC 合约

请求统一为 `{version:1,request_id:<16..128位ASCII标识>,...字段}`。响应为 `{ok:true,data:...}` 或 `{ok:false,error:{code,message,retryable}}`。普通请求最多 16 KiB；带有有界初始处罚快照的 `thread.create_service` 单独限制为 64 KiB，不增加鉴权 RPC 上限。身份 ID 使用十进制字符串；会话哈希为 SHA-256 的 base64url 编码；仅接受 `flx_` 原生会话令牌。

| Subject | 额外请求字段 | 返回 data |
| --- | --- | --- |
| `rpc.integration.v1.service_info` | 无 | 检查 Cassandra 和缓存后返回 `{service,version,ready}` |
| `rpc.identity.v1.ensure_discord` | `discord_user_id,profile,operation_id` | `{user_id,discord_user_id,created}` |
| `rpc.identity.v1.lookup_discord` | `discord_user_ids`，1–100 项 | `{bindings:[{discord_user_id,user_id,version}]}` |
| `rpc.identity.v1.login_eligibility` | `discord_user_id` | `{discord_user_id,user_id:string|null,identity_version:number|null,current:boolean,eligible:boolean}`；仅 Forum 可请求 |
| `rpc.identity.v1.profiles` | `user_ids`，1–100 项 | `{profiles:[{user_id,username,display_name,avatar_url}]}` |
| `rpc.auth.v1.external.exchange` | `exchange_id,discord_user_id,verified_at,profile,origin` | `{token,user_id}` |
| `rpc.auth.v1.session.resolve` | `token` | `{user_id,discord_user_id,session_id_hash,username,display_name,avatar_url}` |
| `rpc.auth.v1.session.revoke_current` | `token` | `{revoked:true}`，可幂等重试 |
| `rpc.auth.v1.external.prove` | `purpose:"set_initial_password",token,discord_user_id,verified_at,operation_id` | `{proof,expires_in:120}` |
| `rpc.identity.v1.rebind_service` | `operation_id,actor_user_id,user_id,discord_user_id,reason,profile` | `{user_id,discord_user_id,previous_discord_user_id,merged_user_id,version,actor_user_id,reason}` |

`profile` 为 `{username,display_name:string|null,avatar_url:string|null}`；`origin` 为 `{ip,user_agent:string|null,client_os:string|null}`。`verified_at` 使用 ISO-8601，最多早于当前时间 120 秒或晚于当前时间 30 秒。新交换验证时间新鲜度；匹配的重试可在十分钟内获取原有结果。`request_id`、`exchange_id` 和 `operation_id` 仅接受字母、数字、下划线、连字符。一个 `exchange_id` 只能对应一份不可变请求，重试时仅 `request_id` 可以变化。

## 身份、创建和重试

原生会话解析直接读权威会话行，并复用主线 `AuthSession.isExpiredSsoSession` 的固定三十天 SSO 有效期；近似最后使用时间或 Forum 缓存不会滑动续期。SSO 创建时间缺失、非有限或超出已允许的三十秒外部时钟偏差时拒绝。普通非 SSO 会话原生有效期不变，过期会话仍可请求撤销。

旧 Forum JWT 入口通过 `login_eligibility` 核验当前绑定和原生账号准入；历史归属查询 `lookup_discord`、资料查询 `profiles` 不能替代此授权判断。该能力不签发会话，也不需要或返回 Fluxer token。只有当前 Discord 登录身份且原生账号通过与 `session.resolve` 相同的可用性判断，才返回 `eligible:true`。已知缺失、历史身份或停用账号返回明确否定；绑定准备、重绑、版本变化和依赖故障保持不可用，不能作为准入成功。

`identity_version` 仅表示绑定版本，不是账号安全状态版本。Forum 必须核对本地当前映射的账号和版本，并按账号失效事件的 epoch 防止缓存及在途结果复活。普通准入缓存采用从权威请求开始计算的 30 秒硬期限、不续期，已知否定最多 5 秒；敏感操作实时核验，依赖错误不写否定缓存。角色资格仍由 Forum 按当前 Discord 身份重新检查，不能把此回复当成管理员或深渊资格证明。旧 JWT 缺少原生会话标识时，不声称该能力提供逐原生会话撤销。

Bot 预建与 Forum 外部登录共用 `ensureDiscordAccount`。每个 Discord 身份独立分区，初次正反向占用均采用条件写入。未完成占用保留以便崩溃恢复，先写历史再将绑定标记为完成。不能通过用户名或邮箱推断绑定。已完成绑定指向缺失原生账户时拒绝处理，不重新建号。

管理换绑仅由受信 Forum 管理组后台调用 `rebind_service`：`user_id` 是保持不变的 B，`actor_user_id` 是真实管理员。Forum 必须在入队前验证管理资格，不能把普通用户输入直接当成管理员断言。此接口不要求 B 在线、不保存原始 bearer；普通 `ensure_discord` 与 `external.exchange` 从不触发合并。新 Discord 身份已有原生 C 时，即使 C 已有密码、会话或作品，也将 C 的规范归属投影到 B，停用 C 并撤销 B/C 全部会话，保留 B 密码。原生私信、好友、消息作者以及原生 C 资料不迁移。历史 A1/A2/A3 查询均解析为 B，只有 B 当前反向绑定的 Discord 能用于登录或首次密码证明。旧交换重放也检查当前绑定。

管理操作在 `integration_operations` 永久保存不可变请求指纹、真实管理员、原因、恢复计划和结果；账户行的条件占用在中断后保留，后继不同操作不能覆盖它。同一操作可恢复停用、撤销和规范归属投影；已完成重试只取结果，不再次撤销新会话。操作表也复用为内容 RPC 的永久幂等记录和资源占用，不在其中保存令牌明文。

初始账户没有密码、合成邮箱或共享密码，使用原生用户名预留、条件创建、索引和默认设置。显示名经过原生校验；首次创建优先使用 Discord 用户名（支持字母、数字、下划线及句点，最长 32 位），仅在原生大小写不敏感的重名检查确认冲突时添加稳定的原生 ID 后缀，后缀占用时按序追加尝试号。原生不接受的字符、超长名及保留字先按原生校验降级；名字锁繁忙或存储故障不能误判为重名。创建和 pending 恢复期间均在对应名字锁释放前写入用户名索引；持锁后原生名字已变化时释放旧锁并重新预留当前名。用户行已提交、索引尚未发布期间若名字被其他账号占用，恢复返回不可重试的 `IDENTITY_CONFLICT`，保留原 ID、资料和 pending 状态，不发布冲突索引，也不擅自改名；需要受信操作人员核查并解除冲突后再恢复。绑定中的 username 保存首次首选名，实际账号及后续重试以原生用户行为准；已存在绑定和用户自改资料不随新规则改名。原生名字锁仍使用现有缓存租约；跨存储故障恢复不新增持久唯一性协议。头像只从对应 Discord 身份的 CDN 路径导入，禁止重定向、限制为 2 MiB，并经过原生资产处理。没有自定义头像时传 `null`。后续资料以 Fluxer 为权威，不由 Discord 登录覆盖。

交换元数据永久占用操作 ID，令牌密文十分钟过期，并以交换 ID 作为认证附加数据。密文在唯一一次原生会话创建尝试之前持久化。创建结果不确定时重试相同交换，服务只检查原先准备的令牌，不创建第二个会话。`EXCHANGE_UNCERTAIN` 表示尚未观察到已持久化会话；如果原操作始终没有提交，需要重新完成显式身份验证以开始新登录。重放不能复活已撤销会话。各副本及重试期间必须保持加密密钥稳定。

## Forum 新账号自动加入

只有 `rpc.auth.v1.external.exchange` 在**首次占用**身份时标记 `creation_source=forum`，并持久固定当时的 `creation_guild_id`。必须显式配置有效且存在的 `INTEGRATION_GUILD_ID`；未配置时新 Forum 建号失败关闭，不猜测唯一 guild。若实例启用了单社区模式，其 `single_community_guild_id` 必须与此配置一致。各部署环境分别显式配置自己的目标服务器。

自动加入是账号初始化阶段，在绑定变为 ready 和签发新会话之前完成。普通 Bot `ensure_discord`、管理员 rebind、历史空来源、已有 ready 账号的后续登录均不获得新的入群资格；Bot 不能代为完成尚未结束的 Forum 初始化。Bot 已预建的 ready 账号如需加入，必须由单独授权的迁移/成员操作处理。已完成入群后主动退群、被踢或被封不会因普通登录被拉回。

底层复用原生 `GuildMemberService.addUserToGuild`，与原生 SSO 单社区使用同一成员服务，但不采用会吞掉失败且跳过部分账号限制的 stock-community 包装。所有 ban、账号限制、个人 guild 数及 guild 容量检查保留；`ADMIN_FORCE_ADD` 仅记录来源类型，不意味着绕过限制。不授予管理员或其他额外角色，也不批量调用 Admin force-add API。

初始化先把稳定 joined_at、已有成员状态及 last_left_at 快照写入永久操作日志。重试保留原生成员昵称、角色、timeout 和显式 guild 设置，只补反向索引、必要默认设置及原生 ADD/presence 状态。成员创建使用条件写入。主成员服务的 join/leave/kick/ban 共用有界等待的缓存租约并在副作用前续租；退群/踢出/封禁修改后的恢复计划失败关闭。恢复模式禁止 skip 校验，超过成员离开元数据保留期的旧计划需重新审核。

网关 ADD 与 presence join 可重放状态，但事件交付是至少一次，不承诺仅广播一次。自动加入不发欢迎消息；真正的中断恢复会扫描权威成员数以消除增量是否提交的不确定性，正常首次加入不扫描整 guild。大型 guild 恢复可能较慢。租约不是跨数据库/网关的 fencing 事务；后台直接删除和启动时计数修复并未全部纳入此锁，原生 member_count 仍是可修复投影。

已有部署先备份并升级列，排空并替换全部旧 integration 副本，再开放新 Forum 创建。不要混跑会忽略新来源字段的旧集成进程。既有保留用户补入是另一项审核迁移：必须覆盖用户名 noop 用户，保留 ready 绑定，不伪造来源字段；先审目标 guild、精确保留清单、现有成员与禁封状态，再使用不跳校验的成员操作。

## 受限内容 RPC

以下 subject 仅对 `forum-service` 开放，Bot、浏览器和原生 API/worker 事件发布账号都无权调用。共用字段为 `{version:1,request_id,operation_id,actor_user_id,guild_id}`。Forum 负责作品权限及分类资格裁决，Fluxer 不接收也不解释 work ID；Fluxer 重新读取操作人账号和服务器成员状态，并校验服务器及四论坛允许列表。后台任务保存真实操作人和 operation ID，不保存用户原始 bearer。

| Subject | 额外字段 | 行为 |
| --- | --- | --- |
| `rpc.content.v1.thread.create_service` | `channel_id,name,content,parent_thread_id?,initial_policies?,defer_open?` | 先保存预分配 thread ID，再调用原生建帖；同操作中断重试恢复同 ID 和首消息。创建 Fluxer 主源的子帖时传 `parent_thread_id` 执行通用处罚；Discord 主源不传 |
| `rpc.content.v1.thread.move_service` | `thread_id,target_channel_id` | 同服务器允许论坛间移动，保存原 source 并保持 thread/message ID；中断保留占用，只允许原操作修复 |
| `rpc.content.v1.thread.update_service` | `thread_id,name?,archived?` | 仅委托标题及归档，不授予原生权限或变更成员；原生锁定时不能借此绕过解除归档权限 |
| `rpc.content.v1.starter.edit_service` | `thread_id,content` | 执行原生消息校验与权限；B 可凭规范合并关系修改 C 主帖正文，保留原作者并审计真实 B，不获任意消息编辑能力 |
| `rpc.content.v1.thread.read_service` | `thread_id` | 读取原生首消息 DTO、thread 状态；反应计数使用原生聚合，无全用户反应明细新表 |
| `rpc.content.v1.thread.policy_service` | `thread_id,source,policy_version,kind,active,target_user_id?,expires_at?` | 独立来源的用户发言处罚或外部锁 |

创建返回 `{guild_id,channel_id,thread_id,message_id,state_version,event_id}`；首消息 ID 与 thread ID 相同。移动另返回 `source_channel_id,target_channel_id`。`event_id` 在 RPC 结果中为操作 ID，仅用于关联操作；实际异步内容事件版本由事件发布层维护，不能把 `ThreadState.stateVersion` 当作正文或反应变化的全局版本。读取返回 `{guild_id,channel_id,thread_id,state_version,archived,locked,message}`。

`initial_policies` 最多一百项，每项为 `{source,policy_version,target_user_id,active,expires_at?}`，仅表示用户发言处罚，不接受任意策略类型。受信 Forum 在作品级串行事务中给创建任务保存完整快照；Fluxer 用已持久化的预分配 ID，在原生频道、首帖和网关事件出现前落全部初始处罚，再检查创建人能否创建。中断重试沿用同一 ID 与版本，旧快照不会覆盖更新的处罚。Discord 主来源作品的处罚仅作用于 Forum 和 Fluxer 子卡帖，不能操作 Discord 主帖。后续新增处罚与创建完成之间的并发差异仍由 Forum 的可靠任务和版本对账补齐。

子帖使用 `defer_open:true`：创建前保存独立 `forum_initializing` 来源，初始版本为零；首次网关创建事件前投影为真实锁定/归档，只有该内部创建流程能忽略这一来源写首帖，其他锁、用户处罚和原生权限仍检查。RPC 返回 `deferred_open:true`，不会自行开放。Forum 持久排入当前完整处罚任务，只有前置任务全部完成才用正 `policy_version` 撤销 `forum_initializing`；失败保持关闭。零版本初始化重试不能覆盖较新的解除记录，完成 RPC 重放也不重新锁帖。这样创建意图之后新增的处罚也必须在新子帖开放前对齐。

`kind:"deny_send"` 必须有 `target_user_id`，只禁止该 thread 下发言及新建子帖，不额外禁止正文编辑、读取、收藏、反应或标签；锁定与归档仍按各自规则禁止正文编辑。`kind:"lock"` 不填写目标用户，以 `user_id=0` 保存 thread 级外部来源。服务读取全部持久有效来源，把实际原生 `locked/archived` 投影为“原生基态或外部锁”，同步活动/归档索引、自动归档队列、搜索及网关。原生基态分别保存在 `native_locked/native_archived`；外部生效时原生管理员设置的锁/归档也保留为新基态，不能用原生 unarchive 绕过外部限制。解除一个外部来源不会清除另一个来源或原生基态。首期锁是显式解除，不接受非空 `expires_at`；用户发言处罚仍支持期限。

来源匹配 `forum_[a-zA-Z0-9_-]{1,64}`。Forum 聚合锁使用 `forum_work_lock`，软删除用 `forum_soft_delete`；恢复只撤销自己的来源。`policy_version` 在 `(thread,user,source)` 内单调，旧版本为无副作用重试，同版不同内容拒绝。软删除不调用原生 purge，首期无可恢复 purge RPC。

内容日志记录终止的原生校验失败，重复操作得到相同错误；存储或发布结果不确定时保留计划和资源占用，重试必须沿用同一 operation ID。正文操作保存原消息版本，已完成写入可恢复成功，后来出现不同正文时返回 `MESSAGE_VERSION_CONFLICT`，不把旧请求覆盖回去。

## 合并主帖的受信代理边界

B 对合并账号 C 原生主帖的正文编辑，只由 Forum 完成业务授权后通过 `starter.edit_service` 代理。服务端建立绑定实际 B、服务器和 thread 的异步上下文，原生编辑入口再次核对当前所属服务器及四论坛允许列表；普通 HTTP 不因存在合并映射而自动取得该内部能力。B 自己原有的原生作者权限不变。

代理正文编辑仍按实际 B 执行服务器通信禁用、thread 锁定/归档及其他原生校验，不能套用非作者管理操作的 timeout 例外。审计保留 C 为原消息作者、B 为实际编辑者，不新增通知权限。

## 会话与事件限制

会话解析仍读取权威存储。事件现采用 Cassandra `integration_event_journal` 与外部 JetStream 持久确认，发送失败保留待发记录，恢复时沿用相同 `event_id`。接收端使用 `ODYSSEIA_AUTH/forum-auth` 持久消费者，绑定变更也进入该流。消费端必须在持久 inbox/缓存代次处理成功后 ACK；检测到消费者重建、保留窗口缺口或失去连续性时，必须清空正缓存并重新读取权威状态。敏感操作不能只依赖事件缓存；跨进程撤销不承诺瞬时传播。

日志按固定十六分片保存 `d:` 资源跟踪、`s:` 快照摘要和独立版本、`p:` 待发事件。同分区条件批次原子写快照版本与待发事件，避免仅保存版本却丢失通知。原生消息创建/编辑/删除、逐表情反应、帖子创建/修改/删除路径在写入前持久化资源跟踪，提交后立即重读原生快照；普通读取 404 或依赖失败不会被当作删除，删除事件必须有显式原生删除意图。写前日志存储不可用时不开始对应原生变更。

API、worker 和 integration 进程启动时恢复日志。每秒推进一个分片，最多处理一百条待发与一百条资源跟踪，分别保留键游标并循环覆盖新插入的小键；待发记录无 TTL 或最大重试丢弃。broker 失败保留数据并等待下轮。启动和每轮完成十分钟后对配置四个论坛分页对账，每页二十帖；已关联身份索引每三十秒一页一百条，完整一轮后等待十分钟。对账不扫描历史操作日志或全部原生用户。大量积压与依赖故障会延长恢复时间，不能把上述调度间隔当作端到端最大延迟。

内容流为 `ODYSSEIA_CONTENT/forum-index`，主题 `events.content.v1.thread.changed` 与 `.deleted`。事件包含 `{event_id,occurred_at,platform,guild_id,channel_id,thread_id,state_version,creation_operation_id,snapshot}`，snapshot 包含标题、正文、作者、图片、原生 emoji 对象及各自计数、回复数、归档和锁定状态。`state_version` 是独立投影版本，不使用只覆盖线程元数据的原生 `ThreadState.stateVersion`。创建 RPC 在原生副作用前持久化通用 `creation_operation_id`，消费方据此关联自己的创建任务，避免子帖被误当作新作品。native 独立创建不携此相关性。

原生仓储撤销与账户状态变更发送顶层事件：

- `events.auth.v1.session_invalidated`：`{event_id,occurred_at,user_id,session_id_hash}`
- `events.auth.v1.user_invalidated`：`{event_id,occurred_at,user_id}`
- `events.identity.v1.binding_changed`：`{event_id,occurred_at,discord_user_id,user_id,version}`

管理绑定事件另含 `kind:"managed_merge"|"binding_changed",operation_id,actor_user_id,previous_discord_user_id,merged_user_id?`。消费方只有在明确管理合并上下文匹配时才迁移历史归属。普通预建或登录不会把历史别名重新选为当前身份，也不会发送缺少管理上下文的跨用户改绑事件。
本版本管理绑定事件还携带权威 `affected_user_ids` 完整直接受影响主体集合：首次绑定和普通换绑为 `[user_id]`，管理合并为 `[user_id, merged_user_id]`。消费方须先在同一失效屏障中推进全部主体，再等待资料或数据库投影；不能依赖随后不同 subject 的 `user_invalidated` 到达或回调顺序。旧事件缺少完整集合时应保守失效整个认证缓存代次，不猜测旧主体，也不把历史归属当作当前准入。


事件与错误响应不包含令牌、密码或证明。`INVALID_TOKEN` 和 `ACCOUNT_UNAVAILABLE` 表示鉴权失败；`UNAVAILABLE`、`STORAGE_UNAVAILABLE`、`BUSY`、`EXCHANGE_UNCERTAIN` 表示可重试的依赖/处理失败，不能作为鉴权成功。`PROOF_NOT_AVAILABLE` 表示正常登录可以继续，但不满足首次密码设置条件。

## 首次密码与验证

证明绑定用途、用户和当前会话，两分钟后过期，由 `POST /users/@me/discord-password` 原子消费。原生接口核对权威会话及新鲜账户状态，保留已启用的 MFA/sudo 校验，校验新密码并轮换原生会话。普通 SSO 账户不能获得这一能力。正常外部登录不额外增加第二次 MFA。

运行 `vitest run src/integration` 执行本地测试。可选真实 NATS 测试仅在设置 `INTEGRATION_LIVE_TEST_CONNECTION` 后启用；旧测试元数据包含 `port`、`forum_password`、`fluxer_password`。部署 ACL 测试另需 `isolated_test:true`、`passwords:{FORUM,BOT,SERVICE,API,WORKER,ADMIN}`、`server_user:"fluxer-integration"`、`client_user:"forum-service"`、`server_inbox_prefix:"_INBOX.integration"`，连接仅使用 `127.0.0.1`，以临时随机凭据启动独立 broker 并加载部署配置。该测试会 PURGE 两条专用测试流，只能在显式确认隔离的临时代理执行。测试使用真实消息传输和 ACL，原生仓储仍使用内存实现。离线 API 测试替换生产就绪探测，不启动 Cassandra/NATS；真实 Cassandra 条件写入及完整容器启动仍需目标环境验证。


创建相关事件在 integration_operations 结果持久成功且原生 thread/message ID 匹配之前不发布可见快照。pending 仅保留源端跟踪；终止失败清理暂态待发和跟踪，同时保留失败哨兵防止目录对账误建作品。回滚后同 prepared ID 重试成功只投影最终权威内容，无 correlation 的原生创建不受此门槛限制。快照包含当前原生 applied tags 的 id/name/emoji；native_locked/native_archived 与 external_locked 分开，消费者不能把有效外部锁回写成原生限制。CAS 冲突必须重新读源内容，d: 资源记录保留独立版本高水位以防 s: 版本行重建降版。


## 独立 NSFW 显示偏好

原生 `user_guild_settings.show_nsfw/nsfw_version`，仅明确的 `INTEGRATION_GUILD_ID` 生效；它不是年龄证明。现有库须在新 API 启动前执行一次 `fluxer_api/src/integration/upgrade-v5-nsfw-display.cql`（全新目标 schema 已含列），不可只运行 CREATE TABLE IF NOT EXISTS。同步更新先关闭并确认旧 Gateway 会话/重放，再写原生 CAS；故障可能保持关闭，使用同一版本安全重试，不承诺跨库回滚。Forum 只调用明确列出的 preferences RPC，Bot 无权调用。

部署顺序、离线授权、集群预期节点、故障恢复及已签发媒体 URL 的边界见 `docs/maintenance/forum-nsfw-display-preference.md`。必须先排空/替换旧 Gateway，再开放新偏好写入。多节点集群须配置实现要求的预期节点列表，失联不得当作撤销完成。

### Bidirectional Forum NSFW switch synchronization

Both native Fluxer and Forum preference updates use `NsfwDisplayPreferenceService` and the same Cassandra version authority. After the gateway replay fence is confirmed, Fluxer sends `rpc.forum.v1.nsfw.apply` with exactly `{version: 1, request_id, user_id, guild_id, show_nsfw, nsfw_version}`. The target remains the explicit `INTEGRATION_GUILD_ID`. Forum persists only this display preference and its version guard; it must not call Fluxer back from this receiver.

Success requires `{ok: true, data: {user_id, guild_id, show_nsfw, nsfw_version}}` matching the requested identity, scope, boolean and version exactly. A newer Forum version is not success for an older request. Timeout, malformed or mismatched replies retain the durable native intent; reconciliation reads and retries the latest native winner rather than overwriting it. Gateway fencing always precedes Forum application, including CAS-loser recovery.

The requester shares the existing per-process integration publisher connection and server identity. Connection setup is bounded to 3 seconds, each apply request to 8 seconds, with at most 32 apply requests in flight per process. Missing broker URL or credentials fails closed. The deployed ACL permits only `fluxer-api`, `fluxer-worker` and `fluxer-integration` to publish this subject; only `forum-service` subscribes, with bounded reply permission (15 seconds). Forum and bot clients cannot publish this subject. Deploy the Forum receiver and compatible ACL before enabling this synchronized update path; during an unavailable receiver, native changes remain durable but requests fail rather than reporting false synchronization.
