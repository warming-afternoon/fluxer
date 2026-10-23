# 推送通知清理批传输

[English](ClearBatchTransport.md)

Gateway 发送端 `services.gateway.clear_batch_enabled` / `FLUXER_GATEWAY_CLEAR_BATCH_ENABLED` 和 Push 接收端 `FLUXER_PUSH_CLEAR_BATCH_ENABLED` 均默认 true，显式 false 用于分阶段更新和回退。已有集群须遵循[部署指南](../../deploy/self-hosting/REQUEST_AND_PUSH_OPTIMIZATIONS.zh-CN.md)先能力后开启。先给 `push.job.clear` NATS queue group 的**全部**成员部署接收能力，再开启发送端。回退接收能力前，先暂停相关生产者并保持接收端开启；排空各发送端 queued/inflight/followup/retry 任务后，再将发送端重启为批发送关闭。所有已发批次及接收端任务结束后，才回退接收端。混合开启/关闭接收端会导致拒绝和重试，不会静默成功；不存在能确认未处理条目的兼容回退。

继续支持版本 1 请求。版本 2 最多合并 32 个连续 clear，最多等待 5ms，每项原 user/channel/message/after-message frontier 与稳定条目身份在重试中保留。message/ring 是 FIFO 分组屏障。Gateway 在途 96 与 Push 队列容量计算逻辑条目而非信封。每个结果必须匹配唯一原条目；缺失、重复、失败、超时或无版本响应只重试受影响条目，成功兄弟项保持完成。沿用原过期/退避和 after-message followup 规则。

这仅分组传输与复用查询，不做语义游标合并或持久投递。Gateway 队列与 Push 完成去重仍在进程内存中，重启/丢失保证不变。不新增任务丢弃、限额增加、CAS 变化、订阅 batcher 并发调整或 read frontier 放宽。

帖子目录和浏览订阅仍启用。协调发布时须验证权限、逐项结果和无损排空，批传输不能绕过这些正确性要求。

使用容器/进程重启部署。本版本不迁移 OTP 热升级时的旧内存 outbox 条目，不要在升级前已运行的队列上直接开启批处理。
