%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_thread_push).
-typing([eqwalizer]).

-export([
    scope/2,
    push_message_data/4,
    forum_starter/3,
    mark_forum_thread_created/1,
    mention_universe/2,
    passive_threads/3
]).

-export_type([scope/0]).

-define(THREAD_PUSH_KEY, <<"__thread_push">>).
-define(FORUM_THREAD_CREATED_KEY, <<"__forum_thread_created">>).
-define(MEMBER_SETTING_KEYS, [<<"flags">>, <<"muted">>, <<"mute_config">>]).

-type user_id() :: integer().
-type scope() :: #{thread := map(), members := #{user_id() => map()}} | undefined.

-spec scope(integer(), map()) -> scope().
scope(ChannelId, State) ->
    case guild_thread_gate:store(State) of
        undefined -> undefined;
        Tab -> safe_scope(Tab, ChannelId)
    end.

-spec safe_scope(ets:table(), integer()) -> scope().
safe_scope(Tab, ChannelId) ->
    try guild_thread_store:get_thread(Tab, ChannelId) of
        undefined ->
            undefined;
        Thread ->
            #{
                thread => Thread,
                members => maps:from_list(guild_thread_store:members(Tab, ChannelId))
            }
    catch
        error:badarg -> undefined
    end.

%% 附加候选用户所需的线程通知设置，保留新帖标记和原有回退行为
-spec push_message_data(map(), integer(), [user_id()], map()) -> {map(), binary()} | undefined.
push_message_data(MessageData, ChannelId, UserIds, Data) ->
    case push_scope(MessageData, ChannelId, UserIds, Data) of
        undefined ->
            undefined;
        #{thread := Thread, members := Members} ->
            ParentId = snowflake_id:parse_optional(
                maps:get(<<"parent_id">>, Thread, undefined)
            ),
            Parent = parent_channel(ParentId, Data),
            {ForumThreadCreated, MessageData1} = take_forum_thread_created(MessageData),
            ThreadPush = #{
                <<"parent_id">> => ParentId,
                <<"parent_name">> => binary_or_undefined(
                    maps:get(<<"name">>, Parent, undefined)
                ),
                <<"category_id">> => snowflake_id:parse_optional(
                    maps:get(<<"parent_id">>, Parent, undefined)
                ),
                <<"members">> => member_settings(UserIds, Members)
            },
            {
                MessageData1#{
                    ?THREAD_PUSH_KEY => with_forum_thread_created(
                        ForumThreadCreated, ThreadPush
                    )
                },
                thread_name(Thread)
            }
    end.

%% 普通线程只读取候选成员，论坛新帖保留适用于大量 watcher 的成员快照路径
-spec push_scope(map(), integer(), [user_id()], map()) -> scope().
push_scope(#{?FORUM_THREAD_CREATED_KEY := true}, ChannelId, _UserIds, Data) ->
    %% watcher 数量可能远超线程成员数量，复用已有快照避免逐个查询非成员
    scope(ChannelId, Data);
push_scope(_MessageData, ChannelId, UserIds, Data) ->
    case guild_thread_gate:store(Data) of
        undefined -> undefined;
        Tab -> safe_candidate_scope(Tab, ChannelId, UserIds)
    end.

%% 去重读取候选成员，存储中途失效时放弃部分结果并沿用不可用回退
-spec safe_candidate_scope(ets:table(), integer(), [user_id()]) -> scope().
safe_candidate_scope(Tab, ChannelId, UserIds) ->
    try
        case guild_thread_store:get_thread(Tab, ChannelId) of
            undefined ->
                undefined;
            Thread ->
                #{
                    thread => Thread,
                    members => maps:from_list([
                        {UserId, Member}
                     || UserId <- lists:usort(UserIds),
                        Member <- [guild_thread_store:get_member(Tab, ChannelId, UserId)],
                        is_map(Member)
                    ])
                }
        end
    catch
        error:badarg -> undefined
    end.

-spec take_forum_thread_created(map()) -> {boolean(), map()}.
take_forum_thread_created(MessageData) ->
    case maps:take(?FORUM_THREAD_CREATED_KEY, MessageData) of
        {true, Rest} -> {true, Rest};
        {_Other, Rest} -> {false, Rest};
        error -> {false, MessageData}
    end.

-spec with_forum_thread_created(boolean(), map()) -> map().
with_forum_thread_created(true, ThreadPush) ->
    ThreadPush#{<<"forum_thread_created">> => true};
with_forum_thread_created(false, ThreadPush) ->
    ThreadPush.

-spec mark_forum_thread_created(map()) -> map().
mark_forum_thread_created(MessageData) ->
    MessageData#{?FORUM_THREAD_CREATED_KEY => true}.

-spec forum_starter(map(), integer(), map()) -> {integer(), #{user_id() => map()}} | undefined.
forum_starter(MessageData, ChannelId, Data) ->
    case snowflake_id:parse_maybe(maps:get(<<"id">>, MessageData, undefined)) of
        ChannelId -> forum_starter_scope(scope(ChannelId, Data), Data);
        _ -> undefined
    end.

-spec forum_starter_scope(scope(), map()) -> {integer(), #{user_id() => map()}} | undefined.
forum_starter_scope(#{thread := Thread, members := Members}, Data) ->
    ParentId = snowflake_id:parse_maybe(maps:get(<<"parent_id">>, Thread, undefined)),
    case
        guild_thread_gate:is_thread_only_type(
            maps:get(<<"type">>, parent_channel(ParentId, Data), undefined)
        )
    of
        true when is_integer(ParentId) -> {ParentId, Members};
        _ -> undefined
    end;
forum_starter_scope(undefined, _Data) ->
    undefined.

-spec parent_channel(integer() | undefined, map()) -> map().
parent_channel(ParentId, Data) when is_integer(ParentId) ->
    case maps:get(ParentId, guild_data_index_channels:channel_index(Data), undefined) of
        Parent when is_map(Parent) -> Parent;
        _ -> #{}
    end;
parent_channel(_ParentId, _Data) ->
    #{}.

-spec member_settings([user_id()], #{user_id() => map()}) -> #{user_id() => map()}.
member_settings(UserIds, Members) ->
    maps:map(
        fun(_UserId, Member) -> maps:with(?MEMBER_SETTING_KEYS, Member) end,
        maps:with(UserIds, Members)
    ).

-spec thread_name(map()) -> binary().
thread_name(Thread) ->
    case binary_or_undefined(maps:get(<<"name">>, Thread, undefined)) of
        undefined -> <<"unknown">>;
        Name -> Name
    end.

-spec binary_or_undefined(term()) -> binary() | undefined.
binary_or_undefined(Value) when is_binary(Value), byte_size(Value) > 0 -> Value;
binary_or_undefined(_Value) -> undefined.

-spec mention_universe(integer(), map()) -> #{user_id() => true} | undefined.
mention_universe(ChannelId, State) ->
    case scope(ChannelId, State) of
        undefined ->
            undefined;
        #{members := Members} ->
            Recipient = guild_thread_gate:recipient_active(ChannelId, State),
            maps:from_keys([UserId || UserId <- maps:keys(Members), Recipient(UserId)], true)
    end.

-spec passive_threads(map(), integer(), map()) -> [map()].
passive_threads(SessionData, UserId, State) ->
    case {guild_thread_gate:session_viewer(SessionData), guild_thread_gate:store(State)} of
        {true, Tab} when Tab =/= undefined -> joined_threads(Tab, UserId);
        _ -> []
    end.

-spec joined_threads(ets:table(), integer()) -> [map()].
joined_threads(Tab, UserId) ->
    try
        [
            Thread
         || ThreadId <- guild_thread_store:user_thread_ids(Tab, UserId),
            Thread <- [guild_thread_store:get_thread(Tab, ThreadId)],
            is_map(Thread)
        ]
    catch
        error:badarg -> []
    end.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

with_store(Fun) ->
    Tab = guild_thread_store:new(),
    try
        guild_thread_store:load(
            Tab,
            [
                #{
                    <<"id">> => 500,
                    <<"parent_id">> => 200,
                    <<"type">> => 11,
                    <<"name">> => <<"t">>
                }
            ],
            [
                #{<<"id">> => <<"500">>, <<"user_id">> => <<"1">>, <<"flags">> => 2},
                #{
                    <<"id">> => <<"500">>,
                    <<"user_id">> => <<"2">>,
                    <<"flags">> => 1,
                    <<"muted">> => true,
                    <<"join_timestamp">> => <<"x">>
                }
            ]
        ),
        Fun(#{
            thread_gate => #{active => true, version => 1},
            thread_store => Tab,
            <<"channels">> => [
                #{<<"id">> => 200, <<"name">> => <<"general">>, <<"parent_id">> => 100},
                #{<<"id">> => 100, <<"name">> => <<"cat">>, <<"type">> => 4}
            ]
        })
    after
        guild_thread_store:destroy(Tab)
    end.

scope_is_undefined_for_plain_channels_and_inactive_guilds_test() ->
    ?assertEqual(undefined, scope(200, #{<<"channels">> => []})),
    with_store(fun(Data) ->
        ?assertEqual(undefined, scope(200, Data)),
        ?assertEqual(undefined, scope(500, Data#{thread_gate => #{active => false}})),
        ?assertMatch(#{members := #{1 := _, 2 := _}}, scope(500, Data))
    end).

push_message_data_stamps_parent_and_member_settings_test() ->
    with_store(fun(Data) ->
        ?assertEqual(undefined, push_message_data(#{}, 200, [1], Data)),
        {MessageData, Name} = push_message_data(#{<<"id">> => <<"9">>}, 500, [2, 3], Data),
        ?assertEqual(<<"t">>, Name),
        ?assertEqual(
            #{
                <<"parent_id">> => 200,
                <<"parent_name">> => <<"general">>,
                <<"category_id">> => 100,
                <<"members">> => #{2 => #{<<"flags">> => 1, <<"muted">> => true}}
            },
            maps:get(?THREAD_PUSH_KEY, MessageData)
        )
    end).

%% 仅在测试期间记录成员读取，并保证 mock 在异常时也被释放
-spec with_mock_store(fun(() -> term())) -> term().
with_mock_store(Fun) ->
    ok = meck:new(guild_thread_store, [passthrough, no_link]),
    try
        Fun()
    after
        meck:unload(guild_thread_store)
    end.

push_message_data_reads_candidate_members_only_test() ->
    with_mock_store(fun() ->
        meck:expect(guild_thread_store, members, fun(_Tab, _ThreadId) ->
            error(unexpected_full_member_scan)
        end),
        with_store(fun(Data) ->
            Tab = maps:get(thread_store, Data),
            MuteConfig = #{<<"end_time">> => <<"2099-01-01T00:00:00Z">>},
            Settings = #{
                <<"flags">> => 1, <<"muted">> => true, <<"mute_config">> => MuteConfig
            },
            ok = guild_thread_store:put_member(Tab, 500, 2, Settings#{
                <<"id">> => 500, <<"user_id">> => 2, <<"join_timestamp">> => <<"x">>
            }),
            {MessageData, <<"t">>} = push_message_data(#{}, 500, [2, 3, 2], Data),
            ThreadPush = maps:get(?THREAD_PUSH_KEY, MessageData),
            ?assertEqual(#{2 => Settings}, maps:get(<<"members">>, ThreadPush)),
            ?assertEqual(1, meck:num_calls(guild_thread_store, get_member, [Tab, 500, 2])),
            ?assertEqual(1, meck:num_calls(guild_thread_store, get_member, [Tab, 500, 3])),
            ?assertEqual(0, meck:num_calls(guild_thread_store, get_member, [Tab, 500, 1])),
            ?assertEqual(0, meck:num_calls(guild_thread_store, members, '_'))
        end)
    end).

push_message_data_matches_full_scope_member_settings_test() ->
    with_store(fun(Data) ->
        #{members := Members} = scope(500, Data),
        lists:foreach(
            fun(UserIds) ->
                {MessageData, <<"t">>} = push_message_data(#{}, 500, UserIds, Data),
                ThreadPush = maps:get(?THREAD_PUSH_KEY, MessageData),
                ?assertEqual(
                    member_settings(UserIds, Members), maps:get(<<"members">>, ThreadPush)
                )
            end,
            [[], [1], [1, 2], [2, 3], [3], [2, 2]]
        )
    end).

push_message_data_preserves_unavailable_scope_fallback_test() ->
    with_store(fun(Data) ->
        ?assertEqual(undefined, push_message_data(#{}, 200, [1], Data)),
        ?assertEqual(
            undefined,
            push_message_data(#{}, 500, [1], Data#{thread_gate => #{active => false}})
        ),
        Deleted = guild_thread_store:new(),
        ok = guild_thread_store:destroy(Deleted),
        ?assertEqual(
            undefined, push_message_data(#{}, 500, [1], Data#{thread_store => Deleted})
        )
    end).

push_message_data_discards_partial_members_if_store_disappears_test() ->
    with_mock_store(fun() ->
        meck:expect(guild_thread_store, get_member, fun(Tab, ThreadId, UserId) ->
            case UserId of
                2 -> guild_thread_store:destroy(Tab);
                _ -> ok
            end,
            meck:passthrough([Tab, ThreadId, UserId])
        end),
        with_store(fun(Data) ->
            ?assertEqual(undefined, push_message_data(#{}, 500, [1, 2], Data))
        end)
    end).

with_forum_store(Fun) ->
    Tab = guild_thread_store:new(),
    try
        guild_thread_store:load(
            Tab,
            [
                #{
                    <<"id">> => 700,
                    <<"parent_id">> => 300,
                    <<"type">> => 11,
                    <<"name">> => <<"post">>
                },
                #{
                    <<"id">> => 500,
                    <<"parent_id">> => 200,
                    <<"type">> => 11,
                    <<"name">> => <<"t">>
                }
            ],
            [#{<<"id">> => <<"700">>, <<"user_id">> => <<"1">>, <<"flags">> => 1}]
        ),
        Fun(#{
            thread_gate => #{active => true, version => 1},
            thread_store => Tab,
            <<"channels">> => [
                #{<<"id">> => 300, <<"name">> => <<"ideas">>, <<"type">> => 15},
                #{<<"id">> => 200, <<"name">> => <<"general">>, <<"type">> => 0}
            ]
        })
    after
        guild_thread_store:destroy(Tab)
    end.

forum_starter_needs_the_starter_message_of_a_forum_post_test() ->
    with_forum_store(fun(Data) ->
        ?assertMatch({300, #{1 := _}}, forum_starter(#{<<"id">> => <<"700">>}, 700, Data)),
        ?assertEqual(undefined, forum_starter(#{<<"id">> => <<"701">>}, 700, Data)),
        ?assertEqual(undefined, forum_starter(#{<<"id">> => <<"500">>}, 500, Data)),
        ?assertEqual(
            undefined,
            forum_starter(#{<<"id">> => <<"700">>}, 700, Data#{
                thread_gate => #{active => false}
            })
        )
    end).

forum_thread_created_marker_moves_into_the_thread_push_test() ->
    with_forum_store(fun(Data) ->
        Marked = mark_forum_thread_created(#{<<"id">> => <<"700">>}),
        {MessageData, <<"post">>} = push_message_data(Marked, 700, [2], Data),
        ?assertNot(maps:is_key(<<"__forum_thread_created">>, MessageData)),
        ?assertMatch(
            #{
                <<"parent_id">> := 300,
                <<"parent_name">> := <<"ideas">>,
                <<"forum_thread_created">> := true
            },
            maps:get(?THREAD_PUSH_KEY, MessageData)
        ),
        {Plain, _} = push_message_data(#{<<"id">> => <<"701">>}, 700, [2], Data),
        ?assertNot(maps:is_key(<<"forum_thread_created">>, maps:get(?THREAD_PUSH_KEY, Plain)))
    end).

forum_thread_created_keeps_member_scan_for_many_watchers_test() ->
    with_mock_store(fun() ->
        meck:expect(guild_thread_store, get_member, fun(_Tab, _ThreadId, _UserId) ->
            error(unexpected_watcher_lookup)
        end),
        with_forum_store(fun(Data) ->
            Tab = maps:get(thread_store, Data),
            Marked = mark_forum_thread_created(#{<<"id">> => <<"700">>}),
            UserIds = [1 | lists:seq(1000, 2999)],
            {MessageData, <<"post">>} = push_message_data(Marked, 700, UserIds, Data),
            ThreadPush = maps:get(?THREAD_PUSH_KEY, MessageData),
            ?assertEqual(#{1 => #{<<"flags">> => 1}}, maps:get(<<"members">>, ThreadPush)),
            ?assertEqual(true, maps:get(<<"forum_thread_created">>, ThreadPush)),
            ?assertEqual(1, meck:num_calls(guild_thread_store, members, [Tab, 700])),
            ?assertEqual(0, meck:num_calls(guild_thread_store, get_member, '_'))
        end)
    end).

passive_threads_need_a_viewer_session_test() ->
    with_store(fun(Data) ->
        State = #{data => Data},
        ?assertEqual([], passive_threads(#{thread_viewer => false}, 1, State)),
        ?assertEqual([], passive_threads(#{thread_viewer => true}, 3, State)),
        ?assertMatch(
            [#{<<"id">> := 500}], passive_threads(#{thread_viewer => true}, 1, State)
        )
    end).

-endif.
