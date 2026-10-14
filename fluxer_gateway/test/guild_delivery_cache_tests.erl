%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_delivery_cache_tests).
-include_lib("eunit/include/eunit.hrl").

%% 验证多设备索引在断开和会话替换后更新
-spec online_index_tracks_multiple_devices_disconnect_and_session_replacement_test() -> ok.
online_index_tracks_multiple_devices_disconnect_and_session_replacement_test() ->
    Desktop = #{user_id => 10, pid => self(), push_hold => true},
    Phone = #{user_id => 10, pid => self(), push_hold => false},
    Outsider = #{user_id => 20, pid => self()},
    Sessions = #{<<"desktop">> => Desktop, <<"phone">> => Phone, <<"other">> => Outsider},
    ?assertEqual(
        maps:with([<<"desktop">>, <<"phone">>], Sessions),
        guild_online_session_index:for_users(Sessions, [10, 10, 999])
    ),
    ?assertEqual(
        #{<<"phone">> => Phone},
        guild_online_session_index:for_users(maps:remove(<<"desktop">>, Sessions), [10])
    ),
    Replacement = Sessions#{<<"desktop">> => Outsider},
    ?assertEqual(
        #{<<"phone">> => Phone},
        guild_online_session_index:for_users(Replacement, [10])
    ),
    ?assertEqual(#{}, guild_online_session_index:for_users(#{}, [10])).

%% 验证活跃状态不变时命中缓存，设备状态变化后失效
-spec unchanged_activity_reuses_snapshot_and_session_changes_invalidate_it_test() -> ok.
unchanged_activity_reuses_snapshot_and_session_changes_invalidate_it_test() ->
    Build = counting_builder(),
    Sessions = #{<<"desktop">> => #{user_id => 10, push_hold => true}},
    ?assertEqual(
        {#{generation => 1}, #{}},
        guild_push_activity_cache:get(Sessions, undefined, true, Build)
    ),
    ?assertEqual(
        {#{generation => 1}, #{}},
        guild_push_activity_cache:get(Sessions, undefined, true, Build)
    ),
    Backgrounded = Sessions#{<<"desktop">> => #{user_id => 10, push_hold => false}},
    ?assertEqual(
        {#{generation => 2}, #{}},
        guild_push_activity_cache:get(Backgrounded, undefined, true, Build)
    ),
    ?assertEqual(
        {#{generation => 3}, #{}}, guild_push_activity_cache:get(#{}, undefined, true, Build)
    ),
    ?assertEqual(
        {#{generation => 4}, #{}},
        guild_push_activity_cache:get(Sessions, undefined, true, Build)
    ).

%% 验证在线状态原地写入及通知模式变化会使缓存失效
-spec in_place_presence_writes_and_notification_mode_changes_invalidate_snapshot_test() -> ok.
in_place_presence_writes_and_notification_mode_changes_invalidate_snapshot_test() ->
    Tab = ets:new(cache_presence, [set]),
    Sessions = #{<<"desktop">> => #{user_id => 10}},
    Build = counting_builder(),
    try
        ?assertEqual(
            {#{generation => 1}, #{}}, guild_push_activity_cache:get(Sessions, Tab, true, Build)
        ),
        ets:insert(Tab, {10, #{<<"status">> => <<"online">>}}),
        ok = guild_member_list_read:note_presence_write(10),
        ?assertEqual(
            {#{generation => 2}, #{}}, guild_push_activity_cache:get(Sessions, Tab, true, Build)
        ),
        ets:delete(Tab, 10),
        ok = guild_member_list_read:note_presence_write(10),
        ?assertEqual(
            {#{generation => 3}, #{}}, guild_push_activity_cache:get(Sessions, Tab, true, Build)
        ),
        ?assertEqual(
            {#{generation => 4}, #{}},
            guild_push_activity_cache:get(Sessions, Tab, false, Build)
        )
    after
        ets:delete(Tab)
    end.

%% 用计算次数标记快照，验证缓存命中和重建行为
-spec counting_builder() -> fun(() -> {map(), map()}).
counting_builder() ->
    Ref = make_ref(),
    fun() ->
        N =
            case erlang:get(Ref) of
                undefined -> 1;
                Old -> Old + 1
            end,
        put(Ref, N),
        {#{generation => N}, #{}}
    end.
