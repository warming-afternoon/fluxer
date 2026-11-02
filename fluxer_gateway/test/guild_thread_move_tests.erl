%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_thread_move_tests).

-include_lib("eunit/include/eunit.hrl").

-define(G, 1).
-define(A, 10).
-define(C, 11).
-define(X, 12).
-define(P, 13).
-define(V, 14).
-define(M, 15).
-define(OWNER, 999).
-define(TEXT, 100).
-define(FORUM, 200).
-define(CATEGORY, 300).
-define(HIDDEN, 400).
-define(T1, 500).
-define(T2, 600).
-define(MOD_ROLE, 50).
-define(VIEW, 1024).
-define(SEND, 2048).
-define(HISTORY, 65536).
-define(IN_THREADS, (1 bsl 38)).
-define(MANAGE_THREADS, (1 bsl 34)).
-define(CONFIG_KEY, channel_threads_config).

with_config(Fun) ->
    Previous = persistent_term:get(?CONFIG_KEY, undefined),
    Config = (channel_threads_config:config())#{
        enabled => true,
        included_users =>
            #{
                integer_to_binary(Id) => true
             || Id <- [?A, ?P, ?V, ?M, ?OWNER]
            }
    },
    persistent_term:put(?CONFIG_KEY, Config),
    try
        Fun()
    after
        case Previous of
            undefined -> persistent_term:erase(?CONFIG_KEY);
            _ -> persistent_term:put(?CONFIG_KEY, Previous)
        end
    end.

raw_data() ->
    Gid = integer_to_binary(?G),
    Everyone = integer_to_binary(?VIEW bor ?SEND bor ?HISTORY bor ?IN_THREADS),
    Member = fun(Id, Roles, Bot) ->
        #{
            <<"user">> => #{<<"id">> => integer_to_binary(Id), <<"bot">> => Bot},
            <<"roles">> => Roles,
            <<"joined_at">> => <<"2026-01-01T00:00:00Z">>
        }
    end,
    #{
        <<"guild">> => #{
            <<"id">> => Gid, <<"owner_id">> => integer_to_binary(?OWNER), <<"features">> => []
        },
        <<"roles">> => [
            #{<<"id">> => Gid, <<"permissions">> => Everyone, <<"position">> => 0},
            #{
                <<"id">> => integer_to_binary(?MOD_ROLE),
                <<"permissions">> => integer_to_binary(?MANAGE_THREADS),
                <<"position">> => 1
            }
        ],
        <<"channels">> => [
            #{<<"id">> => <<"100">>, <<"type">> => 0, <<"permission_overwrites">> => []},
            #{
                <<"id">> => <<"300">>,
                <<"type">> => 4,
                <<"permission_overwrites">> => [
                    #{
                        <<"id">> => Gid,
                        <<"type">> => 0,
                        <<"allow">> => <<"0">>,
                        <<"deny">> => <<"1024">>
                    }
                ]
            },
            #{
                <<"id">> => <<"200">>,
                <<"type">> => 15,
                <<"parent_id">> => <<"300">>,
                <<"default_thread_rate_limit_per_user">> => 5,
                <<"permission_overwrites">> => [
                    #{
                        <<"id">> => Gid,
                        <<"type">> => 0,
                        <<"allow">> => <<"1024">>,
                        <<"deny">> => <<"0">>
                    }
                ]
            },
            #{
                <<"id">> => <<"400">>,
                <<"type">> => 0,
                <<"permission_overwrites">> => [
                    #{
                        <<"id">> => integer_to_binary(?P),
                        <<"type">> => 1,
                        <<"allow">> => <<"0">>,
                        <<"deny">> => <<"1024">>
                    }
                ]
            }
        ],
        <<"members">> => [
            Member(?A, [], false),
            Member(?C, [], false),
            Member(?X, [integer_to_binary(?MOD_ROLE)], true),
            Member(?P, [], false),
            Member(?V, [], false),
            Member(?M, [integer_to_binary(?MOD_ROLE)], false),
            Member(?OWNER, [], false)
        ],
        <<"emojis">> => [],
        <<"stickers">> => []
    }.

thread(Id, Parent, Type) ->
    #{
        <<"id">> => integer_to_binary(Id),
        <<"guild_id">> => integer_to_binary(?G),
        <<"parent_id">> => integer_to_binary(Parent),
        <<"owner_id">> => integer_to_binary(?A),
        <<"type">> => Type,
        <<"name">> => <<"thread">>,
        <<"last_message_id">> => null,
        <<"rate_limit_per_user">> => 0,
        <<"flags">> => 0,
        <<"message_count">> => 0,
        <<"total_message_sent">> => 0,
        <<"member_count">> => 1,
        <<"thread_metadata">> => #{
            <<"archived">> => false,
            <<"locked">> => false,
            <<"auto_archive_duration">> => 4320,
            <<"archive_timestamp">> => <<"2026-01-01T00:00:00.000Z">>,
            <<"create_timestamp">> => <<"2026-01-01T00:00:00.000Z">>
        }
    }.

thread_member(ThreadId, UserId) ->
    #{
        <<"id">> => integer_to_binary(ThreadId),
        <<"user_id">> => integer_to_binary(UserId),
        <<"join_timestamp">> => <<"2026-01-01T00:00:00.000Z">>,
        <<"flags">> => 1,
        <<"muted">> => false,
        <<"mute_config">> => null
    }.

active_state(Pids) ->
    Payload = guild_thread_load:load_payload(#{
        <<"threads">> => [thread(?T1, ?TEXT, 11), thread(?T2, ?TEXT, 12)],
        <<"thread_members">> => [thread_member(?T1, ?A), thread_member(?T2, ?A)]
    }),
    Base = #{
        id => ?G,
        member_count => 10,
        data => guild_data_index:normalize_map(raw_data()),
        sessions => sessions(Pids),
        member_list_subscriptions => guild_member_list_subs:new()
    },
    guild_thread_load:install(
        #{
            thread_gate => #{active => true, version => 1},
            thread_tainted => true,
            thread_load => {ok, Payload}
        },
        Base
    ).

sessions(Pids) ->
    maps:from_list([
        {atom_to_binary(Tag), session(Tag, UserId, Bot, Capable, Pid)}
     || {Tag, UserId, Bot, Capable, Pid} <- [
            {a, ?A, false, true, maps:get(a, Pids)},
            {c, ?C, false, true, maps:get(c, Pids)},
            {x, ?X, true, false, maps:get(x, Pids)},
            {p, ?P, false, true, maps:get(p, Pids)},
            {v, ?V, false, true, maps:get(v, Pids)},
            {i, ?A, false, false, maps:get(i, Pids)}
        ]
    ]).

session(Tag, UserId, Bot, Capable, Pid) ->
    #{
        session_id => atom_to_binary(Tag),
        user_id => UserId,
        pid => Pid,
        bot => Bot,
        is_staff => false,
        pending_connect => false,
        active_guilds => sets:from_list([?G]),
        thread_capable => Capable
    }.

start_captures() ->
    Parent = self(),
    maps:from_list([
        {Tag, spawn(fun() -> capture_loop(Tag, Parent) end)}
     || Tag <- [a, c, x, p, v, i]
    ]).

stop_captures(Pids) ->
    maps:foreach(fun(_Tag, Pid) -> Pid ! stop end, Pids).

capture_loop(Tag, Parent) ->
    receive
        stop ->
            ok;
        {'$gen_cast', {dispatch, Event, Payload}} ->
            Parent ! {captured, Tag, Event, decode(Payload)},
            capture_loop(Tag, Parent);
        _Other ->
            capture_loop(Tag, Parent)
    end.

decode({pre_encoded, Bin}) ->
    json:decode(Bin);
decode(Map) when is_map(Map) ->
    json:decode(iolist_to_binary(json:encode(guild_data_wire:payload(Map)))).

drain() ->
    drain([]).

drain(Acc) ->
    receive
        {captured, Tag, Event, Payload} -> drain([{Tag, Event, Payload} | Acc])
    after 150 ->
        lists:reverse(Acc)
    end.

received(Tag, Event, Events) ->
    [Payload || {T, E, Payload} <- Events, T =:= Tag, E =:= Event].

with_guild(Fun) ->
    with_config(fun() ->
        Pids = start_captures(),
        State = active_state(Pids),
        try
            Fun(State)
        after
            guild_thread_store:destroy(guild_thread_gate:store(State)),
            stop_captures(Pids),
            settle_mailbox_age()
        end
    end).

settle_mailbox_age() ->
    receive
        {guild_mailbox_age, Seq} ->
            ok = guild_mailbox_age:handle_mark(Seq),
            settle_mailbox_age()
    after 0 ->
        ok
    end.

dispatch(Event, Data, State) ->
    {noreply, NewState} = guild_dispatch:handle_dispatch(Event, Data, State),
    NewState.

thread_move_recomputes_parent_visibility_test() ->
    with_guild(fun(State0) ->
        State1 = guild_thread_subscriptions:update(<<"p">>, #{threads => true}, State0),
        State2 = dispatch(thread_update, thread(?T1, ?HIDDEN, 11), State1),
        Events = drain(),
        ?assertMatch([_], received(p, thread_delete, Events)),
        ?assertEqual([], received(p, thread_update, Events)),
        ?assertEqual(?HIDDEN, guild_thread_permissions:parent_id(guild_thread_gate:thread(?T1, State2))),
        ?assertNot(lists:member(?T1, guild_thread_store:parent_thread_ids(guild_thread_gate:store(State2), ?TEXT))),
        _State3 = dispatch(thread_update, thread(?T1, ?TEXT, 11), State2),
        ?assertMatch([_], received(p, thread_create, drain()))
    end).

%% 移动只改变父目录，保留当前主线的成员计数与双向索引。
store_move_preserves_member_count_test() ->
    Tab = guild_thread_store:new(),
    try
        ok = guild_thread_store:load(Tab, [thread(?T1, ?TEXT, 11)], [thread_member(?T1, ?A)]),
        ok = guild_thread_store:put_thread(Tab, thread(?T1, ?HIDDEN, 11)),
        ?assertEqual([], guild_thread_store:parent_thread_ids(Tab, ?TEXT)),
        ?assertEqual([?T1], guild_thread_store:parent_thread_ids(Tab, ?HIDDEN)),
        ?assertEqual(1, guild_thread_store:member_count(Tab, ?T1)),
        ?assert(guild_thread_store:is_member(Tab, ?T1, ?A))
    after
        guild_thread_store:destroy(Tab)
    end.

versioned_thread(Parent, Version) ->
    (thread(?T1, Parent, 11))#{<<"_fluxer_state_version">> => Version}.

moved_state(State0) ->
    State1 = guild_thread_subscriptions:update(<<"p">>, #{threads => true}, State0),
    Moved = dispatch(thread_update, versioned_thread(?HIDDEN, 2), State1),
    ?assertMatch([_], received(p, thread_delete, drain())),
    Moved.

assert_hidden(State) ->
    Tab = guild_thread_gate:store(State),
    Current = guild_thread_gate:thread(?T1, State),
    ?assertEqual(?HIDDEN, guild_thread_permissions:parent_id(Current)),
    ?assertEqual(2, maps:get(<<"_fluxer_state_version">>, Current)),
    ?assertEqual([], guild_thread_store:parent_thread_ids(Tab, ?TEXT) -- [?T2]),
    ?assertEqual([?T1], guild_thread_store:parent_thread_ids(Tab, ?HIDDEN)),
    ?assert(guild_thread_store:is_member(Tab, ?T1, ?A)).

late_source_update_does_not_restore_removed_viewer_test() ->
    with_guild(fun(State0) ->
        Moved = moved_state(State0),
        After = dispatch(thread_update, versioned_thread(?TEXT, 1), Moved),
        assert_hidden(After),
        ?assertEqual([], drain()),
        ?assertEqual(1, guild_thread_store:member_count(guild_thread_gate:store(After), ?T1))
    end).

same_version_conflicting_scope_is_ignored_test() ->
    with_guild(fun(State0) ->
        Moved = moved_state(State0),
        SameVersion = dispatch(thread_update, versioned_thread(?TEXT, 2), Moved),
        SameType = (versioned_thread(?HIDDEN, 2))#{<<"type">> => 12},
        After = dispatch(thread_update, SameType, SameVersion),
        assert_hidden(After),
        ?assertEqual(11, maps:get(<<"type">>, guild_thread_gate:thread(?T1, After))),
        ?assertEqual([], drain())
    end).

same_version_native_title_and_slowmode_edit_is_delivered_test() ->
    with_guild(fun(State0) ->
        Moved = moved_state(State0),
        Edit = (versioned_thread(?HIDDEN, 2))#{
            <<"name">> => <<"new title">>, <<"rate_limit_per_user">> => 15
        },
        After = dispatch(thread_update, Edit, Moved),
        assert_hidden(After),
        Current = guild_thread_gate:thread(?T1, After),
        ?assertEqual(<<"new title">>, maps:get(<<"name">>, Current)),
        ?assertEqual(15, maps:get(<<"rate_limit_per_user">>, Current)),
        Events = drain(),
        ?assertMatch([_], received(a, thread_update, Events)),
        ?assertEqual([], received(p, thread_create, Events)),
        ?assertEqual([], received(p, thread_update, Events)),
        ?assert(lists:all(fun({_Tag, _Event, Payload}) ->
            not maps:is_key(<<"_fluxer_state_version">>, Payload)
        end, Events)),
        _Replay = dispatch(thread_update, Edit, After),
        ?assertEqual([], drain())
    end).

newer_version_may_legitimately_move_back_test() ->
    with_guild(fun(State0) ->
        Moved = moved_state(State0),
        After = dispatch(thread_update, versioned_thread(?TEXT, 3), Moved),
        ?assertEqual(?TEXT, guild_thread_permissions:parent_id(guild_thread_gate:thread(?T1, After))),
        ?assertEqual([], guild_thread_store:parent_thread_ids(guild_thread_gate:store(After), ?HIDDEN)),
        ?assertMatch([_], received(p, thread_create, drain())),
        ?assertEqual(1, guild_thread_store:member_count(guild_thread_gate:store(After), ?T1))
    end).

missing_version_cannot_change_bound_parent_or_erase_watermark_test() ->
    with_guild(fun(State0) ->
        Moved = moved_state(State0),
        Unchanged = dispatch(thread_update, thread(?T1, ?TEXT, 11), Moved),
        ?assertEqual([], drain()),
        Edit = (thread(?T1, ?HIDDEN, 11))#{<<"name">> => <<"legacy title">>},
        AfterEdit = dispatch(thread_update, Edit, Unchanged),
        ?assertMatch([_], received(a, thread_update, drain())),
        AfterLate = dispatch(thread_update, versioned_thread(?TEXT, 1), AfterEdit),
        assert_hidden(AfterLate),
        ?assertEqual(<<"legacy title">>, maps:get(<<"name">>, guild_thread_gate:thread(?T1, AfterLate))),
        ?assertEqual([], drain())
    end).

malformed_explicit_versions_are_not_legacy_test() ->
    with_guild(fun(State0) ->
        Moved = moved_state(State0),
        After = lists:foldl(fun(Version, Acc) ->
            dispatch(thread_update, versioned_thread(?TEXT, Version), Acc)
        end, Moved, [-1, 2.0, <<"3">>, null, undefined]),
        assert_hidden(After),
        ?assertEqual([], drain())
    end).

direct_store_update_obeys_version_boundary_test() ->
    with_guild(fun(State0) ->
        Moved = moved_state(State0),
        After = guild_state_threads:apply_event(thread_update, versioned_thread(?TEXT, 1), Moved),
        assert_hidden(After),
        ?assertEqual([], drain())
    end).

stale_member_context_cannot_restore_old_parent_test() ->
    with_guild(fun(State0) ->
        Moved = moved_state(State0),
        Data = #{<<"id">> => integer_to_binary(?T1),
            <<"_fluxer_thread">> => versioned_thread(?TEXT, 1),
            <<"added_members">> => [thread_member(?T1, ?P)], <<"member_count">> => 2},
        After = dispatch(thread_members_update, Data, Moved),
        assert_hidden(After),
        Tab = guild_thread_gate:store(After),
        ?assertEqual(2, guild_thread_store:member_count(Tab, ?T1)),
        ?assert(guild_thread_store:is_member(Tab, ?T1, ?P)),
        ?assertEqual([], received(p, thread_create, drain()))
    end).

private_version_survives_store_handoff_but_not_wire_test() ->
    with_guild(fun(State0) ->
        Moved = moved_state(State0),
        Tab = guild_thread_store:import(guild_thread_store:export(guild_thread_gate:store(Moved))),
        try
            After = Moved#{data => (maps:get(data, Moved))#{thread_store => Tab}},
            Rejected = dispatch(thread_update, versioned_thread(?TEXT, 1), After),
            assert_hidden(Rejected),
            ?assertEqual(1, guild_thread_store:member_count(Tab, ?T1)),
            Current = guild_thread_store:get_thread(Tab, ?T1),
            Payload = guild_data_wire:payload(guild_thread_view:thread_payload(Current)),
            ?assertNot(maps:is_key(<<"_fluxer_state_version">>, Payload)),
            ?assertEqual([], drain())
        after
            guild_thread_store:destroy(Tab)
        end
    end).

watched_context_version_is_kept_when_active_row_is_absent_test() ->
    with_guild(fun(State0) ->
        Moved = moved_state(State0),
        WatchTab = guild_thread_watch_store:new(),
        try
            true = guild_thread_watch_store:put_context(WatchTab, ?T1, versioned_thread(?HIDDEN, 2)),
            ok = guild_thread_store:remove_thread(guild_thread_gate:store(Moved), ?T1),
            Watched = Moved#{thread_watch_store => WatchTab},
            Unchanged = dispatch(thread_update, versioned_thread(?TEXT, 1), Watched),
            ?assertEqual(undefined, guild_thread_gate:thread(?T1, Unchanged)),
            ?assertEqual([], drain()),
            Legacy = (thread(?T1, ?HIDDEN, 11))#{<<"name">> => <<"watched title">>},
            After = dispatch(thread_update, Legacy, Unchanged),
            Current = guild_thread_gate:thread(?T1, After),
            ?assertEqual(?HIDDEN, guild_thread_permissions:parent_id(Current)),
            ?assertEqual(2, maps:get(<<"_fluxer_state_version">>, Current)),
            ?assertEqual(2, maps:get(<<"_fluxer_state_version">>, guild_thread_watch_store:context(WatchTab, ?T1))),
            ?assertEqual([], received(p, thread_create, drain()))
        after
            ets:delete(WatchTab)
        end
    end).

version_fence_does_not_change_delete_or_other_thread_members_test() ->
    with_guild(fun(State0) ->
        Moved = moved_state(State0),
        After = dispatch(thread_delete, versioned_thread(?HIDDEN, 2), Moved),
        Tab = guild_thread_gate:store(After),
        ?assertEqual(undefined, guild_thread_gate:thread(?T1, After)),
        ?assertEqual(unknown, guild_thread_store:member_count(Tab, ?T1)),
        ?assertEqual([], guild_thread_store:parent_thread_ids(Tab, ?HIDDEN)),
        ?assert(guild_thread_store:is_member(Tab, ?T2, ?A)),
        ?assertEqual(1, guild_thread_store:member_count(Tab, ?T2)),
        Events = drain(),
        ?assertMatch([_], received(a, thread_delete, Events)),
        ?assertEqual([], received(p, thread_delete, Events))
    end).
