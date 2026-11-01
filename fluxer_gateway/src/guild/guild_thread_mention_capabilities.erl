%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(guild_thread_mention_capabilities).
-behaviour(gen_server).
-export([start_link/0, register/1, capabilities/0, register_local/1, capabilities_local/0]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2]).

%% 租约由独立拥有者串行维护，RPC调用者退出不会删除发布状态。
-spec start_link() -> {ok, pid()} | {error, term()}.
start_link() -> gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).
%% 注册覆盖每个当前网关；部分失败返回未就绪，后续心跳可安全重试。
-spec register(map()) -> map().
register(Params) ->
    Nodes = lists:usort([node() | gateway_node_router:active_nodes()]),
    case length(Nodes) =< 256 of
        true ->
            {Replies, BadNodes} = rpc:multicall(Nodes, ?MODULE, register_local, [Params], 2000),
            combine(Replies, BadNodes, Nodes);
        false ->
            #{<<"protocol_ready">> => false}
    end.

%% 每个节点只更新本地租约，不递归广播。
-spec register_local(map()) -> map().
register_local(Params) -> gen_server:call(?MODULE, {register, Params}, 1000).

%% 能力查询逐网关核实，旧节点、故障节点和新加入未注册节点都不能被忽略。
-spec capabilities() -> map().
capabilities() ->
    Nodes = lists:usort([node() | gateway_node_router:active_nodes()]),
    case length(Nodes) =< 256 of
        true ->
            {Replies, BadNodes} = rpc:multicall(Nodes, ?MODULE, capabilities_local, [], 2000),
            combine(Replies, BadNodes, Nodes);
        false ->
            #{<<"protocol_ready">> => false}
    end.

%% 读取本地注册状态，失败由集群调用者收敛为不就绪。
-spec capabilities_local() -> map().
capabilities_local() -> gen_server:call(?MODULE, capabilities, 1000).

%% 集群成员变化和任一缺失能力使角色决策关闭，但不恢复普通帖子广播。
-spec combine([term()], [node()], [node()]) -> map().
combine(Replies, BadNodes, Nodes) ->
    Current = lists:usort([node() | gateway_node_router:active_nodes()]),
    Ready =
        BadNodes =:= [] andalso Nodes =:= Current andalso length(Replies) =:= length(Nodes) andalso
            lists:all(
                fun
                    (
                        #{
                            <<"protocol_ready">> := true,
                            <<"version">> := 2,
                            <<"api_version">> := 2,
                            <<"worker_version">> := 2
                        }
                    ) ->
                        true;
                    (_) ->
                        false
                end,
                Replies
            ),
    Version =
        case Ready of
            true -> 2;
            false -> 0
        end,
    #{
        <<"version">> => 2,
        <<"api_version">> => Version,
        <<"worker_version">> => Version,
        <<"protocol_ready">> => Ready
    }.

%% 初始状态不信任任何未注册的实例。
-spec init([]) -> {ok, map()}.
init([]) -> {ok, #{}}.

%% 固定容量和实例ID长度限制避免内部错误请求无限占用内存。
-spec handle_call(term(), gen_server:from(), map()) -> {reply, map(), map()}.
handle_call({register, P}, _From, State0) ->
    State = live(State0),
    Id = maps:get(<<"instance_id">>, P, undefined),
    Component = maps:get(<<"component">>, P, undefined),
    Version = maps:get(<<"version">>, P, undefined),
    Key = {Component, Id},
    Valid =
        is_binary(Id) andalso byte_size(Id) > 0 andalso byte_size(Id) =< 128 andalso
            lists:member(Component, [<<"api">>, <<"worker">>]) andalso Version =:= 2,
    case Valid andalso (map_size(State) < 256 orelse maps:is_key(Key, State)) of
        true ->
            Lease = maps:get(<<"lease_ms">>, P, 60000),
            case is_integer(Lease) andalso Lease > 0 andalso Lease =< 60000 of
                true ->
                    Next = State#{Key => #{version => 2, expires => erlang:monotonic_time(millisecond) + Lease}},
                    {reply, snapshot(Next), Next};
                false ->
                    {reply, #{<<"protocol_ready">> => false}, State}
            end;
        false ->
            %% An incompatible heartbeat cannot keep an earlier v2 lease alive.
            {reply, #{<<"protocol_ready">> => false}, maps:remove(Key, State)}
    end;
handle_call(capabilities, _From, State0) ->
    State = live(State0),
    {reply, snapshot(State), State}.

%% 不接受未经请求协议定义的状态变更。
-spec handle_cast(term(), map()) -> {noreply, map()}.
handle_cast(_, State) -> {noreply, State}.
%% 无关系统消息不改变租约。
-spec handle_info(term(), map()) -> {noreply, map()}.
handle_info(_, State) -> {noreply, State}.

%% 过期实例立即失去能力，必须同时满足配置的API与worker实例数量。
-spec live(map()) -> map().
live(State) ->
    Now = erlang:monotonic_time(millisecond),
    maps:filter(fun
        (_, #{version := 2, expires := Until}) when is_integer(Until) -> Until > Now;
        (_, _) -> false
    end, State).
%% 只有启用且预期数量齐全才发布就绪。
-spec snapshot(map()) -> map().
snapshot(State) ->
    Config = maps:get(
        thread_mentions, persistent_term:get({fluxer_gateway, runtime_config}, #{}), #{}
    ),
    ApiIds = lists:sort([Id || {<<"api">>, Id} <- maps:keys(State)]),
    WorkerIds = lists:sort([Id || {<<"worker">>, Id} <- maps:keys(State)]),
    NeedApi = maps:get(expected_api_instances, Config, 0),
    NeedWorker = maps:get(expected_worker_instances, Config, 0),
    ExpectedApi = maps:get(expected_api_instance_ids, Config, []),
    ExpectedWorker = maps:get(expected_worker_instance_ids, Config, []),
    %% 精确实例名单防止重启生成的多个旧租约凑足计数，额外实例也不被默许。
    ValidRoster = fun(Ids, Count) ->
        is_list(Ids) andalso Count > 0 andalso length(Ids) =:= Count andalso
            length(lists:usort(Ids)) =:= Count andalso
            lists:all(
                fun(Id) ->
                    is_binary(Id) andalso byte_size(Id) > 0 andalso
                        byte_size(Id) =< 128
                end,
                Ids
            )
    end,
    ApiReady = ValidRoster(ExpectedApi, NeedApi) andalso ApiIds =:= lists:sort(ExpectedApi),
    WorkerReady =
        ValidRoster(ExpectedWorker, NeedWorker) andalso
            WorkerIds =:= lists:sort(ExpectedWorker),
    Ready = maps:get(enabled, Config, false) =:= true andalso ApiReady andalso WorkerReady,
    #{
        <<"version">> => 2,
        <<"api_version">> =>
            case ApiReady of
                true -> 2;
                false -> 0
            end,
        <<"worker_version">> =>
            case WorkerReady of
                true -> 2;
                false -> 0
            end,
        <<"protocol_ready">> => Ready
    }.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").
%% 少一个实例、过期租约或未启用配置都不能发布完整协议能力。
deployment_gate_test() ->
    Key = {fluxer_gateway, runtime_config},
    Old = persistent_term:get(Key, #{}),
    persistent_term:put(Key, #{
        thread_mentions => #{
            enabled => true,
            expected_api_instances => 2,
            expected_worker_instances => 1,
            expected_api_instance_ids => [<<"a">>, <<"b">>],
            expected_worker_instance_ids => [<<"w">>]
        }
    }),
    try
        Base = #{<<"version">> => 2, <<"lease_ms">> => 60000},
        {reply, R1, S1} = handle_call(
            {register, Base#{<<"instance_id">> => <<"a">>, <<"component">> => <<"api">>}},
            undefined,
            #{}
        ),
        ?assertNot(maps:get(<<"protocol_ready">>, R1)),
        {reply, _, S2} = handle_call(
            {register, Base#{<<"instance_id">> => <<"b">>, <<"component">> => <<"api">>}},
            undefined,
            S1
        ),
        {reply, R3, S3} = handle_call(
            {register, Base#{<<"instance_id">> => <<"w">>, <<"component">> => <<"worker">>}},
            undefined,
            S2
        ),
        ?assert(maps:get(<<"protocol_ready">>, R3)),
        {reply, _, Same} = handle_call(
            {register, Base#{<<"instance_id">> => <<"w">>, <<"component">> => <<"worker">>}},
            undefined,
            S3
        ),
        ?assertEqual(3, map_size(Same)),
        {reply, Extra, _} = handle_call(
            {register, Base#{
                <<"instance_id">> => <<"old-api">>,
                <<"component">> => <<"api">>
            }},
            undefined,
            S3
        ),
        ?assertNot(maps:get(<<"protocol_ready">>, Extra)),
        {reply, Expired, _} = handle_call(
            capabilities,
            undefined,
            S3#{{<<"worker">>, <<"w">>} => #{version => 2, expires => erlang:monotonic_time(millisecond) - 1}}
        ),
        ?assertNot(maps:get(<<"protocol_ready">>, Expired)),
        persistent_term:put(Key, #{}),
        ?assertNot(maps:get(<<"protocol_ready">>, snapshot(S3)))
    after
        persistent_term:put(Key, Old)
    end.
-endif.
