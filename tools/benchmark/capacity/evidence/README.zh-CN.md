# 通用容量证据工具

这些 Node 模块只在显式调用时工作，import 不启动服务、进程、网络或文件操作，不运行压测。源码来自执行索引中的 R21 `DeliveryAudit.mjs`、`future-runtime/OfflineEvidence.mjs` 和 `future-runtime/PhaseEvidence.mjs` 校验部分；不代表恢复了缺失的 R22 生成后分析器/runner。

- `DeliveryAudit` 保留精确十进制/BigInt 序号、单调时钟、实际 actor 插入顺序、有界实收位图、唯一实收/重复/缺失和 formal/tail 区分。`finalize()` 封存，`checkpoint()` 仍是可继续观察的预览。`mergeSnapshots()` 核对完整 worker/actor 覆盖，拒绝预览与终稿混用；预览合并必须显式传 `allowCheckpoints: true`。传入 `bitmapDataByWorker` 才会验证原始位图长度、摘要与位数，防止用计划扇出或摘要假充实际唯一实收；未提供原始位图则 `bitmapDataVerified=false`。这不能证明数据库 ACK 持久化或 WebSocket clean close。
- `validatePhaseBoundaryEvidence` 校验既有 observed-phase DTO、完整运行/attempt/阶段/时钟身份、来源引用和精确时钟顺序；绑定到已知场景时还应传入预期身份/摘要字段，不读取来源文件，也不冒充完整私有场景合同验证。拒绝不安全 Number 时钟；纳秒使用十进制字符串。
- `OfflineEvidence` 仅复制调用者明确选择的文件列表到全新分离目录，核对复制前后和副本摘要，拒绝符号链接、上跳路径与覆盖。失败保留已复制文件和 `BUNDLE-FAILURE.json`。`verifyEvidenceBundle` 离线核验文件和预期身份；`writeDerivedJson` 不覆盖旧结果。
- `ArtifactIdentity` 是**本次新增的小型整合适配器**，不是从缺失 R22 生成文件恢复的 DTO。合同为 `{runId, attemptId, stageId, scenarioSha256, artifactKind, visibility}`，`artifactKind` 区分 `preview/final`，`visibility` 区分 `private/out`；验证副本时所有字段必须一致。`deriveArtifactDirectory(root, identity)` 仅派生分离路径而不创建文件。这是工件身份标记，不保证调用者选入的文件已脱敏。

使用时显式传递源/目标根目录、身份、文件列表和必需路径，示例见英文说明。没有硬编码 WSL、私有账号、IP、容器或部署身份。既有 `VerifyAckCursors.mjs` 继续负责受保护的数据库游标核验，本次没有重复实现。定向测试放在交付包外部验证夹具，不进入分支产品补丁。

明确缺项：所供 `DeliveryAudit` 只导出原始位图。最终流式压缩、逐值恢复、CRC 和 fixed-written ring 读取器源码不在现有依赖闭包，因此没有声称实现或根据报告编造这些功能。本次未运行容量压测、真实数据库/设备/集群或故障注入。
