%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_forum_subscription_tests).
-include_lib("eunit/include/eunit.hrl").

%% 构造最小社区状态，并在回归结束后清理线程存储
-spec with_state(fun((map()) -> term())) -> term().
with_state(Fun) ->
    Tab = guild_thread_store:new(),
    Member = fun(Id) ->
        #{<<"user">> => #{<<"id">> => integer_to_binary(Id)}, <<"roles">> => []}
    end,
    Data0 = guild_data_index:normalize_map(#{
        <<"guild">> => #{<<"id">> => <<"1">>, <<"owner_id">> => <<"999">>},
        <<"roles">> => [#{<<"id">> => <<"1">>, <<"permissions">> => <<"66560">>}],
        <<"members">> => [Member(10), Member(20)],
        <<"channels">> => [
            #{<<"id">> => <<"100">>, <<"type">> => 0, <<"permission_overwrites">> => []},
            #{<<"id">> => <<"200">>, <<"type">> => 15, <<"permission_overwrites">> => []},
            #{<<"id">> => <<"201">>, <<"type">> => 16, <<"permission_overwrites">> => []}
        ]
    }),
    Session = fun(Id) ->
        #{
            user_id => Id,
            pid => self(),
            thread_viewer => true,
            pending_connect => false,
            thread_subscribed => true,
            thread_member_lists => [500],
            bot => Id =:= 20,
            active_guilds => sets:from_list([1]),
            viewable_channels => #{100 => true, 200 => true, 201 => true}
        }
    end,
    State = #{
        id => 1,
        member_count => 2,
        data => Data0#{thread_gate => #{active => true}, thread_store => Tab},
        sessions => #{<<"joined">> => Session(10), <<"outsider">> => Session(20)}
    },
    Threads = [thread(500, 200), thread(501, 200), thread(502, 100), thread(503, 201)],
    ok = guild_thread_store:load(Tab, Threads, [member(500, 10), member(503, 10)]),
    try
        Fun(State)
    after
        guild_thread_store:destroy(Tab)
    end.

%% 构造回归所需的最小线程元数据
-spec thread(integer(), integer()) -> map().
thread(Id, Parent) ->
    #{
        <<"id">> => integer_to_binary(Id),
        <<"guild_id">> => <<"1">>,
        <<"parent_id">> => integer_to_binary(Parent),
        <<"type">> => 11,
        <<"name">> => <<"post">>,
        <<"thread_metadata">> => #{<<"archived">> => false}
    }.
%% 构造回归所需的线程成员记录
-spec member(integer(), integer()) -> map().
member(Id, UserId) ->
    #{
        <<"id">> => integer_to_binary(Id),
        <<"user_id">> => integer_to_binary(UserId),
        <<"flags">> => 0
    }.
%% 提取并排序目录结果中的线程编号以便断言
-spec ids([map()]) -> [integer()].
ids(Threads) -> lists:sort([snowflake_id:parse(maps:get(<<"id">>, T)) || T <- Threads]).

%% 验证各目录同步范围均隐藏未加入的论坛和媒体帖子
-spec directory_scopes_hide_unjoined_forum_and_media_test() -> ok.
directory_scopes_hide_unjoined_forum_and_media_test() ->
    with_state(fun(State) ->
        Member = guild_permissions_check:find_member_by_user_id(10, State),
        lists:foreach(
            fun(Scope) ->
                Sync = guild_thread_view:list_sync(1, 10, Scope, Member, State),
                ?assertEqual([500, 502, 503], ids(maps:get(<<"threads">>, Sync)))
            end,
            [all, joined, [100, 200, 201]]
        ),
        ?assertEqual(
            [500, 502, 503], ids(guild_thread_view:guild_threads(10, #{}, Member, State))
        ),
        Other = guild_permissions_check:find_member_by_user_id(20, State),
        ?assertEqual(
            [502], ids(guild_thread_view:guild_threads(20, #{bot => true}, Other, State))
        )
    end).

%% 验证机器人和订阅不会绕过论坛成员规则
-spec all_message_changes_require_membership_even_for_subscribed_bots_test() -> ok.
all_message_changes_require_membership_even_for_subscribed_bots_test() ->
    with_state(fun(State) ->
        Forum = guild_thread_gate:thread(500, State),
        lists:foreach(
            fun(Event) ->
                Targets = guild_thread_gate:thread_sessions(
                    Event, #{<<"id">> => <<"900">>}, 500, Forum, undefined, State
                ),
                ?assertEqual([<<"joined">>], [Sid || {Sid, _} <- Targets])
            end,
            [
                message_create,
                message_update,
                message_delete,
                message_delete_bulk,
                message_reaction_add,
                message_reaction_remove,
                typing_start
            ]
        ),
        Plain = guild_thread_gate:thread(502, State),
        ?assertEqual(
            2,
            length(
                guild_thread_gate:thread_sessions(
                    message_create, #{<<"id">> => <<"900">>}, 502, Plain, undefined, State
                )
            )
        )
    end).

%% 验证直接提及、加入和退出对消息接收范围的影响
-spec direct_mention_notifies_then_join_and_leave_change_delivery_test() -> ok.
direct_mention_notifies_then_join_and_leave_change_delivery_test() ->
    with_state(fun(State) ->
        Thread = guild_thread_gate:thread(500, State),
        Mention = #{<<"id">> => <<"900">>, <<"mentions">> => [#{<<"id">> => <<"20">>}]},
        ?assertEqual(
            2,
            length(
                guild_thread_gate:thread_sessions(
                    message_create, Mention, 500, Thread, undefined, State
                )
            )
        ),
        ?assertEqual(
            1,
            length(
                guild_thread_gate:thread_sessions(
                    message_update, Mention, 500, Thread, undefined, State
                )
            )
        ),
        Tab = guild_thread_gate:store(State),
        guild_thread_store:put_member(Tab, 500, 20, member(500, 20)),
        ?assert(guild_thread_gate:directory_allowed(20, Thread, State)),
        ?assertEqual(
            2,
            length(
                guild_thread_gate:thread_sessions(
                    message_update, #{<<"id">> => <<"900">>}, 500, Thread, undefined, State
                )
            )
        ),
        guild_thread_store:remove_member(Tab, 500, 20),
        ?assertNot(guild_thread_gate:directory_allowed(20, Thread, State)),
        ?assertEqual(
            1,
            length(
                guild_thread_gate:thread_sessions(
                    message_update, #{<<"id">> => <<"900">>}, 500, Thread, undefined, State
                )
            )
        )
    end).

%% 验证归档事件按携带的成员快照判断资格
-spec archived_context_uses_its_membership_snapshot_test() -> ok.
archived_context_uses_its_membership_snapshot_test() ->
    with_state(fun(State) ->
        Context = (thread(700, 200))#{<<"_fluxer_member_ids">> => [<<"10">>]},
        ?assert(guild_thread_gate:directory_allowed(10, Context, State)),
        ?assertNot(guild_thread_gate:directory_allowed(20, Context, State))
    end).

%% 验证索引分发保留多设备、断开和成员撤销行为
-spec indexed_delivery_preserves_multiple_devices_reconnects_and_permission_revocation_test() ->
    ok.
indexed_delivery_preserves_multiple_devices_reconnects_and_permission_revocation_test() ->
    with_state(fun(State) ->
        Thread = guild_thread_gate:thread(500, State),
        Sessions = maps:get(sessions, State),
        Joined = maps:get(<<"joined">>, Sessions),
        Multi = State#{sessions => Sessions#{<<"second-device">> => Joined}},
        Event = #{<<"id">> => <<"900">>},
        Targets = guild_thread_gate:thread_sessions(
            message_create, Event, 500, Thread, undefined, Multi
        ),
        ?assertEqual(
            [<<"joined">>, <<"second-device">>], lists:sort([Sid || {Sid, _} <- Targets])
        ),
        Disconnected = Multi#{sessions => maps:remove(<<"joined">>, maps:get(sessions, Multi))},
        ?assertEqual([<<"second-device">>], [
            Sid
         || {Sid, _} <-
                guild_thread_gate:thread_sessions(
                    message_create, Event, 500, Thread, undefined, Disconnected
                )
        ]),
        NotViewer = Joined#{thread_viewer => false},
        Revoked = State#{sessions => Sessions#{<<"joined">> => NotViewer}},
        ?assertEqual(
            [],
            guild_thread_gate:thread_sessions(
                message_create, Event, 500, Thread, undefined, Revoked
            )
        ),
        Tab = guild_thread_gate:store(State),
        guild_thread_store:remove_member(Tab, 500, 10),
        ?assertEqual(
            [],
            guild_thread_gate:thread_sessions(
                message_create, Event, 500, Thread, undefined, Multi
            )
        ),
        guild_thread_store:put_member(Tab, 500, 10, member(500, 10)),
        ?assertEqual(
            2,
            length(
                guild_thread_gate:thread_sessions(
                    message_create, Event, 500, Thread, undefined, Multi
                )
            )
        )
    end).

%% 验证索引候选和直接提及不会绕过父频道权限
-spec indexed_candidates_and_direct_mentions_do_not_bypass_parent_permissions_test() -> ok.
indexed_candidates_and_direct_mentions_do_not_bypass_parent_permissions_test() ->
    with_state(fun(State) ->
        Tab = guild_thread_gate:store(State),
        Thread = guild_thread_gate:thread(500, State),
        Data = guild_data_index:normalize_map(#{
            <<"guild">> => #{<<"id">> => <<"1">>, <<"owner_id">> => <<"999">>},
            <<"roles">> => [#{<<"id">> => <<"1">>, <<"permissions">> => <<"0">>}],
            <<"members">> => [
                #{<<"user">> => #{<<"id">> => <<"10">>}, <<"roles">> => []},
                #{<<"user">> => #{<<"id">> => <<"20">>}, <<"roles">> => []}
            ],
            <<"channels">> => [
                #{<<"id">> => <<"200">>, <<"type">> => 15, <<"permission_overwrites">> => []}
            ]
        }),
        Sessions = maps:map(
            fun(_Sid, Session) -> Session#{viewable_channels => #{}} end,
            maps:get(sessions, State)
        ),
        Denied = State#{
            data => Data#{thread_gate => #{active => true}, thread_store => Tab},
            sessions => Sessions
        },
        Mention = #{<<"id">> => <<"900">>, <<"mentions">> => [#{<<"id">> => <<"20">>}]},
        ?assertEqual(
            [],
            guild_thread_gate:thread_sessions(
                message_create, Mention, 500, Thread, undefined, Denied
            )
        )
    end).
