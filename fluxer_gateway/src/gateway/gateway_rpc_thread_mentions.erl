%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(gateway_rpc_thread_mentions).
-export([handle/2, decide/2]).

%% 能力注册独立于guild查询，避免为健康租约读取任何成员数据。
-spec handle(binary(), map()) -> map() | true.
handle(
    <<"guild.dispatch_thread_message">>,
    #{
        <<"protocol_version">> := 1,
        <<"event">> := <<"MESSAGE_CREATE">>,
        <<"data">> := Data
    } = P
) when is_map(Data) ->
    %% 专用方法保证旧节点明确拒绝，不能降级到会发送普通帖子Push的旧分发入口。
    GuildId = validation:snowflake_or_throw(<<"guild_id">>, maps:get(<<"guild_id">>, P)),
    gateway_rpc_guild_infra:with_guild_unchecked(GuildId, fun(Pid) ->
        %% 再以专用消息验证实际owner；旧远端进程只能拒绝，不能执行普通dispatch。
        case guild_query_handler:call(Pid, {dispatch_thread_message, #{data => Data}}, 4000) of
            true -> true;
            _ -> gateway_rpc_error:raise(<<"thread_mention_dispatch_unavailable">>)
        end
    end);
handle(<<"guild.dispatch_thread_message">>, _) ->
    gateway_rpc_error:raise(validation_invalid_params);
handle(<<"guild.thread_mention_capabilities">>, _) ->
    guild_thread_mention_capabilities:capabilities();
handle(<<"guild.register_thread_mention_component">>, P) ->
    guild_thread_mention_capabilities:register(P);
handle(<<"guild.resolve_thread_mention_decision">>, P) ->
    try
        #{<<"protocol_ready">> := true} = guild_thread_mention_capabilities:capabilities(),
        1 = maps:get(<<"protocol_version">>, P),
        1 = maps:get(<<"api_version">>, P),
        1 = maps:get(<<"worker_version">>, P),
        {ok, GuildId} = validation:validate_snowflake(
            <<"guild_id">>, maps:get(<<"guild_id">>, P)
        ),
        lists:foreach(
            fun(Key) -> {ok, _} = validation:validate_snowflake(Key, maps:get(Key, P)) end,
            [<<"channel_id">>, <<"message_id">>, <<"author_id">>]
        ),
        Roles0 = maps:get(<<"role_ids">>, P, []),
        Users0 = maps:get(<<"user_ids">>, P, []),
        true = is_list(Roles0) andalso length(Roles0) =< 1024,
        true = is_list(Users0) andalso length(Users0) =< 1024,
        {ok, Roles} = validation:validate_snowflake_list(Roles0),
        {ok, Users} = validation:validate_snowflake_list(Users0),
        Request = P#{role_ids => Roles, user_ids => Users},
        gateway_rpc_guild_infra:with_guild(GuildId, fun(Pid) ->
            guild_query_handler:call(Pid, {resolve_thread_mention_decision, Request}, 4000)
        end)
    catch
        _:_ -> gateway_rpc_error:raise(<<"thread_mention_decision_error">>)
    end.

%% 必须直接在拥有索引的guild进程执行，不能把包含大角色map的快照发给子进程。
-spec decide(map(), map()) -> map().
decide(P, State) ->
    Data = maps:get(data, State, #{}),
    RoleIndex = guild_data_index_roles:role_index(Data),
    GuildId = maps:get(id, State, undefined),
    Roles = [Id || Id <- maps:get(role_ids, P), Id =/= GuildId, maps:is_key(Id, RoleIndex)],
    Decision0 = guild_thread_role_index:decide(Data, Roles),
    ChannelId = snowflake_id:parse(maps:get(<<"channel_id">>, P)),
    %% 固定配额先于权限和策略过滤；持久化后任何重试都只能缩小该集合。
    Decision = bound_thread_candidates(Decision0, ChannelId, P, State),
    #{
        <<"version">> => 1,
        <<"message_id">> => maps:get(<<"message_id">>, P),
        <<"channel_id">> => maps:get(<<"channel_id">>, P),
        <<"author_id">> => maps:get(<<"author_id">>, P),
        <<"allowed_role_ids">> => [
            integer_to_binary(Id)
         || Id <- maps:get(allowed_role_ids, Decision)
        ],
        <<"role_user_ids">> => [
            integer_to_binary(Id)
         || Id <- maps:get(role_user_ids, Decision)
        ],
        <<"direct_user_ids">> => [
            integer_to_binary(Id)
         || Id <- lists:usort(maps:get(user_ids, P))
        ],
        <<"warnings">> => [atom_to_binary(W) || W <- maps:get(warnings, Decision)]
    }.

%% 不读取完整关注者集合，只探测最多3000个角色身份并冻结剩余名额。
-spec bound_thread_candidates(map(), integer(), map(), map()) -> map().
bound_thread_candidates(#{role_user_ids := []} = Decision, _ChannelId, _P, _State) ->
    Decision;
bound_thread_candidates(Decision, ChannelId, P, State) ->
    try
        Tab = guild_thread_gate:store(State),
        Thread = guild_thread_store:get_thread(Tab, ChannelId),
        true = is_map(Thread),
        Count = guild_thread_store:member_count(Tab, ChannelId),
        true = is_integer(Count) andalso Count >= 0,
        Author = snowflake_id:parse(maps:get(<<"author_id">>, P)),
        Direct = maps:from_keys(maps:get(user_ids, P), true),
        {Members, Outsiders} = lists:partition(
            fun(Id) -> guild_thread_store:is_member(Tab, ChannelId, Id) end,
            maps:get(role_user_ids, Decision)
        ),
        Metadata = maps:get(<<"thread_metadata">>, Thread, #{}),
        Room =
            case
                maps:get(<<"type">>, Thread, 0) =/= 12 andalso
                    maps:get(<<"archived">>, Metadata, false) =/= true
            of
                true -> min(250, max(0, 100000 - Count));
                false -> 0
            end,
        Adds = lists:sublist(
            [
                Id
             || Id <- lists:sort(Outsiders),
                Id =/= Author,
                not maps:is_key(Id, Direct)
            ],
            Room
        ),
        Decision#{role_user_ids => lists:usort(Members ++ Adds)}
    catch
        _:_ ->
            Decision#{
                allowed_role_ids => [],
                role_user_ids => [],
                warnings => lists:usort([role_index_unavailable | maps:get(warnings, Decision)])
            }
    end.
