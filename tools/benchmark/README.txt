论坛 HTTP/WebSocket 压测工具

运行前保持原应用关闭，只运行一套测试服务。本目录工具默认仅允许 loopback 目标。

先生成私有精简夹具（保留原始夹具，输出必须是新文件）：
node tools/benchmark/prepare_forum_fixture.mjs --source /绝对路径/原始.private.json --out /绝对路径/compact.private.json --max-online 10000

输出包含登录凭据，权限0600，不要加入Git或公开报告。服务端20万成员、3万帖子及历史数据保持不变。
工具保留所选用户、活跃帖子、双向加入关系，用整数下标表示成员。加载时验证双向关系一致。

无页面服务的Compose覆盖层：
docker compose <既有压测配置参数> -f /绝对路径/tools/benchmark/headless.compose.yml up -d

app-proxy、static-proxy、admin 默认不启动。需要页面时显式 --profile benchmark-ui。
保留edge的原API/WebSocket路由、媒体后端及核心后台，API并发保护默认512不变。
使用当前仓库的 Compose 文件，并显式叠加此覆盖层；不依赖其他机器的临时脚本。
只执行 config --format json 并检查筛选字段，避免将包含私密环境变量的完整配置输出到报告。

运行工具（使用Node 24或更高版本；JSON计划中每项可覆盖ackConcurrency）：
node --max-old-space-size=512 --expose-gc tools/benchmark/forum_load.mjs --fixture /绝对路径/compact.private.json --out /绝对路径/新结果目录 --online-steps 2000,2500,3000 --plan /绝对路径/plan.json --connect-concurrency 16 --ack-concurrency 128 --stop-file /绝对路径/STOP --sequence-base 4000000

计划示例：
[{"name":"global20","rate":20,"seconds":30},{"name":"global50","rate":50,"seconds":30},{"name":"global100","rate":100,"seconds":30},{"name":"burst1000","burst":1000,"concurrency":16}]

每次发送、投递仍逐人检查；每次投递仍单独HTTP确认，同一用户串行，不合并、不重试。
内部用数字保存接收/确认集合，预期读者集合在同帖子消息间共享，结束时再将ID还原为报告格式。
完成消息用位图保留整轮重复投递检测；逐条延迟统计及越权、重复、缺失检测保留。

需要同时运行原有Mac/Docker/工具内存保护采样。--max-old-space-size=512限制的是V8旧生代，不等于RSS上限；不得因为工具精简就取消Mac保护线。
固定速率阶段的完整排空耗时超过计划窗口的1.2倍，或出现错误，就停止增加人数。
最高完整通过人数和单纯成功连接数含义不同，不能把未通过全部压力阶段解释成无法同时在线。

离线正确性验证：
node --test tools/benchmark/ForumLoadFixture.test.mjs tools/benchmark/ForumLoadTool.test.mjs tools/benchmark/FrontendAckQueue.test.mjs

mock_forum_transport.mjs仅用于离线测试，模拟fetch/WebSocket，不能作为应用容量结果。
工具的离线测试不构成应用容量验证；实际负载结果应关联源码版本、完整参数和机器资源。

频道元数据缓存与清除通知设备批查对照：
FLUXER_CHANNEL_METADATA_CACHE_ENABLED=true：PostgreSQL 元数据缓存，容量50000，LRU，固定有效期300秒。
数据库触发器在事务提交后通知失效；监听中断清空并绕过缓存；Cassandra新增共享缓存默认关闭，关闭时保留原已读独立缓存。
每个启用缓存的API/worker进程增加一条不占查询连接池的专用监听连接；DDL安装失败则关闭缓存并记录告警。
FLUXER_PUSH_SUBSCRIPTION_BATCHING_ENABLED=true：清除通知任务的设备查询使用5毫秒窗口，每批最多100个不同用户，同时最多2批。
设备列表不跨批缓存，任务仍分别完成；队列容量沿用FLUXER_PUSH_SERVICE_QUEUE_CAPACITY，排队最长5秒。
两个开关均默认开启，通过关闭对应开关并重启相关服务回退。数据库触发器会保留，关闭缓存不删除数据库设施。

元数据缓存开关已统一支持两种后端。PostgreSQL默认频道开、社区关；Cassandra两项默认关。
FLUXER_GUILD_AVAILABILITY_CACHE_ENABLED=true开启社区窄快照，默认容量10000、固定有效期1秒，只存可用性标记，不缓存权限结论。
帖子缓存仍为50000条、LRU、固定5分钟。Cassandra opt-in使用Valkey尽力广播和本地固定TTL；启用前必须阅读：
fluxer_api/src/api/database/CassandraMetadataInvalidation.md
所有API/worker统一版本、开关与部署命名空间；直接CQL维护写入没有通知，遗漏由固定TTL兜底。
通知失败不影响数据库写入；旧JetStream日志停止使用且不自动删除。通知队列有界，溢出合并为类别清空。
NATS调用栈收集保持原样；未迁入noAsyncTraces或依赖补丁。用户资料批查也未启用或迁入。

原始 events/resources/messages 日志完整保留，不设文件体积上限。

默认 --ack-mode strict：仍逐条逐人真实HTTP确认，无合并和重试，沿用原容量验收。
可另测 --ack-mode frontend-batched：3秒首截止、每频道最新游标、每次最多100频道，按用户轮转公平分配槽位。
批量场景必须收到权威响应游标覆盖才计成功；所有接收者自动阅读，不能冒充严格场景或实际用户阅读分布。
结束会生成0600的expected-ack-cursors.json，须在同一测试Cassandra状态上独立只读核验：
FLUXER_BENCHMARK_RESET_DISPOSABLE=yes node tools/benchmark/VerifyAckCursors.mjs /绝对路径/expected-ack-cursors.json /绝对路径/新游标核验结果.json
默认核验127.0.0.1:29042、datacenter1、fluxer_benchmark；可通过FLUXER_CASSANDRA_HOSTS/PORT/LOCAL_DC/KEYSPACE覆盖，认证使用FLUXER_CASSANDRA_USERNAME/PASSWORD环境变量。
核验使用LOCAL_QUORUM，分别统计missing/behind/ahead，必须完全相等才通过；运行期间停止该库的其他写入。
保留FLUXER_BENCHMARK_RESET_DISPOSABLE=yes保护，非loopback还需FLUXER_BENCHMARK_ALLOW_REMOTE=yes。输出使用wx拒绝覆盖，摘要不写凭据或业务ID。
暖态恢复、状态复用和启动流水线未迁入，本工具明确拒绝这些实验选项，正式对照每轮恢复同一标准语料。
人数从2000开始，每档仍测20/50/100条每秒及1000突发；整档通过才增加500人，资源保护和1.2倍完成期限保持不变。
正式对照保持相同资源额度、压测器和夹具；先测旧镜像基线，再测仅缓存，最后测两项同时启用。
每组单独记录启动/登录同步、预热和正式负载；不能将冷启动差异当成稳态优化效果。
每组以20/50/100条每秒各30秒，以及1000条突发（发送并发16）测试；ACK并发128，连接并发32。
首次2000人档全部通过后每次增加500；单独成功连接不代表整个负载档位通过。
如需按资源余量继续探索，可显式添加 --continue-after-capacity-failure true。
该选项只允许在零错误、全部送达和确认完成但处理偏慢时继续；错误、漏消息、异常断线和资源保护仍会停止。
highestCapacityPassedOnline 记录完整满足吞吐验收的最高档位；不要将 highestPassedOnline（正确性通过）解释为稳定容量。

凭据和输出保护：夹具应使用随机生成的合成账号凭据；输出可能包含合成账号 ID 与环境信息，分享前需脱敏。不要提交 *.private.json、*.env、数据转储或测量结果。
