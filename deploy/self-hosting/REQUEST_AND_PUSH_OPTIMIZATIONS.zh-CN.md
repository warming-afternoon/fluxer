# 请求鉴权、联合限流与推送清理传输

[English](REQUEST_AND_PUSH_OPTIMIZATIONS.md)

本版本默认启用三项请求/通知优化：合并频道鉴权 Gateway RPC、有序全局/接口限流，以及逐项保留结果的推送通知清理批传输。显式 `false` 保留原路径。必须部署完整实现，不能仅给旧二进制增加环境变量。

| 进程 | 配置 | 默认值及关闭行为 |
|---|---|---|
| API/worker | `FLUXER_COMBINED_CHANNEL_AUTH_ENABLED` / `services.api.combined_channel_auth_enabled` | `true`；false 恢复原来的独立鉴权调用 |
| API/worker | `FLUXER_COMBINED_RATE_LIMIT_ENABLED` / `services.api.combined_rate_limit_enabled` | `true`；false 恢复分开的全局/接口检查 |
| Gateway 发送端 | `FLUXER_GATEWAY_CLEAR_BATCH_ENABLED` / `services.gateway.clear_batch_enabled` | `true`；false 恢复逐个发送清理请求 |
| 每个 Push 接收端 | `FLUXER_PUSH_CLEAR_BATCH_ENABLED` | `true`；false 拒绝清理批次，因此只能在所有批发送端及未完成任务排空后关闭 |

单节点 KV 使用一次有序脚本，KV Cluster 保留顺序单键检查。配额、TTL、权限、MFA、NSFW、私有帖子成员与已读状态保护均保留。帖子浏览/订阅功能和订阅并发不变。旧配置中显式 false 仍是 false；更新 `.env.example` 不会迁移运营配置。

## 构建并识别发布产物

源码构建覆盖让 API 与 worker 共用一个镜像，不更改其他服务的镜像固定值。`FLUXER_PRODUCT_BUILD_TAG` 指定三个本地产品镜像的不可变标签，`FLUXER_SOURCE_SHA` 标识当前源码。旧 `FLUXER_BCD_IMAGE_TAG` 仅在新的描述性标签变量未提供时作为兼容别名保留，不是功能开关。上述四个行为配置继续沿用既有名称。

在本目录执行，`.env` 中须有常规必填密钥/域名：

```sh
export FLUXER_SOURCE_SHA="$(git rev-parse HEAD)"
export FLUXER_PRODUCT_BUILD_TAG="request-push-${FLUXER_SOURCE_SHA}"
docker compose -f docker-compose.yml -f request-and-push-optimizations.compose.yml config --quiet
docker compose -f docker-compose.yml -f request-and-push-optimizations.compose.yml build api gateway push
# 仅适用于新安装；已有集群必须按后文分阶段过渡。
docker compose -f docker-compose.yml -f request-and-push-optimizations.compose.yml up -d --no-build
```

记录有效 Compose、源码 SHA、镜像 ID/digest 与开关。镜像仓库部署可另行发布这些相同镜像并固定 digest。旧发布镜像不会因新环境变量而获得实现能力。Gateway 必须使用完整 `rebar3 as prod release`，确保 `.app`、beam、`start.script`、`start.boot` 配套；不得把新 beam 覆盖到旧 embedded release 或改用 interactive 加载。接入流量前检查服务健康、镜像身份、embedded 启动和 `guild.get_channel_authorization` 能力。

## 已有安装：先接收端和 RPC 能力

不支持对旧 Gateway/Push 进行默认全开启、未协调的滚动更新。过渡期间把 `request-and-push-compat.compose.yml` 放在文件列表**最后**：关闭两项 API 合并操作及 Gateway 清理批发送，同时保留升级后的 Push 接收端对两种协议的接收能力。

1. 保留有效配置与镜像 digest。替换任何二进制前，明确关闭两项 API 开关和 Gateway 清理批发送。受控维护/排空窗口内重建相关进程；内存 outbox 任务不能在重启后持久恢复。
2. 升级每个 `push.job.clear` NATS queue group 中的所有 Push 副本，接收能力设 true。新接收端兼容逐个请求。任何接收端仍旧版或关闭时都不能发送批次，因为请求可能落到 queue group 任一副本。
3. 将所有 Gateway RPC 端点及实际 guild owner 升级为完整新 release，清理发送端仍为 false。API 关闭合并鉴权时仍使用旧方法。没有 unknown-method/超时回退；兼容解码只给新方法已成功返回的响应补充字段。
4. 验证所有 Gateway 能力后，在全部 API/worker 开启两项 API 开关。另行暂停所有相关生产者、排空每个发送端/接收端，再把 Gateway 清理发送端重启为 true。
5. 核对两项 API 开关及每个发送/接收端均为 true。持久保存配置，监控失败、重试、过期、丢弃、排队和在途任务。

移除兼容覆盖必须分阶段，不能一次全栈更新。能力核对后，先更新 API/worker，保持清理发送端关闭：

```sh
FLUXER_COMBINED_CHANNEL_AUTH_ENABLED=true FLUXER_COMBINED_RATE_LIMIT_ENABLED=true \
FLUXER_GATEWAY_CLEAR_BATCH_ENABLED=false FLUXER_PUSH_CLEAR_BATCH_ENABLED=true \
docker compose -f docker-compose.yml -f request-and-push-optimizations.compose.yml up -d --no-deps --no-build api worker
# 先暂停生产者并确认排空，再单独更新发送端。
FLUXER_COMBINED_CHANNEL_AUTH_ENABLED=true FLUXER_COMBINED_RATE_LIMIT_ENABLED=true \
FLUXER_GATEWAY_CLEAR_BATCH_ENABLED=true FLUXER_PUSH_CLEAR_BATCH_ENABLED=true \
docker compose -f docker-compose.yml -f request-and-push-optimizations.compose.yml up -d --no-deps --no-build gateway
```

命令局部环境值不会修改 `.env`，须持久保存。上述命令不会替你升级/检查接收端或建立排空证明。仅暂停 HTTP 不足以阻止 WS、worker 或后台任务继续入队。检查各 Gateway 原生 `push_outbox:stats/0`、可用的 queued/inflight/followup/retry 状态和 Push 运行/排队任务，确认没有新生产，也没有把丢弃/过期误当成排空。benchmark 诊断计数不是产品持久性 API。不能审计排空时，保留兼容二进制/开关并安排维护窗口，不承诺无损重启。

## 关闭和回退

开始时保留当前 Gateway RPC 能力，所有 Push 接收端保持 true。

1. 关闭两项 API 开关，重建全部 API/worker；任何 Gateway 降级前，等待旧合并鉴权请求及错误映射结算。
2. 暂停生产者，保持接收端 true，排空各 Gateway queued/inflight/followup/retry 任务；逐个重启发送端为清理批发送 false，再恢复生产。开关在进程初始化读取，修改文件不会重配运行中的 outbox。
3. 所有批生产者、在途/重试请求及接收端任务结束后，才可关闭或降级接收端。不确定时保留接收能力。toggle 不会撤回已发批次，旧/关闭的接收端会拒绝批次，重试可能过期。
4. 只有全部 API 关闭合并鉴权且旧请求结算后，才可把 Gateway 降级至不支持 `guild.get_channel_authorization` 的版本。

队列/去重基于内存和 TTL，不是持久事务 outbox，也不保证跨实例 exactly-once。Push 优雅关闭有期限，进程退出或队列为空本身不是无损证明。使用协调的容器/进程重启；不支持对旧排队条目进行 OTP 热升级。

## 已接受行为与性能限制

帖子鉴权路径仅在父频道验证后，将合并 RPC 与独立数据库读取重叠。为避免孤儿任务，异常路径会等待已启动 RPC 结算，再返回原优先级错误。因此 DB 失败或缺帖子 state 可能把原本很早返回的错误拖到客户端 deadline。该行为已接受；错误时序并非普遍等价，总返回耗时也没有统一的严格 30 秒保证。

已有单组测量显示 ACK HTTP、端到端 ACK 和排空有正面信号，但发送/投递没有一致优于前后两个基线。时间/资源漂移及固定顺序限制归因，不构成统计确定的吞吐保证。部署决策仍需针对实际 release 检查健康、正确性和容量。
