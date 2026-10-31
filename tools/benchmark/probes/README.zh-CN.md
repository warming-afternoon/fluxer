# 指标子进程输出契约

`metrics-probe.mjs`、`push-metrics-probe.mjs` 和 `gateway-probe.mjs` 使用 `ChildJsonLines.mjs` 收集子进程的逐行 JSON 输出。只有子进程 `close` 后才检查尾部是否完整；`exit` 不代表 stdout 已排空。

每条 JSON 必须使用合法 UTF-8、为对象并以换行结束，默认单行上限为 16 MiB。完整记录继续追加到既有 JSONL 文件；截断、解析失败、写盘失败、子进程非零退出或信号退出使探针失败。无效或未完成的记录保存到同名 `.partial` 文件，错误追加到 `.errors.jsonl`。超限行分块保存，不无界累积到内存。输出路径和实例身份继续沿用 `environment.mjs` 的显式环境配置，不添加自动启动或生产观测钩子。

这些文件仅证明指标收集的管道完整性，不证明业务 WebSocket 的 clean close、ACK 持久化、游标一致性或容量通过。不得把子进程退出或容器停止解释为客户端正常关闭。

本次修复来自现有 test 分支中两个探针在 `exit` 时立即退出、第三个探针吞掉解析错误的实际代码审查。材料包没有最终容量 runner、finish-contract 和 offline-contract 源码，因此本模块不冒充那些工具的移植，也不声称具备其 gzip/CRC、actor order、阶段工件身份或固定 ring frontier 验证能力。
