# 频道鉴权 RPC 合并与有序联合限流

[English](CombinedApiOptimizations.md)

两项配置在 master、环境加载与 self-hosting Compose 中都默认 `true`，显式 `false` 可分别关闭，无需 schema 迁移。已有安装必须遵循[部署指南](../../deploy/self-hosting/REQUEST_AND_PUSH_OPTIMIZATIONS.zh-CN.md)先具备能力再开启；不能对旧 Gateway/Push 未协调滚动启用新默认。

| 环境变量 | Master 配置 | 行为 |
|---|---|---|
| `FLUXER_COMBINED_CHANNEL_AUTH_ENABLED` | `services.api.combined_channel_auth_enabled` | 一个 Gateway RPC 返回频道鉴权所需 guild 上下文、成员与权限 |
| `FLUXER_COMBINED_RATE_LIMIT_ENABLED` | `services.api.combined_rate_limit_enabled` | 一个单节点 KV 脚本先检查全局限制，再扣接口桶额度 |

## 频道鉴权升级

API 开启前先部署支持 `guild.get_channel_authorization` 的 Gateway。版本化响应绑定 guild、上下文频道、权限目标、模式与成员身份。拒绝、过载、超时、未知方法和畸形版本化响应都失败关闭，不分拆回旧鉴权调用；无版本响应仅能补缺失成员或权限字段。私有帖子成员、timeout、NSFW 和 MFA 检查仍在 API 鉴权路径。回退到不支持该方法的 Gateway 前先关闭 API 开关。这不替代帖子浏览或 watch context RPC。

## 联合限流

全局拒绝不动接口桶，接口拒绝保留全局扣额。邮箱桶随后独立检查；绕过、豁免路由、会话撤销和响应头行为不变。KV Cluster 使用原顺序单键调用，避免跨 slot 脚本；开启并不减少 Cluster 往返。

只有 `NOSCRIPT` 使用相同参数重试。超时、连接错误、畸形结果属于未知结果，不得随后单独重复扣全局/接口额度。共享单键 Lua 仍作为漏桶、TTL 与 reset 计算的参照。

集成测试沿用 `FLUXER_C_TEST_VALKEY_URL` 和可选的 `FLUXER_C_BASELINE_KV_SOURCE` 稳定测试变量；它们分别指定一次性隔离 Valkey 地址及含原单键 Lua 常量的参考源码。测试会在用例之间清空指定数据库，只能使用可丢弃实例。单元测试还覆盖 Cluster 回退与未知结果。
