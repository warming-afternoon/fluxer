%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(guild_thread_mention_policy).
-export([prepare/2, candidates/1]).

%% 普通频道及论坛新帖通知保持原路；帖子消息在scope、排队和worker前收敛候选。
-spec prepare(map(), map()) -> skip | {send, map()}.
prepare(Message, State) ->
    Channel = snowflake_id:parse_maybe(maps:get(<<"channel_id">>, Message, undefined)),
    ThreadMessage =
        is_integer(Channel) andalso
            (guild_thread_gate:is_thread_id(Channel, State) orelse
                valid_binding(maps:get(<<"_thread_mention_decision">>, Message, #{}), Message) orelse
                lists:member(maps:get(<<"channel_type">>, Message, undefined), [10, 11, 12])),
    case
        ThreadMessage andalso
            maps:get(<<"__forum_thread_created">>, Message, false) =/= true
    of
        false -> {send, Message};
        true -> prepare_thread(Message, State)
    end.

%% direct独立保留；固定决策不可用时不展开任何角色，也不补发。
-spec prepare_thread(map(), map()) -> skip | {send, map()}.
prepare_thread(Message, State) ->
    Direct = lists:usort([
        Id
     || Mention <- maps:get(<<"mentions">>, Message, []),
        is_map(Mention),
        Id <- [snowflake_id:parse_maybe(maps:get(<<"id">>, Mention, undefined))],
        is_integer(Id)
    ]),
    Decision = maps:get(<<"_thread_mention_decision">>, Message, #{}),
    {Roles, RoleUsers} =
        case valid_binding(Decision, Message) of
            true ->
                {
                    ids(maps:get(<<"allowed_role_ids">>, Decision, [])),
                    notification_role_users(Decision, Message, State)
                };
            false ->
                {[], []}
        end,
    Users = lists:usort(Direct ++ RoleUsers),
    case Users of
        [] ->
            skip;
        _ ->
            {send, (maps:remove(<<"_thread_mention_decision">>, Message))#{
                <<"mention_everyone">> => false,
                <<"mention_here">> => false,
                <<"mention_roles">> => [integer_to_binary(Id) || Id <- Roles],
                <<"__thread_mention_candidates">> => Users,
                <<"__thread_role_candidates">> => RoleUsers
            }}
    end.

%% 私有决策必须绑定同一条消息，列表长度先验证再解析。
-spec valid_binding(term(), map()) -> boolean().
valid_binding(D, M) when is_map(D) ->
    Author = maps:get(<<"author">>, M, #{}),
    is_map(Author) andalso lists:member(maps:get(<<"version">>, D, 0), [1, 2]) andalso
        maps:get(<<"message_id">>, D, undefined) =:= maps:get(<<"id">>, M, null) andalso
        maps:get(<<"channel_id">>, D, undefined) =:= maps:get(<<"channel_id">>, M, null) andalso
        maps:get(<<"author_id">>, D, undefined) =:= maps:get(<<"id">>, Author, null) andalso
        bounded(maps:get(<<"allowed_role_ids">>, D, []), 1024) andalso
        bounded(maps:get(<<"role_user_ids">>, D, []), 3000) andalso
        valid_add_binding(D, M);
valid_binding(_, _) ->
    false.
%% Admission is separate from frozen notification identity in both versions.
%% V1 has no outsider admission; the worker must not infer it from these recipients.
-spec notification_role_users(map(), map(), map()) -> [integer()].
notification_role_users(D, _M, _State) ->
    ids(maps:get(<<"role_user_ids">>, D, [])).

-spec valid_add_binding(map(), map()) -> boolean().
valid_add_binding(#{<<"version">> := 1} = D, _M) ->
    maps:get(<<"role_add_user_ids">>, D, []) =:= [];
valid_add_binding(#{<<"version">> := 2, <<"role_add_user_ids">> := Adds} = D, M) ->
    case bounded(Adds, 250) andalso bounded(maps:get(<<"direct_user_ids">>, D, []), 1024) of
        false -> false;
        true ->
            Parsed = ids(Adds),
            RoleUsers = ids(maps:get(<<"role_user_ids">>, D, [])),
            Direct = ids(maps:get(<<"direct_user_ids">>, D, [])),
            Author = snowflake_id:parse_maybe(maps:get(<<"author_id">>, D, undefined)),
            MessageDirect = [snowflake_id:parse_maybe(maps:get(<<"id">>, X, undefined)) ||
                X <- maps:get(<<"mentions">>, M, []), is_map(X)],
            length(Parsed) =:= length(Adds) andalso
                lists:all(fun(V) -> is_binary(V) andalso
                    case snowflake_id:parse_maybe(V) of
                        N when is_integer(N), N > 0 -> integer_to_binary(N) =:= V;
                        _ -> false
                    end
                end, Adds) andalso
                lists:all(fun(Id) -> lists:member(Id, RoleUsers) andalso Id =/= Author
                    andalso not lists:member(Id, Direct) andalso not lists:member(Id, MessageDirect)
                end, Parsed)
    end;
valid_add_binding(_, _) -> false.

%% 解析之前先约束输入列表的工作量。
-spec bounded(term(), integer()) -> boolean().
bounded(List, Max) -> is_list(List) andalso length(List) =< Max.
%% 只在已验证的小列表上规范化有效身份。
-spec ids(list()) -> [integer()].
ids(List) ->
    lists:usort([
        Id
     || Value <- List,
        Id <- [snowflake_id:parse_maybe(Value)],
        is_integer(Id)
    ]).
%% 仅向内部候选扫描暴露固定身份集合。
-spec candidates(map()) -> [integer()] | undefined.
candidates(Message) -> maps:get(<<"__thread_mention_candidates">>, Message, undefined).

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").
%% 无提及、everyone及here都在worker准入之前结束，direct不依赖角色索引。
early_gate_test() ->
    Base = #{
        <<"id">> => <<"10">>,
        <<"channel_id">> => <<"20">>,
        <<"author">> => #{<<"id">> => <<"30">>}
    },
    ?assertEqual(skip, prepare_thread(Base, #{})),
    ?assertEqual(skip, prepare_thread(Base#{<<"mention_everyone">> => true}, #{})),
    ?assertEqual(skip, prepare_thread(Base#{<<"mention_here">> => true}, #{})),
    {send, Direct} = prepare_thread(Base#{<<"mentions">> => [#{<<"id">> => <<"40">>}]}, #{}),
    ?assertEqual([40], candidates(Direct)),
    ?assertEqual(false, maps:get(<<"mention_everyone">>, Direct)),
    ?assertEqual([], maps:get(<<"mention_roles">>, Direct)).

%% 角色决策必须匹配消息绑定；重试使用固定候选，不重新读角色成员。
fixed_decision_test() ->
    D = #{
        <<"version">> => 2,
        <<"role_add_user_ids">> => [<<"40">>],
        <<"message_id">> => <<"10">>,
        <<"channel_id">> => <<"20">>,
        <<"author_id">> => <<"30">>,
        <<"allowed_role_ids">> => [<<"50">>],
        <<"role_user_ids">> => [<<"40">>]
    },
    Base = #{
        <<"id">> => <<"10">>,
        <<"channel_id">> => <<"20">>,
        <<"author">> => #{<<"id">> => <<"30">>},
        <<"_thread_mention_decision">> => D
    },
    {send, Message} = prepare_thread(Base, #{}),
    ?assertEqual([40], candidates(Message)),
    ?assertEqual(skip, prepare_thread(Base#{<<"id">> => <<"11">>}, #{})),
    ?assertEqual(
        skip,
        prepare_thread(Base#{
            <<"_thread_mention_decision">> =>
                D#{<<"role_user_ids">> => lists:duplicate(3001, <<"40">>)}
        }, #{})
    ).
-endif.
