%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(gateway_nsfw_preferences_tests).
-include_lib("eunit/include/eunit.hrl").

setup() ->
    persistent_term:erase({gateway_nsfw_preferences, scope}),
    persistent_term:erase({gateway_nsfw_preferences, peers}),
    ok = gateway_nsfw_preferences:init(),
    ets:delete_all_objects(gateway_nsfw_preferences),
    ets:delete_all_objects(gateway_nsfw_sessions),
    ok = gateway_nsfw_preferences:seed_scope(1).

with_test(Fun) ->
    setup(),
    try Fun() after
        gateway_nsfw_preferences:detach(),
        persistent_term:erase({gateway_nsfw_preferences, scope}),
        persistent_term:erase({gateway_nsfw_preferences, peers})
    end.

pref(Show, Version) -> #{guild_id => 1, show_nsfw => Show, nsfw_version => Version}.

member(Id) -> #{<<"user">> => #{<<"id">> => integer_to_binary(Id)}, <<"roles">> => []}.
channel(Id, Nsfw) -> #{<<"id">> => integer_to_binary(Id), <<"type">> => 0,
    <<"nsfw_override">> => Nsfw, <<"nsfw">> => Nsfw, <<"permission_overwrites">> => []}.
fixture() ->
    Members = [member(10), member(20)],
    Channels = [channel(100, false), channel(101, true)],
    Data = guild_data_index:normalize_map(#{
        <<"guild">> => #{<<"id">> => <<"1">>, <<"owner_id">> => <<"999">>, <<"nsfw">> => false},
        <<"roles">> => [#{<<"id">> => <<"1">>, <<"permissions">> => <<"66560">>}],
        <<"channels">> => Channels, <<"members">> => Members
    }),
    #{id => 1, data => Data, sessions => #{}, member_count => 2}.

missing_scoped_preference_is_closed_test() -> with_test(fun() ->
    State = fixture(),
    ?assert(guild_permissions_check:can_view_channel(10, 100, member(10), State)),
    ?assertNot(guild_permissions_check:can_view_channel(10, 101, member(10), State)),
    ?assertNot(guild_permissions_check:can_view_channel(999, 101, member(999), State)),
    ?assertEqual([100], guild_visibility_channels:get_user_viewable_channels(10, State)),
    ?assert(gateway_nsfw_preferences:allowed(10, 101, State#{id => 2})),
    ets:delete(gateway_nsfw_preferences),
    ?assertNot(gateway_nsfw_preferences:allowed(10, 101, State))
end).

independent_monotonic_preference_test() -> with_test(fun() ->
    State = fixture(),
    ?assertEqual({true, 2}, gateway_nsfw_preferences:import(10, pref(true, 2))),
    ?assert(gateway_nsfw_preferences:allowed(10, 101, State)),
    ?assertNot(gateway_nsfw_preferences:allowed(20, 101, State)),
    ?assertEqual({false, 3}, gateway_nsfw_preferences:import(10, pref(false, 3))),
    ?assertEqual({false, 3}, gateway_nsfw_preferences:import(10, pref(true, 2))),
    ?assertEqual({false, 3}, gateway_nsfw_preferences:import(10, pref(true, 3))),
    ?assertNot(gateway_nsfw_preferences:allowed(10, 101, State)),
    gateway_nsfw_preferences:import(10, pref(true, 4)),
    ?assert(gateway_nsfw_preferences:allowed(10, 101, State))
end).

preference_never_grants_roles_or_private_thread_membership_test() -> with_test(fun() ->
    State = fixture(),
    gateway_nsfw_preferences:import(10, pref(true, 1)),
    DenyData = guild_data_index:put_roles([#{<<"id">> => <<"1">>, <<"permissions">> => <<"0">>}], maps:get(data, State)),
    ?assertNot(guild_permissions_check:can_view_channel(10, 101, member(10), State#{data => DenyData})),
    Thread = #{<<"id">> => <<"201">>, <<"type">> => 12, <<"parent_id">> => <<"101">>},
    ?assertEqual(0, guild_thread_permissions:resolve(10, Thread, member(10), State) band 1024),
    ?assertEqual(1024, guild_thread_permissions:resolve(10,
        Thread#{<<"_fluxer_member_ids">> => [<<"10">>]}, member(10), State) band 1024)
end).

category_guild_and_thread_inheritance_test() -> with_test(fun() ->
    State0 = fixture(), Data0 = maps:get(data, State0),
    Category = (channel(300, true))#{<<"type">> => 4},
    Inherited = (channel(301, null))#{<<"parent_id">> => <<"300">>},
    Safe = (channel(302, false))#{<<"parent_id">> => <<"300">>},
    Data = guild_data_index:put_channels([Category, Inherited, Safe], Data0),
    State = State0#{data => Data},
    ?assertNot(gateway_nsfw_preferences:allowed(10, 301, State)),
    ?assert(gateway_nsfw_preferences:allowed(10, 302, State)),
    Thread = #{<<"id">> => <<"401">>, <<"type">> => 11, <<"parent_id">> => <<"301">>, <<"nsfw">> => false},
    ?assertNot(gateway_nsfw_preferences:channel_allowed(10, Thread, State)),
    {Visible, _} = guild_data_channels:derive_member_view(10, member(10), State, [Category, Inherited, Safe]),
    ?assertEqual([<<"302">>], [maps:get(<<"id">>, C) || C <- Visible]),
    GuildNsfw = Data0#{<<"guild">> => #{<<"id">> => <<"1">>, <<"nsfw">> => true}},
    State2 = State0#{data => guild_data_index:put_channels([channel(500, null)], GuildNsfw)},
    ?assertNot(gateway_nsfw_preferences:allowed(10, 500, State2))
end).

same_roles_do_not_share_display_choices_test() -> with_test(fun() ->
    State = fixture(), Channels = maps:get(<<"channels">>, maps:get(data, State)),
    gateway_nsfw_preferences:import(10, pref(true, 1)),
    {First, State1} = guild_data_channels:member_view(10, member(10), State, Channels),
    {Second, _} = guild_data_channels:member_view(20, member(20), State1, Channels),
    ?assertEqual(2, length(First)), ?assertEqual(1, length(Second)),
    {Map1, Memo} = guild_viewable_memo:memoised_channel_map(10, State, guild_viewable_memo:new(State)),
    {Map2, _} = guild_viewable_memo:memoised_channel_map(20, State, Memo),
    ?assert(maps:is_key(101, Map1)), ?assertNot(maps:is_key(101, Map2)),
    Tab = ets:new(viewable_channels_cache, [set]),
    CachedState = State#{viewable_channels_cache => Tab},
    ?assert(maps:is_key(101, guild_viewable_channels_cache:get(10, [], CachedState))),
    gateway_nsfw_preferences:import(10, pref(false, 2)),
    ?assertNot(maps:is_key(101, guild_viewable_channels_cache:get(10, [], CachedState)))
end).

cached_map_and_permission_fallback_both_deny_delivery_test() -> with_test(fun() ->
    State = fixture(),
    Session = #{user_id => 10, pid => self(), viewable_channels => #{100 => true, 101 => true}},
    Sessions = #{<<"one">> => Session},
    ?assertEqual([], guild_sessions:filter_sessions_for_channel(Sessions, 101, undefined, State)),
    ?assertEqual([], guild_sessions:filter_sessions_for_channel(
        #{<<"one">> => maps:remove(viewable_channels, Session)}, 101, undefined, State)),
    ?assertEqual([], guild_sessions:filter_sessions_for_message(Sessions, 101, <<"100000">>, undefined, State)),
    ?assertEqual(1, length(guild_sessions:filter_sessions_for_channel(Sessions, 100, undefined, State)))
end).

old_bootstrap_transfer_and_replay_are_rejected_test() -> with_test(fun() ->
    Old = pref(true, 1),
    gateway_nsfw_preferences:import(10, pref(false, 2)),
    ?assertError(stale_nsfw_bootstrap, gateway_nsfw_preferences:attach(10, Old)),
    State = #{user_id => 10, forum_nsfw_preference => Old,
        buffer => [#{seq => 1, data => #{secret => true}}], seq => 1},
    ?assert(gateway_nsfw_preferences:stale_session(State)),
    ?assertMatch({stop, normal, {error, invalid_session}, #{buffer := []}},
        session:handle_call({resume, 0, self()}, {self(), make_ref()}, State)),
    ?assertEqual({noreply, State}, session_dispatch:handle_dispatch(message_create, #{}, State))
end).

native_http_permission_read_is_session_independent_test() -> with_test(fun() ->
    State = fixture(),
    ?assertEqual(0, guild_permissions:get_member_permissions(10, 101, State)),
    ?assertEqual(1024, guild_permissions:get_member_permissions(10, 101,
        State#{api_native_permissions => true}) band 1024),
    guild_permission_cache:put_state(State),
    ?assertMatch({ok, 66560}, gateway_rpc_guild_permissions:get_permissions_cached_or_rpc(1, 10, 101)),
    ?assertEqual(0, guild_permissions:get_member_permissions(10, 101, State)),
    ?assertEqual({ok, 0}, guild_permission_cache:get_permissions(1, 10, 101)),
    Result = guild_query_handler:handle_call({get_viewable_channels, #{user_id => 10,
        api_native_permissions => true}}, {self(), make_ref()}, State),
    ?assertMatch({reply, #{channel_ids := _}, State}, Result)
end).

startup_scope_and_missing_fields_test() -> with_test(fun() ->
    Missing = gateway_nsfw_preferences:from_startup(#{<<"forum_nsfw_guild_id">> => <<"1">>}),
    ?assertEqual(false, maps:get(show_nsfw, Missing)),
    gateway_nsfw_preferences:import(10, #{guild_id => 2, show_nsfw => true, nsfw_version => 1}),
    ?assertEqual(1, gateway_nsfw_preferences:scope()),
    ?assertEqual({false, 0}, gateway_nsfw_preferences:current(2, 10)),
    ?assertError({badmatch, 1}, gateway_nsfw_preferences:sync_local(#{
        <<"guild_id">> => <<"2">>, <<"user_id">> => <<"10">>,
        <<"forum_nsfw_guild_id">> => <<"2">>, <<"show_nsfw">> => true, <<"nsfw_version">> => 2}))
end).

unrelated_guild_startup_and_age_update_do_not_register_or_logout_test() -> with_test(fun() ->
    Data = #{<<"forum_nsfw_guild_id">> => <<"1">>, <<"guilds">> => [#{<<"id">> => <<"2">>}],
        <<"user">> => #{<<"nsfw_allowed">> => true},
        <<"user_guild_settings">> => [#{<<"guild_id">> => <<"1">>, <<"show_nsfw">> => true,
            <<"nsfw_version">> => 1}]},
    Preference = gateway_nsfw_preferences:from_startup(Data),
    ?assertEqual(undefined, maps:get(guild_id, Preference)),
    ?assertEqual(Preference, gateway_nsfw_preferences:attach(10, Preference)),
    ?assertEqual([], ets:lookup(gateway_nsfw_sessions, {1, 10})),
    State = #{user_id => 10, forum_nsfw_preference => Preference, guilds => #{2 => undefined},
        seq => 0, buffer => [], socket_pid => undefined},
    ?assertMatch({noreply, _}, session:handle_cast({dispatch, user_update,
        #{<<"nsfw_allowed">> => false}}, State)),
    ?assertEqual([], ets:lookup(gateway_nsfw_preferences, {age, 1, 10})),
    Member = gateway_nsfw_preferences:from_startup(Data#{<<"guilds">> => [#{<<"id">> => <<"1">>}]}),
    ?assertEqual(1, maps:get(guild_id, Member)),
    Visit = gateway_nsfw_preferences:from_startup(Data#{<<"visit_guild_ids">> => [<<"1">>]}),
    ?assertEqual(1, maps:get(guild_id, Visit)),
    Request = #{session_id => <<"new_join">>, user_id => 10, forum_nsfw_preference => Preference},
    ?assertMatch({reply, {error, not_member}, _},
        guild_sessions_connect:handle_session_connect(Request, self(), fixture())),
    receive {'$gen_cast', nsfw_preference_revoked} -> ok after 100 -> error(identify_not_required) end
end).

update_scope_mismatch_closes_current_session_test() -> with_test(fun() ->
    Preference = pref(true, 4),
    gateway_nsfw_preferences:import(10, Preference),
    State = #{user_id => 10, forum_nsfw_preference => Preference,
        socket_pid => self(), buffer => [secret]},
    ?assertMatch({stop, normal, #{buffer := []}}, session:handle_cast(
        {dispatch, user_guild_settings_update, (wire(true, 5))#{<<"forum_nsfw_guild_id">> => <<"2">>}}, State)),
    receive nsfw_preference_revoked -> ok after 100 -> error(socket_not_closed) end,
    ?assertEqual({false, 4}, gateway_nsfw_preferences:current(1, 10))
end).

partition_peer_does_not_disappear_from_confirmation_set_test() -> with_test(fun() ->
    gateway_nsfw_preferences:note_nodes(['nsfw_disconnected@127.0.0.1']),
    gateway_nsfw_preferences:note_nodes([node()]),
    ?assertError({gateway_rpc_error, <<"nsfw_expected_gateway_nodes_required">>},
        gateway_nsfw_preferences:sync_nodes()),
    os:putenv("INTEGRATION_NSFW_GATEWAY_NODES", atom_to_list(node()) ++ ",nsfw_disconnected@127.0.0.1"),
    ?assert(lists:member('nsfw_disconnected@127.0.0.1', gateway_nsfw_preferences:sync_nodes())),
    ?assertError({gateway_rpc_error, <<"nsfw_preference_sync_failed">>},
        gateway_nsfw_preferences:sync_cluster(#{<<"guild_id">> => <<"1">>,
            <<"user_id">> => <<"10">>, <<"forum_nsfw_guild_id">> => <<"1">>,
            <<"show_nsfw">> => false, <<"nsfw_version">> => 2})),
    os:unsetenv("INTEGRATION_NSFW_GATEWAY_NODES")
end).

%% Uses the actual session revoke callback; lightweight actors replace network sockets.
synchronous_fence_stops_all_devices_including_disconnected_test() -> with_test(fun() ->
    Parent = self(),
    Session1 = spawn(fun() -> registered_session(Parent, live) end),
    Session2 = spawn(fun() -> registered_session(Parent, disconnected) end),
    receive {ready, Session1} -> ok end, receive {ready, Session2} -> ok end,
    ?assertEqual(true, gateway_nsfw_preferences:sync_local(#{<<"guild_id">> => <<"1">>,
        <<"user_id">> => <<"10">>, <<"forum_nsfw_guild_id">> => <<"1">>,
        <<"show_nsfw">> => false, <<"nsfw_version">> => 2})),
    ?assertNot(is_process_alive(Session1)), ?assertNot(is_process_alive(Session2)),
    ?assertEqual([], ets:lookup(gateway_nsfw_sessions, {1, 10}))
end).

registered_session(Parent, Kind) ->
    Preference = gateway_nsfw_preferences:attach(10, pref(true, 1)),
    Socket = case Kind of live -> spawn(fun() -> receive nsfw_preference_revoked -> ok end end); disconnected -> undefined end,
    State = #{user_id => 10, socket_pid => Socket, forum_nsfw_preference => Preference,
        buffer => [#{seq => 1, data => secret}], seq => 1},
    Parent ! {ready, self()},
    receive {'$gen_call', From, nsfw_preference_revoke} ->
        {stop, normal, Reply, #{buffer := []}} = session:handle_call(nsfw_preference_revoke, From, State),
        gen_server:reply(From, Reply),
        gateway_nsfw_preferences:detach()
    end.

connect_state() ->
    (fixture())#{member_presence => ets:new(nsfw_member_presence, [set, public]),
        voice_states => #{}, presence_subscriptions => #{10 => 1},
        connected_user_ids => sets:from_list([10]), user_session_counts => #{10 => 1}}.

synchronous_connect_uses_scoped_preference_and_metadata_test() -> with_test(fun() ->
    State0 = connect_state(),
    Request = #{session_id => <<"sync">>, user_id => 10, forum_nsfw_preference => pref(false, 1)},
    {reply, {ok, GuildState}, State1} = guild_sessions_connect:handle_session_connect(Request, self(), State0),
    ?assertEqual([100], [maps:get(<<"id">>, C) || C <- maps:get(<<"channels">>, GuildState)]),
    ?assertEqual(#{100 => false, 101 => true}, maps:get(<<"__forum_nsfw_channels">>, GuildState)),
    gateway_nsfw_preferences:import(10, pref(true, 2)),
    {reply, {ok, Enabled}, _} = guild_sessions_connect:handle_session_connect(Request#{
        forum_nsfw_preference => pref(true, 2)}, self(), State1),
    ?assertEqual(2, length(maps:get(<<"channels">>, Enabled)))
end).

asynchronous_worker_result_is_recomputed_after_preference_update_test() -> with_test(fun() ->
    State = connect_state(),
    Request = #{session_id => <<"async">>, user_id => 10, session_pid => self(),
        forum_nsfw_preference => pref(true, 1)},
    Queued = guild_connect_async:enqueue_session_connect_async(1, 0, Request, #{}, State),
    Results = receive {'$gen_cast', {session_connect_worker_batch_done, R}} -> R after 1000 -> error(worker_timeout) end,
    [{_, 0, {ok, OldGuildState}, _}] = Results,
    ?assertEqual(2, length(maps:get(<<"channels">>, OldGuildState))),
    gateway_nsfw_preferences:sync_local(wire(false, 2)),
    Final = guild_connect_async:finalize_session_connect_batch(Results, Queued),
    Received = receive {guild_connect_result, 1, 0, {ok, _, GS}} -> GS after 1000 -> error(result_timeout) end,
    ?assertEqual([100], [maps:get(<<"id">>, C) || C <- maps:get(<<"channels">>, Received)]),
    Session = maps:get(<<"async">>, maps:get(sessions, Final)),
    ?assertNot(maps:is_key(101, maps:get(viewable_channels, Session)))
end).

asynchronous_classification_changes_are_recomputed_test() -> with_test(fun() ->
    [begin
        State = connect_state(),
        Request = #{session_id => <<"async_classification">>, user_id => 10,
            session_pid => self(), forum_nsfw_preference => pref(false, 1)},
        Queued = guild_connect_async:enqueue_session_connect_async(1, 0, Request, #{}, State),
        Results = receive {'$gen_cast', {session_connect_worker_batch_done, R}} -> R
            after 1000 -> error(worker_timeout) end,
        [{_, 0, {ok, OldGuildState}, _}] = Results,
        ?assertEqual([100], [maps:get(<<"id">>, C) || C <- maps:get(<<"channels">>, OldGuildState)]),
        Data = maps:get(data, Queued),
        ChangedData = case Kind of
            channel -> guild_data_index:put_channels([channel(100, true), channel(101, true)], Data);
            category -> guild_data_index:put_channels([
                (channel(300, true))#{<<"type">> => 4},
                (channel(100, null))#{<<"parent_id">> => <<"300">>}, channel(101, true)], Data);
            guild -> (guild_data_index:put_channels([channel(100, null), channel(101, true)], Data))#{
                <<"guild">> => (maps:get(<<"guild">>, Data))#{<<"nsfw">> => true}}
        end,
        Final = guild_connect_async:finalize_session_connect_batch(Results, Queued#{data => ChangedData}),
        Received = receive {guild_connect_result, 1, 0, {ok, _, GS}} -> GS
            after 1000 -> error(result_timeout) end,
        ?assertEqual([], maps:get(<<"channels">>, Received)),
        ?assertEqual(true, maps:get(100, maps:get(<<"__forum_nsfw_channels">>, Received))),
        Session = maps:get(<<"async_classification">>, maps:get(sessions, Final)),
        ?assertNot(maps:is_key(100, maps:get(viewable_channels, Session)))
    end || Kind <- [channel, category, guild]]
end).

wire(Show, Version) -> #{<<"guild_id">> => <<"1">>, <<"user_id">> => <<"10">>,
    <<"forum_nsfw_guild_id">> => <<"1">>, <<"show_nsfw">> => Show, <<"nsfw_version">> => Version}.
begin_wire(Expected) -> (wire(false, Expected))#{<<"expected_nsfw_version">> => Expected}.

begin_local_test(Params) ->
    gateway_nsfw_preferences:begin_local_with_read(Params, fun(_UserId, _GuildId) ->
        {ok, #{<<"guild_id">> => <<"1">>, <<"show_nsfw">> => false,
            <<"nsfw_version">> => maps:get(<<"expected_nsfw_version">>, Params)}}
    end).

authority_read_prevents_restart_from_resurrecting_recovered_fence_test() -> with_test(fun() ->
    %% Recovery committed true/v2 and removed its intent before this node restarted.
    %% The local watermark is now empty, but authority still wins over old begin/v1.
    put(authority_reads, 0),
    Read = fun(10, 1) ->
        put(authority_reads, get(authority_reads) + 1),
        {ok, #{<<"guild_id">> => <<"1">>, <<"show_nsfw">> => true, <<"nsfw_version">> => 2}}
    end,
    ?assert(gateway_nsfw_preferences:begin_local_with_read(begin_wire(1), Read)),
    ?assertEqual(1, get(authority_reads)),
    ?assertEqual({true, 2}, gateway_nsfw_preferences:current(1, 10)),
    ?assertNot(gateway_nsfw_preferences:fenced(1, 10)),
    ?assertError({badmatch, {error, timeout}}, gateway_nsfw_preferences:begin_local_with_read(
        begin_wire(2), fun(_, _) -> {error, timeout} end)),
    ?assertError({badmatch, false}, gateway_nsfw_preferences:begin_local_with_read(
        begin_wire(3), Read)),
    erase(authority_reads)
end).

pre_fence_blocks_bootstrap_and_only_committed_version_clears_test() -> with_test(fun() ->
    gateway_nsfw_preferences:import(10, pref(true, 1)),
    ?assertEqual(true, begin_local_test(begin_wire(1))),
    ?assert(gateway_nsfw_preferences:fenced(1, 10)),
    ?assertNot(gateway_nsfw_preferences:allowed(10, 101, fixture())),
    ?assertError(stale_nsfw_bootstrap, gateway_nsfw_preferences:attach(10, pref(true, 1))),
    gateway_nsfw_preferences:import(10, pref(true, 2)),
    ?assert(gateway_nsfw_preferences:fenced(1, 10)),
    ?assertEqual(false, gateway_nsfw_preferences:sync_local(wire(true, 1))),
    ?assert(gateway_nsfw_preferences:fenced(1, 10)),
    ?assertEqual(true, gateway_nsfw_preferences:sync_local(wire(false, 2))),
    ?assertNot(gateway_nsfw_preferences:fenced(1, 10)),
    ?assertEqual({false, 2}, gateway_nsfw_preferences:current(1, 10))
end).

recovery_finishes_before_paused_original_begin_test() -> with_test(fun() ->
    gateway_nsfw_preferences:import(10, pref(false, 1)),
    begin_local_test(begin_wire(1)),
    gateway_nsfw_preferences:sync_local(wire(true, 2)),
    %% Original resumes after the durable recovery already committed.
    ?assertEqual(true, begin_local_test(begin_wire(1))),
    ?assertNot(gateway_nsfw_preferences:fenced(1, 10)),
    ?assertEqual({true, 2}, gateway_nsfw_preferences:current(1, 10)),
    %% Opposite-value old intent cannot resurrect a fence or overwrite version 2.
    gateway_nsfw_preferences:sync_local(wire(false, 1)),
    ?assertEqual({true, 2}, gateway_nsfw_preferences:current(1, 10)),
    begin_local_test(begin_wire(2)),
    gateway_nsfw_preferences:sync_local(wire(true, 2)),
    ?assert(gateway_nsfw_preferences:fenced(1, 10)),
    gateway_nsfw_preferences:sync_local(wire(false, 3)),
    ?assertNot(gateway_nsfw_preferences:fenced(1, 10))
end).

concurrent_old_begin_never_resurrects_completed_fence_test() -> with_test(fun() ->
    Parent = self(),
    [begin
        User = 1000 + I,
        Base = (wire(false, 0))#{<<"user_id">> => integer_to_binary(User)},
        Pid = spawn(fun() -> begin_local_test(
            Base#{<<"expected_nsfw_version">> => 0}), Parent ! {done, self()} end),
        ?assertEqual(true, gateway_nsfw_preferences:sync_local(Base#{<<"nsfw_version">> => 1})),
        receive {done, Pid} -> ok end,
        ?assertNot(gateway_nsfw_preferences:fenced(1, User))
    end || I <- lists:seq(1, 100)]
end).

show_true_preserves_native_member_permissions_without_age_mutation_test() -> with_test(fun() ->
    Preference = pref(true, 1),
    State = fixture(),
    gateway_nsfw_preferences:import(10, Preference),
    [begin
        Native = guild_permissions:get_member_permissions(UserId, ChannelId, State#{api_native_permissions => true}),
        gateway_nsfw_preferences:import(UserId, Preference),
        ?assertEqual(Native, guild_permissions:get_member_permissions(UserId, ChannelId, State))
    end || UserId <- [10, 20, 999], ChannelId <- [100, 101]],
    Session = #{user_id => 10, forum_nsfw_preference => Preference, seq => 0, buffer => [],
        socket_pid => undefined, user_data => #{<<"nsfw_allowed">> => false}},
    {noreply, Updated} = session:handle_cast({dispatch, user_update,
        #{<<"nsfw_allowed">> => false, <<"version">> => 7}}, Session),
    ?assertEqual(maps:get(user_data, Session), maps:get(user_data, Updated)),
    ?assertEqual(Preference, maps:get(forum_nsfw_preference, Updated)),
    ?assertNot(gateway_nsfw_preferences:stale_session(Updated)),
    ?assertEqual([], ets:lookup(gateway_nsfw_preferences, {age, 1, 10}))
end).

show_true_cannot_bypass_existing_visitor_age_gate_test() -> with_test(fun() ->
    State = (fixture())#{visitors => guild_visitor_state:new()},
    gateway_nsfw_preferences:import(10, pref(true, 1)),
    NativeMinor = guild_visitor_permissions:viewable_channel_map(State, false),
    NativeAdult = guild_visitor_permissions:viewable_channel_map(State, true),
    {Minor, _} = guild_visitor_snapshot:view(#{adult => false, thread_viewer => false, user_id => 10}, State),
    {Adult, _} = guild_visitor_snapshot:view(#{adult => true, thread_viewer => false, user_id => 10}, State),
    ?assertEqual(NativeMinor, Minor),
    ?assertEqual(NativeAdult, Adult),
    ?assertNot(maps:is_key(101, Minor)),
    ?assert(maps:is_key(101, Adult)),
    gateway_nsfw_preferences:import(10, pref(false, 2)),
    {HiddenAdult, _} = guild_visitor_snapshot:view(#{adult => true, thread_viewer => false, user_id => 10}, State),
    ?assertNot(maps:is_key(101, HiddenAdult)),
    ?assertEqual(NativeMinor, guild_visitor_permissions:viewable_channel_map(State, false)),
    ?assertEqual(NativeAdult, guild_visitor_permissions:viewable_channel_map(State, true))
end).

presence_ack_backstop_strips_scope_and_blocks_hidden_channels_test() -> with_test(fun() ->
    Preference = pref(false, 1), gateway_nsfw_preferences:import(10, Preference),
    State = #{user_id => 10, forum_nsfw_preference => Preference,
        forum_nsfw_channels => session_nsfw_backstop:snapshot(fixture())},
    ?assertEqual(drop, session_nsfw_backstop:check(message_ack,
        #{<<"channel_id">> => <<"101">>}, State)),
    ?assertEqual(drop, session_nsfw_backstop:check(message_ack,
        #{<<"channel_id">> => <<"404">>, <<"__guild_id">> => <<"1">>}, State)),
    ?assertEqual({ok, #{<<"channel_id">> => <<"404">>}}, session_nsfw_backstop:check(message_ack,
        #{<<"channel_id">> => <<"404">>, <<"__guild_id">> => <<"2">>}, State)),
    ?assertEqual({ok, #{<<"channel_id">> => <<"100">>}}, session_nsfw_backstop:check(message_ack,
        #{<<"channel_id">> => <<"100">>, <<"__guild_id">> => <<"1">>}, State)),
    ?assertEqual(drop, session_nsfw_backstop:check(message_create, {pre_encoded,
        iolist_to_binary(json:encode(#{<<"channel_id">> => <<"101">>, <<"guild_id">> => <<"1">>}))}, State)),
    gateway_nsfw_preferences:import(10, pref(true, 2)),
    ?assertEqual({ok, #{<<"channel_id">> => <<"101">>}}, session_nsfw_backstop:check(message_ack,
        {pre_encoded, iolist_to_binary(json:encode(#{<<"channel_id">> => <<"101">>,
            <<"__guild_id">> => <<"1">>}))}, State)),
    {Public, Updated} = session_nsfw_backstop:consume_snapshot(
        session_nsfw_backstop:attach_snapshot(#{<<"channels">> => []}, fixture()), #{}),
    ?assertEqual(#{<<"channels">> => []}, Public),
    ?assertEqual(#{100 => false, 101 => true}, maps:get(forum_nsfw_channels, Updated))
end).

transferred_scoped_session_requires_authoritative_identify_test() -> with_test(fun() ->
    State = #{user_id => 10, forum_nsfw_preference => pref(true, 1), buffer => [secret]},
    Store = #{<<"sid">> => #{state => State, received_at => 0}},
    ?assertEqual({reply, {error, not_found}, #{}}, session_state_transfer:handle_call(
        {pop_state, <<"sid">>}, {self(), make_ref()}, Store)),
    Other = #{guilds => [2], buffer => [safe]},
    ?assertMatch({reply, {ok, Other}, #{}}, session_state_transfer:handle_call(
        {pop_state, <<"sid">>}, {self(), make_ref()}, #{<<"sid">> => #{state => Other}}))
end).

queued_push_is_rechecked_after_disable_and_prefence_test() -> with_test(fun() ->
    Job = #{<<"guild_id">> => <<"1">>, <<"channel_id">> => <<"101">>,
        <<"__nsfw_sensitive">> => true, <<"user_ids">> => [<<"10">>, <<"20">>]},
    ?assertEqual(drop, push_job_publisher:filter_nsfw_job(Job)),
    gateway_nsfw_preferences:import(10, pref(true, 1)),
    ?assertMatch({ok, #{<<"user_ids">> := [<<"10">>]}}, push_job_publisher:filter_nsfw_job(Job)),
    begin_local_test(begin_wire(1)),
    ?assertEqual(drop, push_job_publisher:filter_nsfw_job(Job)),
    gateway_nsfw_preferences:sync_local(wire(false, 2)),
    ?assertEqual(drop, push_job_publisher:filter_nsfw_job(Job)),
    ?assertMatch({ok, #{<<"user_ids">> := [<<"10">>, <<"20">>]}},
        push_job_publisher:filter_nsfw_job(Job#{<<"__nsfw_sensitive">> => false})),
    ?assertMatch({ok, _}, push_job_publisher:filter_nsfw_job(Job#{<<"guild_id">> => <<"2">>}))
end).

hot_delivery_has_zero_external_calls_test() -> with_test(fun() ->
    State = fixture(),
    gateway_nsfw_preferences:import(10, pref(true, 1)),
    Sessions = maps:from_list([{integer_to_binary(I), #{user_id => 10,
        viewable_channels => #{100 => true, 101 => true}}} || I <- lists:seq(1, 200)]),
    Parent = self(), Tracer = spawn(fun() -> trace_loop(Parent, 0) end),
    [code:ensure_loaded(M) || M <- [rpc_client, rpc, erpc]],
    [erlang:trace_pattern({M, '_', '_'}, true, [local]) || M <- [rpc_client, rpc, erpc]],
    erlang:trace(self(), true, [call, {tracer, Tracer}]),
    Samples = [begin {Us, Found} = timer:tc(fun() ->
        guild_sessions:filter_sessions_for_channel(Sessions, 101, undefined, State)
    end), ?assertEqual(200, length(Found)), Us end || _ <- lists:seq(1, 200)],
    erlang:trace(self(), false, [call]),
    erlang:trace_delivered(self()),
    receive {trace_delivered, _, _} -> ok end,
    Tracer ! done,
    receive {external_calls, Count} -> ?assertEqual(0, Count) end,
    [erlang:trace_pattern({M, '_', '_'}, false, [local]) || M <- [rpc_client, rpc, erpc]],
    Sorted = lists:sort(Samples),
    io:format(user, "NSFW 200-device fanout: p50=~pus p95=~pus, external_calls=0, events=200~n",
        [lists:nth(100, Sorted), lists:nth(190, Sorted)])
end).
trace_loop(Parent, N) ->
    receive
        {trace, _, call, _} -> trace_loop(Parent, N + 1);
        done -> Parent ! {external_calls, N}
    end.
