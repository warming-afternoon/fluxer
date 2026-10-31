# 单次消息内的线程投递上下文

`guild_thread_gate:thread_sessions/6` 保留自适应成员/在线侧候选选择。最终 fold 中首个通过发送设备、map、viewer 和 pending 检查的会话才构造投递上下文；同一次同步调用复用父频道类型、解析后的帖子 ID、已加载帖子是否存在、快照成员与 store 标识。

成员资格在原投递资格和兴趣判断的位置逐次直接读取。fold 不携带成员结果 map；重复设备与重复判断保持直接 ETS 语义。候选的成员命中不代替最终权限检查。

只有 store 不存在，或者当前进程拥有该 protected/private ETS 表时才复用。public 表或其他 owner 的表继续走原逐会话路径，保守保留其他进程可能修改成员关系时的语义。非法表标识也回原路径，保留原错误表现。guild handler 的本次筛选内部没有 receive 或状态修改。

延迟上下文保证候选为空、viewer 不符或 pending 会话不会额外触发原先跳过的读取和解析。bot/member-list 短路、直接提及、passive 订阅及缺失帖子的成员快照保留原判断顺序；role mention 不扩大受众。browser watch 仍对每个 SID 实时检查租约，租约结果不复用。

每个有兴趣的会话仍调用最终 `thread_access`，保留已有权限 memo 与父频道快速路径。消息限制和私帖权限仍由该检查处理。没有跨消息缓存，没有修改会话、租约或 ACK 状态，也不改变 relay 顺序。

有界 oracle harness 为 `guild_message_reuse_tests.erl`，通过 `ADAPTIVE_ORACLE` 开启，对整合前 dev 的 gate精确比较候选 map 与排序后的最终 SID/session pair。覆盖大/小集合、相等/零基数、unknown count、成员变更、归档/删除/导入/重连、权限、多设备、租约、快照与成员直接读取变更。测试所需的额外导出仅存在于隔离 harness。交接包测试文件不新增到产品测试目录，已执行的命令和结果见交付包验证说明。