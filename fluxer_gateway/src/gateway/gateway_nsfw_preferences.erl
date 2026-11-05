%% SPDX-License-Identifier: AGPL-3.0-or-later

%% 显示偏好独立于角色、年龄限制和成员关系；投递路径不执行 RPC。
-module(gateway_nsfw_preferences).

-export([
    init/0,
    scope/0,
    seed_scope/1,
    from_startup/1,
    import/2,
    attach/2,
    attach/3,
    detach/0,
    register_socket/3,
    socket_pids/0,
    forget_socket/1,
    connect_allowed/3,
    current/2,
    allowed/3,
    channel_allowed/3,
    channel_sensitive/2,
    apply_permissions/4,
    sync_local/1,
    sync_cluster/1,
    begin_local/1,
    begin_local_with_read/2,
    begin_cluster/1,
    fenced/2,
    requires_identify/1,
    stale_session/1,
    cache_key/2,
    note_nodes/1,
    sync_nodes/0
]).

-define(PREFS, gateway_nsfw_preferences).
-define(SESSIONS, gateway_nsfw_sessions).
-define(SOCKETS, gateway_nsfw_sockets).

%% 启动与作用域

%% 初始化节点偏好表，并由顶层监督进程保留撤销水位。
-spec init() -> ok.
init() ->
    %% 表所有者重启时保留撤销水位；整个节点重启后由权威存储恢复。
    Heir = case whereis(fluxer_gateway_sup) of
        Pid when is_pid(Pid), Pid =/= self() -> [{heir, Pid, nsfw_preferences}];
        _ -> []
    end,
    ok = guild_ets_utils:ensure_table(?PREFS,
        [named_table, public, set, {read_concurrency, true} | Heir]),
    ok = guild_ets_utils:ensure_table(?SESSIONS,
        [named_table, public, bag, {read_concurrency, true} | Heir]),
    ok = guild_ets_utils:ensure_table(?SOCKETS,
        [named_table, public, bag, {read_concurrency, true} | Heir]),
    case os:getenv("INTEGRATION_GUILD_ID") of
        false -> ok;
        Value -> seed_scope(Value)
    end.

%% 读取唯一启用显示偏好的社区。
-spec scope() -> integer() | undefined.
scope() ->
    persistent_term:get({?MODULE, scope}, undefined).

%% 仅在首次收到可信社区标识时设置作用域。
-spec seed_scope(term()) -> ok.
seed_scope(Value) ->
    case {scope(), parse_id(Value)} of
        {undefined, GuildId} when is_integer(GuildId), GuildId > 0 ->
            %% 仅接受可信 API 启动数据或部署配置。
            persistent_term:put({?MODULE, scope}, GuildId),
            ok;
        _ -> ok
    end.

%% 从启动数据提取当前会话有效的社区显示偏好。
-spec from_startup(map()) -> map().
from_startup(Data) ->
    WireScope = parse_id(maps:get(<<"forum_nsfw_guild_id">>, Data, undefined)),
    Candidate = case scope() of undefined -> WireScope; Configured -> Configured end,
    MemberIds = session_manager_shard_lookup:parse_guild_ids(Data),
    VisitIds = snowflake_id:parse_list(maps:get(<<"visit_guild_ids">>, Data, [])),
    Scope = case lists:member(Candidate, MemberIds ++ VisitIds) of
        true -> Candidate; false -> undefined
    end,
    ValidScope = is_integer(Scope) andalso WireScope =:= Scope,
    Settings = maps:get(<<"user_guild_settings">>, Data, []),
    Setting = lists:foldl(fun
        (S, Acc) when is_map(S) ->
            case parse_id(maps:get(<<"guild_id">>, S, undefined)) =:= Scope of
                true -> S;
                false -> Acc
            end;
        (_, Acc) -> Acc
    end, #{}, Settings),
    #{guild_id => Scope, show_nsfw => ValidScope andalso maps:get(<<"show_nsfw">>, Setting, false) =:= true,
      nsfw_version => version(maps:get(<<"nsfw_version">>, Setting, 0))}.

%% 合并同一作用域的偏好，拒绝旧版本恢复可见性。
-spec import(integer(), map()) -> {boolean(), non_neg_integer()}.
import(UserId, #{guild_id := GuildId} = Preference) when is_integer(GuildId) ->
    ok = seed_scope(GuildId),
    case GuildId =:= scope() of
        true ->
            merge_preference({GuildId, UserId}, normalized(Preference), false);
        false -> {false, 0}
    end;
import(_UserId, _Preference) -> {false, 0}.

%% 会话与套接字登记

%% 先登记套接字，再绑定会话；失败时通知套接字关闭。
-spec attach(integer(), map(), pid() | undefined) -> map().
attach(UserId, Preference, SocketPid) ->
    ok = register_socket(UserId, Preference, SocketPid),
    try attach(UserId, Preference)
    catch Class:Reason:Stack ->
        case is_pid(SocketPid) of true -> SocketPid ! nsfw_preference_revoked; false -> ok end,
        erlang:raise(Class, Reason, Stack)
    end.

%% 登记套接字及其偏好快照，供撤销流程独立追踪。
-spec register_socket(integer(), map(), pid() | undefined) -> ok.
register_socket(UserId, #{guild_id := GuildId} = Preference, SocketPid)
    when is_integer(GuildId), is_pid(SocketPid) ->
    ok = seed_scope(GuildId),
    case GuildId =:= scope() of
        true ->
            true = ets:insert(?SOCKETS, {{GuildId, UserId}, SocketPid, normalized(Preference)}),
            gen_server:cast(guild_ets_owner, {watch_nsfw_socket, SocketPid}),
            ok;
        false -> ok
    end;
register_socket(_UserId, _Preference, _SocketPid) -> ok.

%% 列出去重后的受监控套接字。
-spec socket_pids() -> [pid()].
socket_pids() ->
    try lists:usort([Pid || {_, Pid, _} <- ets:tab2list(?SOCKETS)])
    catch error:badarg -> [] end.

%% 确认套接字死亡后移除登记，断连不视为死亡。
-spec forget_socket(pid()) -> ok.
forget_socket(Pid) ->
    try ets:match_delete(?SOCKETS, {'_', Pid, '_'}) of _ -> ok
    catch error:badarg -> ok end.

%% 先登记会话再校验水位，封闭更新与登记之间的竞态。
-spec attach(integer(), map()) -> map().
attach(UserId, Preference0) ->
    GuildId = maps:get(guild_id, Preference0, undefined),
    Preference = Preference0#{guild_id => GuildId},
    case is_integer(GuildId) of
        false -> Preference;
        true ->
            Snapshot = normalized(Preference),
            _ = import(UserId, Preference),
            true = ets:insert(?SESSIONS, {{GuildId, UserId}, self(), Snapshot}),
            case not fenced(GuildId, UserId) andalso current(GuildId, UserId) =:= Snapshot of
                true -> Preference;
                false ->
                    true = ets:delete_object(?SESSIONS, {{GuildId, UserId}, self(), Snapshot}),
                    error(stale_nsfw_bootstrap)
            end
    end.

%% 目标社区缺少本会话的偏好登记时要求重新鉴权。
-spec connect_allowed(map(), pid(), map()) -> boolean().
connect_allowed(Request, Pid, State) ->
    GuildId = maps:get(id, State, undefined),
    Preference = maps:get(forum_nsfw_preference, Request, #{}),
    case is_integer(GuildId) andalso GuildId =:= scope() andalso
        maps:get(guild_id, Preference, undefined) =/= GuildId of
        true -> gen_server:cast(Pid, nsfw_preference_revoked), false;
        false -> true
    end.

%% 移除当前会话登记，保留尚未关闭的套接字证据。
-spec detach() -> ok.
detach() ->
    try ets:match_delete(?SESSIONS, {'_', self(), '_'}) of _ -> ok
    catch error:badarg -> ok end.

%% 原子偏好与撤销水位

%% 读取节点当前偏好；缺失时默认隐藏。
-spec current(integer(), integer() | undefined) -> {boolean(), non_neg_integer()}.
current(GuildId, UserId) ->
    try ets:lookup(?PREFS, {GuildId, UserId}) of
        [{{GuildId, UserId}, Show, Version, _Fence}] -> {Show, Version};
        _ -> {false, 0}
    catch error:badarg -> {false, 0} end.

%% 规范化偏好，零版本不得授予可见性。
-spec normalized(map()) -> {boolean(), non_neg_integer()}.
normalized(Preference) ->
    Version = version(maps:get(nsfw_version, Preference, 0)),
    {Version > 0 andalso maps:get(show_nsfw, Preference, false) =:= true, Version}.

%% 将无效版本归零。
-spec version(term()) -> non_neg_integer().
version(V) when is_integer(V), V >= 0 -> V;
version(_) -> 0.

%% 原子合并偏好、版本和屏障，防止旧提交覆盖新状态。
-spec merge_preference({integer(), integer()}, {boolean(), non_neg_integer()}, boolean()) ->
    {boolean(), non_neg_integer()}.
merge_preference(Key, {Show, Version}, Commit) ->
    _ = ets:insert_new(?PREFS, {Key, false, 0, 0}),
    [Old = {Key, OldShow, OldVersion, Fence}] = ets:lookup(?PREFS, Key),
    {NewShow, NewVersion} = case Version > OldVersion orelse
        (Version =:= OldVersion andalso Show =:= false) of
        true -> {Show, Version}; false -> {OldShow, OldVersion}
    end,
    NewFence = case Commit andalso Version >= Fence of true -> 0; false -> Fence end,
    New = {Key, NewShow, NewVersion, NewFence},
    case Old =:= New orelse ets:select_replace(?PREFS, [{Old, [], [{const, New}]}]) =:= 1 of
        true -> {NewShow, NewVersion};
        false -> merge_preference(Key, {Show, Version}, Commit)
    end.

%% 仅在所需版本尚未提交时原子提升撤销屏障。
-spec raise_fence({integer(), integer()}, non_neg_integer()) -> boolean().
raise_fence(Key, Required) ->
    _ = ets:insert_new(?PREFS, {Key, false, 0, 0}),
    [Old = {Key, Show, Version, Fence}] = ets:lookup(?PREFS, Key),
    case Version >= Required of
        true -> false;
        false ->
            New = {Key, Show, Version, max(Fence, Required)},
            case Old =:= New orelse ets:select_replace(?PREFS, [{Old, [], [{const, New}]}]) =:= 1 of
                true -> true;
                false -> raise_fence(Key, Required)
            end
    end.


%% 频道分类与可见性

%% 按社区作用域及当前偏好判断频道是否可见。
-spec allowed(integer() | undefined, integer() | undefined, map()) -> boolean().
allowed(_UserId, _ChannelId, #{api_native_permissions := true}) -> true;
allowed(UserId, ChannelId, State) ->
    GuildId = maps:get(id, State, undefined),
    case GuildId =:= scope() andalso is_integer(GuildId) of
        false -> true;
        true ->
            case current(GuildId, UserId) of
                {true, _} -> (not fenced(GuildId, UserId))
                    orelse not nsfw_channel(ChannelId, State);
                _ -> not nsfw_channel(ChannelId, State)
            end
    end.

%% 直接使用频道数据校验显示偏好，保留 API 原生权限路径。
-spec channel_allowed(integer() | undefined, map(), map()) -> boolean().
channel_allowed(_UserId, _Channel, #{api_native_permissions := true}) -> true;
channel_allowed(UserId, Channel, State) when is_map(Channel) ->
    GuildId = maps:get(id, State, undefined),
    case GuildId =:= scope() andalso is_integer(GuildId) of
        false -> true;
        true ->
            case current(GuildId, UserId) of
                {true, _} -> (not fenced(GuildId, UserId))
                    orelse not nsfw_map(Channel, State);
                _ -> not nsfw_map(Channel, State)
            end
    end.

%% 判断频道是否属于需隐藏的敏感内容。
-spec channel_sensitive(integer() | undefined, map()) -> boolean().
channel_sensitive(ChannelId, State) -> nsfw_channel(ChannelId, State).

%% 查找频道或子频道；未知频道按敏感内容处理。
-spec nsfw_channel(integer() | undefined, map()) -> boolean().
nsfw_channel(undefined, _State) -> false;
nsfw_channel(ChannelId, State) ->
    case guild_permissions_check:find_channel_by_id(ChannelId, State) of
        Channel when is_map(Channel) -> nsfw_map(Channel, State);
        _ ->
            case guild_thread_gate:thread(ChannelId, State) of
                Thread when is_map(Thread) -> nsfw_map(Thread, State);
                _ -> true %% 作用域内未知频道默认隐藏。
            end
    end.

%% 子频道继承父频道分类，其他频道使用有效分类。
-spec nsfw_map(map(), map()) -> boolean().
nsfw_map(Channel, State) ->
    case maps:get(<<"type">>, Channel, undefined) of
        T when T =:= 10; T =:= 11; T =:= 12 ->
            ParentId = parse_id(maps:get(<<"parent_id">>, Channel, undefined)),
            case guild_permissions_check:find_channel_by_id(ParentId, State) of
                Parent when is_map(Parent) -> effective_nsfw(Parent, State);
                _ -> true
            end;
        _ -> effective_nsfw(Channel, State)
    end.

%% 优先采用显式分类，否则沿父级继承。
-spec effective_nsfw(map(), map()) -> boolean().
effective_nsfw(Channel, State) ->
    case override(Channel) of
        Value when is_boolean(Value) -> Value;
        undefined -> inherited_nsfw(Channel, State)
    end.

%% 从分类或社区继承标记，缺失父级时保守隐藏。
-spec inherited_nsfw(map(), map()) -> boolean().
inherited_nsfw(#{<<"type">> := 4}, State) -> guild_nsfw(State);
inherited_nsfw(Channel, State) ->
    case parse_id(maps:get(<<"parent_id">>, Channel, undefined)) of
        undefined -> guild_nsfw(State);
        ParentId ->
            case guild_permissions_check:find_channel_by_id(ParentId, State) of
                #{<<"type">> := 4} = Parent ->
                    case override(Parent) of
                        Value when is_boolean(Value) -> Value;
                        undefined -> guild_nsfw(State)
                    end;
                _ -> true
            end
    end.

%% 读取显式覆盖值，并兼容旧版频道标记。
-spec override(map()) -> boolean() | undefined.
override(Channel) ->
    case maps:find(<<"nsfw_override">>, Channel) of
        {ok, Value} when is_boolean(Value) -> Value;
        {ok, _} -> undefined;
        error ->
            case maps:get(<<"nsfw">>, Channel, undefined) of
                Value when is_boolean(Value) -> Value;
                _ -> undefined
            end
    end.

%% 读取社区级敏感内容分类。
-spec guild_nsfw(map()) -> boolean().
guild_nsfw(State) ->
    guild_visitor_permissions:guild_nsfw(maps:get(data, State, #{})).

%% 在原生权限上应用显示偏好，不额外授予权限。
-spec apply_permissions(non_neg_integer(), integer(), integer() | undefined, map()) ->
    non_neg_integer().
apply_permissions(Permissions, UserId, ChannelId, State) ->
    case allowed(UserId, ChannelId, State) of true -> Permissions; false -> 0 end.

%% 将偏好版本和屏障纳入可见性缓存键。
-spec cache_key(integer() | undefined, map()) ->
    api_native_permissions | unrestricted | {{boolean(), non_neg_integer()}, boolean()}.
cache_key(_UserId, #{api_native_permissions := true}) -> api_native_permissions;
cache_key(UserId, State) ->
    GuildId = maps:get(id, State, undefined),
    case GuildId =:= scope() andalso is_integer(GuildId) of
        true -> {current(GuildId, UserId), fenced(GuildId, UserId)};
        false -> unrestricted
    end.

%% 集群同步与更新屏障

%% 保留曾参与同步的节点，避免断连时遗漏撤销。
-spec note_nodes([node()]) -> ok.
note_nodes(Nodes) ->
    Old = persistent_term:get({?MODULE, peers}, []),
    New = lists:usort(Old ++ Nodes),
    case New =:= Old of true -> ok; false -> persistent_term:put({?MODULE, peers}, New) end.

%% 汇总同步节点，并拒绝缺少完整节点配置的集群。
-spec sync_nodes() -> [node()].
sync_nodes() ->
    Current = lists:usort([node() | nodes()] ++ gateway_node_router:active_nodes()),
    ok = note_nodes(Current),
    Configured = configured_nodes(),
    Required = cluster_enabled(),
    Complete = Configured =/= [] andalso lists:all(fun(N) -> lists:member(N, Configured) end, Current),
    case Required andalso not Complete of
        true -> gateway_rpc_error:raise(<<"nsfw_expected_gateway_nodes_required">>);
        false -> lists:usort(Current ++ Configured ++ persistent_term:get({?MODULE, peers}, []))
    end.

%% 根据配置、连接和历史成员判断是否需要集群同步。
-spec cluster_enabled() -> boolean().
cluster_enabled() ->
    Configured = try fluxer_gateway_env:get(cluster_enabled) of true -> true; _ -> false
        catch _:_ -> false end,
    Configured orelse nodes() =/= [] orelse
        lists:any(fun(N) -> N =/= node() end, persistent_term:get({?MODULE, peers}, [])).

%% 从部署配置解析预期网关节点。
-spec configured_nodes() -> [node()].
configured_nodes() ->
    case os:getenv("INTEGRATION_NSFW_GATEWAY_NODES") of
        false -> [];
        Value -> [list_to_atom(string:trim(N)) || N <- string:tokens(Value, ","),
            string:trim(N) =/= ""]
    end.

%% 在所有必要节点开始偏好更新并撤销旧会话。
-spec begin_cluster(map()) -> true.
begin_cluster(Params) -> fanout(begin_local, Params).
%% 向所有必要节点提交已持久化的偏好。
-spec sync_cluster(map()) -> true.
sync_cluster(Params) -> fanout(sync_local, Params).

%% 等待所有节点明确确认，失败时拒绝完成同步。
-spec fanout(begin_local | sync_local, map()) -> true.
fanout(Function, Params) ->
    Nodes = sync_nodes(),
    {Replies, Failed} = rpc:multicall(Nodes, ?MODULE, Function, [Params], 12000),
    case Failed =:= [] andalso lists:all(fun(R) -> R =:= true end, Replies) of
        true -> true;
        false -> gateway_rpc_error:raise(<<"nsfw_preference_sync_failed">>)
    end.

%% 提交本地偏好，并等待旧会话及套接字终止。
-spec sync_local(map()) -> boolean().
sync_local(Params) ->
    GuildId = parse_id(maps:get(<<"guild_id">>, Params)),
    UserId = parse_id(maps:get(<<"user_id">>, Params)),
    GuildId = parse_id(maps:get(<<"forum_nsfw_guild_id">>, Params)),
    true = is_integer(GuildId) andalso is_integer(UserId),
    ok = seed_scope(GuildId),
    GuildId = scope(),
    Show = maps:get(<<"show_nsfw">>, Params),
    Version = maps:get(<<"nsfw_version">>, Params),
    true = is_boolean(Show) andalso is_integer(Version) andalso Version >= 0,
    Preference = #{guild_id => GuildId, show_nsfw => Show, nsfw_version => Version},
    Current = merge_preference({GuildId, UserId}, normalized(Preference), true),
    %% 包括断连后可恢复的会话，必须等到实际终止。
    Sessions = ets:lookup(?SESSIONS, {GuildId, UserId}),
    Results = [case Snapshot =:= Current of
        true -> case fenced(GuildId, UserId) of true -> revoke(Pid); false -> true end;
        false -> revoke(Pid)
    end || {_, Pid, Snapshot} <- Sessions],
    SocketResult = revoke_sockets(GuildId, UserId, Current),
    lists:all(fun(Result) -> Result =:= true end, Results) andalso SocketResult andalso
        not fenced(GuildId, UserId).

%% 读取 API 权威偏好后开始本地撤销。
-spec begin_local(map()) -> boolean().
begin_local(Params) ->
    begin_local_with_read(Params, fun(UserId, GuildId) ->
        rpc_client:call(#{<<"type">> => <<"get_nsfw_display_preference">>,
            <<"user_id">> => integer_to_binary(UserId), <<"guild_id">> => integer_to_binary(GuildId)})
    end).

%% 使用内部读取函数验证持久化版本，再建立撤销屏障。
-spec begin_local_with_read(
    map(), fun((integer(), integer()) -> {ok, map()} | {error, term()})
) -> boolean().
begin_local_with_read(Params, Read) ->
    GuildId = parse_id(maps:get(<<"guild_id">>, Params)),
    UserId = parse_id(maps:get(<<"user_id">>, Params)),
    GuildId = parse_id(maps:get(<<"forum_nsfw_guild_id">>, Params)),
    ok = seed_scope(GuildId),
    GuildId = scope(),
    Expected = maps:get(<<"expected_nsfw_version">>, Params),
    true = is_integer(Expected) andalso Expected >= 0 andalso is_integer(UserId),
    %% 节点重启会清空内存，先读取权威版本，避免旧请求在恢复提交后重建屏障。
    {ok, Native} = Read(UserId, GuildId),
    GuildId = parse_id(maps:get(<<"guild_id">>, Native)),
    NativeVersion = maps:get(<<"nsfw_version">>, Native),
    NativeShow = maps:get(<<"show_nsfw">>, Native),
    true = is_integer(NativeVersion) andalso NativeVersion >= 0 andalso is_boolean(NativeShow),
    case NativeVersion > Expected of
        true -> sync_local(Params#{<<"nsfw_version">> => NativeVersion, <<"show_nsfw">> => NativeShow});
        false ->
            true = NativeVersion =:= Expected,
            case raise_fence({GuildId, UserId}, Expected + 1) of
                false -> true;
                true ->
                    Results = [revoke(Pid) || {_, Pid, _} <- ets:lookup(?SESSIONS, {GuildId, UserId})],
                    SocketResult = revoke_sockets(GuildId, UserId, all),
                    lists:all(fun(Result) -> Result =:= true end, Results) andalso SocketResult
            end
    end.

%% 读取更新屏障；偏好表不可用时禁止放行。
-spec fenced(integer(), integer() | undefined) -> boolean().
fenced(GuildId, UserId) ->
    try ets:lookup(?PREFS, {GuildId, UserId}) of
        [{{GuildId, UserId}, _, _, Fence}] -> Fence > 0;
        _ -> false
    catch error:badarg -> true end.

%% 撤销确认与恢复校验

%% 独立撤销过期套接字，即使其会话已退出。
-spec revoke_sockets(integer(), integer(), all | {boolean(), non_neg_integer()}) -> boolean().
revoke_sockets(GuildId, UserId, Current) ->
    %% 会话已脱离或正常退出也必须检查其套接字。
    Sockets = ets:lookup(?SOCKETS, {GuildId, UserId}),
    Results = [begin
        Pid ! nsfw_preference_revoked,
        wait_socket(Pid)
    end || {_, Pid, Snapshot} <- Sockets,
        Current =:= all orelse Snapshot =/= Current orelse fenced(GuildId, UserId)],
    lists:all(fun(Result) -> Result =:= true end, Results).

%% 请求会话撤销，并等待会话和套接字结束。
-spec revoke(pid()) -> boolean().
revoke(Pid) ->
    Ref = erlang:monitor(process, Pid),
    Result = try gen_server:call(Pid, nsfw_preference_revoke, 5000) of
        {ok, SocketPid} -> wait_down(Ref, Pid) andalso wait_socket(SocketPid);
        _ -> false
    catch exit:{noproc, _} -> true; exit:{normal, _} -> true; exit:_ -> false end,
    erlang:demonitor(Ref, [flush]),
    Result.

%% 有界等待进程监控确认会话退出。
-spec wait_down(reference(), pid()) -> boolean().
wait_down(Ref, Pid) ->
    receive {'DOWN', Ref, process, Pid, _} -> true
    after 5000 -> false end.

%% 等待套接字确认死亡，节点断连不得视为成功。
-spec wait_socket(pid() | undefined) -> boolean().
wait_socket(Pid) when is_pid(Pid) ->
    Ref = erlang:monitor(process, Pid),
    Result = receive
        {'DOWN', Ref, process, Pid, noconnection} -> false;
        {'DOWN', Ref, process, Pid, _} -> forget_socket(Pid), true
    after 5000 -> false end,
    erlang:demonitor(Ref, [flush]),
    Result;
wait_socket(_) -> true.

%% 目标社区的迁移会话必须重新读取权威偏好。
-spec requires_identify(map()) -> boolean().
requires_identify(State) ->
    GuildId = scope(),
    case is_integer(GuildId) of
        false -> false;
        true ->
            Preference = maps:get(forum_nsfw_preference, State, #{}),
            maps:get(guild_id, Preference, undefined) =:= GuildId orelse
                lists:member(GuildId, session_init:normalize_guild_ids(maps:get(guilds, State, [])))
    end.

%% 检测会话快照是否已被版本更新或屏障撤销。
-spec stale_session(map()) -> boolean().
stale_session(State) ->
    case maps:get(forum_nsfw_preference, State, undefined) of
        #{guild_id := GuildId} = Preference when is_integer(GuildId) ->
            UserId = maps:get(user_id, State),
            fenced(GuildId, UserId) orelse
                current(GuildId, UserId) =/= normalized(Preference);
        _ -> false
    end.

%% 兼容配置字符串并解析可选雪花标识。
-spec parse_id(term()) -> integer() | undefined.
parse_id(Value) when is_list(Value) -> parse_id(list_to_binary(Value));
parse_id(Value) -> snowflake_id:parse_optional(Value).
