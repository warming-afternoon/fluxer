%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_thread_watch_metrics).
-typing([eqwalizer]).
-export([init/0, register/1, record/2, counts/0, leases/0]).

-define(REGISTRY, guild_thread_watch_registry).
-define(KEY, {?MODULE, counts}).
-define(KINDS, [
    updates,
    limit_rejected,
    metadata_hits,
    metadata_misses,
    metadata_fetches,
    metadata_failures,
    expired,
    processing_microseconds
]).

%% 在应用初始化进程建立注册表和固定维度计数器
-spec init() -> ok.
init() ->
    case ets:whereis(?REGISTRY) of
        undefined -> ets:new(?REGISTRY, [named_table, public, set]);
        _ -> ok
    end,
    guild_thread_store:ensure_counter(?KEY, length(?KINDS)).

%% 只在创建浏览存储时注册，不增加续期热路径开销
-spec register(ets:table()) -> ok.
register(Tab) ->
    case ets:whereis(?REGISTRY) of
        undefined ->
            ok;
        _ ->
            ets:insert(?REGISTRY, {Tab}),
            ok
    end.

%% 使用固定操作类型，禁止把帖子或会话标识作为指标标签
-spec record(atom(), integer()) -> ok.
record(Kind, N) ->
    Index = index(Kind, ?KINDS, 1),
    guild_thread_store:add_counter(?KEY, Index, N).

%% 查找固定计数器位置
-spec index(atom(), [atom()], pos_integer()) -> pos_integer().
index(Kind, [Kind | _], N) -> N;
index(Kind, [_ | Rest], N) -> index(Kind, Rest, N + 1).

%% 导出累计操作和耗时，调用方可计算速率和平均处理时间
-spec counts() -> map().
counts() ->
    case persistent_term:get(?KEY, undefined) of
        undefined ->
            #{};
        Counter ->
            maps:from_list([
                {Kind, counters:get(Counter, index(Kind, ?KINDS, 1))}
             || Kind <- ?KINDS
            ])
    end.

%% 指标采集只读取每个服务器的计数行，不扫描浏览关系
-spec leases() -> non_neg_integer().
leases() ->
    case ets:whereis(?REGISTRY) of
        undefined -> 0;
        _ -> lists:sum([lease_count(Tab) || {Tab} <- ets:tab2list(?REGISTRY)])
    end.

%% 已退出服务器的存储由采集路径顺便移出注册表
-spec lease_count(ets:table()) -> non_neg_integer().
lease_count(Tab) ->
    try ets:lookup(Tab, {z, leases, 0}) of
        [{_, Count}] -> Count;
        [] -> 0
    catch
        error:badarg ->
            ets:delete(?REGISTRY, Tab),
            0
    end.
