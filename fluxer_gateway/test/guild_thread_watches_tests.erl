%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_thread_watches_tests).
-include_lib("eunit/include/eunit.hrl").

%% 未加入帖子也能浏览，但只向建立关系的设备投递内容事件
-spec unjoined_delivery_and_renewal_test() -> ok.
unjoined_delivery_and_renewal_test() ->
    setup(),
    try
        State0 = state(),
        Thread = thread(20),
        State = guild_thread_watches:update(request(<<"a">>, [20], 1), State0),
        ?assertEqual([<<"20">>], maps:get(<<"resync_thread_ids">>, ack())),
        ?assert(erts_debug:same(maps:get(sessions, State0), maps:get(sessions, State))),
        ?assertNot(guild_thread_gate:directory_allowed(1, Thread, State)),
        Pairs = guild_thread_gate:thread_sessions(
            message_create, #{}, 20, Thread, undefined, State
        ),
        ?assertEqual([<<"a">>], [Sid || {Sid, _} <- Pairs]),
        ?assertEqual(
            [],
            guild_thread_gate:thread_sessions(typing_start, #{}, 20, Thread, undefined, State)
        ),
        Renewed = guild_thread_watches:update(request(<<"a">>, [20], 2), State),
        ?assertEqual([], maps:get(<<"resync_thread_ids">>, ack())),
        Cleared = guild_thread_watches:update(request(<<"a">>, [], 3), Renewed),
        ?assertEqual([], maps:get(<<"thread_ids">>, ack())),
        ?assertEqual(
            [],
            guild_thread_gate:thread_sessions(
                message_update, #{}, 20, Thread, undefined, Cleared
            )
        )
    after
        teardown()
    end,
    ok.

%% 权限变更即时影响投递，浏览关系不能绕过权限
-spec permission_revocation_test() -> ok.
permission_revocation_test() ->
    setup(),
    try
        State = guild_thread_watches:update(request(<<"a">>, [20], 1), state()),
        ack(),
        Sessions = maps:get(sessions, State),
        Session = maps:get(<<"a">>, Sessions),
        Denied = State#{sessions => Sessions#{<<"a">> => Session#{viewable_channels => #{}}}},
        ?assertEqual(
            [],
            guild_thread_gate:thread_sessions(
                message_delete, #{}, 20, thread(20), undefined, Denied
            )
        ),
        ?assert(guild_thread_watches:watching(<<"a">>, 20, State))
    after
        teardown()
    end,
    ok.

%% 缓存缺失的同帖请求合并查询，同时支持归档上下文
-spec missing_context_requests_are_coalesced_test() -> ok.
missing_context_requests_are_coalesced_test() ->
    setup(),
    meck:new(rpc_client, [non_strict, no_link]),
    meck:expect(rpc_client, call, fun(#{<<"thread_ids">> := Ids}) ->
        {ok, #{<<"threads">> => [thread(binary_to_integer(Id)) || Id <- Ids]}}
    end),
    try
        S1 = guild_thread_watches:update(request(<<"a">>, [40, 41], 1), state()),
        S2 = guild_thread_watches:update(request(<<"b">>, [40, 41], 1), S1),
        Loading = guild_thread_watches:fetch(S2),
        Ready =
            receive
                {thread_watch_fetched, Ref, Result} ->
                    guild_thread_watches:fetched(Ref, Result, Loading)
            after 1000 -> error(missing_fetch_result)
            end,
        A = ack(),
        B = ack(),
        ?assertEqual([<<"40">>, <<"41">>], lists:sort(maps:get(<<"thread_ids">>, A))),
        ?assertEqual([<<"40">>, <<"41">>], lists:sort(maps:get(<<"thread_ids">>, B))),
        ?assertEqual(1, meck:num_calls(rpc_client, call, '_')),
        ?assertEqual([<<"a">>, <<"b">>], lists:sort(guild_thread_watches:sessions(40, Ready)))
    after
        meck:unload(rpc_client),
        teardown()
    end,
    ok.

%% 异步读取完成前关闭帖子，旧查询不能重新建立关系
-spec close_during_metadata_fetch_test() -> ok.
close_during_metadata_fetch_test() ->
    setup(),
    try
        Pending = guild_thread_watches:update(request(<<"a">>, [40], 1), state()),
        Closed = guild_thread_watches:update(request(<<"a">>, [], 2), Pending),
        ?assertEqual([], maps:get(<<"thread_ids">>, ack())),
        ?assertEqual([], guild_thread_watches:sessions(40, Closed)),
        ?assertEqual([], ets:lookup(maps:get(thread_watch_store, Closed), {r, <<"a">>, 0}))
    after
        teardown()
    end,
    ok.

%% 元数据事件投递给浏览会话，删除后释放关系
-spec metadata_update_and_delete_test() -> ok.
metadata_update_and_delete_test() ->
    setup(),
    meck:new(guild_state_threads, [non_strict, no_link]),
    meck:expect(guild_state_threads, apply_event, fun(_, _, S) -> S end),
    meck:new(gateway_dispatch_relay, [non_strict, no_link]),
    Owner = self(),
    meck:expect(gateway_dispatch_relay, dispatch_many, fun(Pids, Event, _Payload, _GuildId) ->
        Owner ! {metadata_delivered, Event, length(Pids)},
        ok
    end),
    try
        State = guild_thread_watches:update(request(<<"a">>, [20], 1), state()),
        ack(),
        {noreply, Updated} = guild_thread_dispatch:handle(
            thread_update,
            (thread(20))#{<<"name">> => <<"updated">>},
            State
        ),
        receive
            {metadata_delivered, thread_update, 1} -> ok
        after 1000 -> error(missing_metadata_update)
        end,
        {noreply, Deleted} = guild_thread_dispatch:handle(thread_delete, thread(20), Updated),
        receive
            {metadata_delivered, thread_delete, 1} -> ok
        after 1000 -> error(missing_metadata_delete)
        end,
        ?assertEqual([], guild_thread_watches:sessions(20, Deleted))
    after
        meck:unload(gateway_dispatch_relay),
        meck:unload(guild_state_threads),
        teardown()
    end,
    ok.

%% 查询失败保留原有关系及到期时间并返回可重试错误
-spec metadata_failure_preserves_old_lease_test() -> ok.
metadata_failure_preserves_old_lease_test() ->
    setup(),
    try
        Original = guild_thread_watches:update(request(<<"a">>, [20], 1), state()),
        ack(),
        Tab = maps:get(thread_watch_store, Original),
        Previous = ets:lookup(Tab, {s, <<"a">>, 20}),
        Pending = guild_thread_watches:update(request(<<"a">>, [20, 40], 2), Original),
        Ref = make_ref(),
        ets:insert(Tab, {{f, 40, 0}, Ref}),
        Failed = guild_thread_watches:fetched(
            Ref,
            {[40], {error, timeout}},
            Pending#{thread_watch_fetch => Ref}
        ),
        Ack = ack(),
        ?assertEqual(false, maps:get(<<"ok">>, Ack)),
        ?assertEqual(<<"THREAD_WATCH_UNAVAILABLE">>, maps:get(<<"code">>, Ack)),
        ?assertEqual(Previous, ets:lookup(Tab, {s, <<"a">>, 20})),
        ?assertEqual([<<"a">>], guild_thread_watches:sessions(20, Failed))
    after
        teardown()
    end,
    ok.

%% 仅最新等待请求存在于索引中，快速切换不保留历史查询队列
-spec rapid_switch_keeps_pending_indexes_bounded_test() -> ok.
rapid_switch_keeps_pending_indexes_bounded_test() ->
    setup(),
    try
        Final = lists:foldl(
            fun(Id, S) ->
                guild_thread_watches:update(request(<<"a">>, [Id], Id), S)
            end,
            state(),
            lists:seq(40, 70)
        ),
        Tab = maps:get(thread_watch_store, Final),
        ?assertEqual([70], ets:select(Tab, [{{{f, '$1', 0}, queued}, [], ['$1']}])),
        ?assertEqual(4, ets:info(Tab, size)),
        Closed = guild_thread_watches:remove_session(<<"a">>, Final),
        ?assertEqual([], guild_thread_watches:sessions(70, Closed)),
        ?assertEqual(1, ets:info(Tab, size))
    after
        teardown()
    end,
    ok.

%% 用小规模功能场景验证回包每次最多唤醒固定数量会话
-spec metadata_resolution_yields_between_batches_test() -> ok.
metadata_resolution_yields_between_batches_test() ->
    setup(),
    try
        Base = state(),
        Session = maps:get(<<"a">>, maps:get(sessions, Base)),
        Sids = [integer_to_binary(N) || N <- lists:seq(1, 300)],
        Initial = Base#{sessions => maps:from_list([{Sid, Session} || Sid <- Sids])},
        Pending = lists:foldl(
            fun(Sid, S) ->
                guild_thread_watches:update(request(Sid, [40], 1), S)
            end,
            Initial,
            Sids
        ),
        Ref = make_ref(),
        ets:insert(maps:get(thread_watch_store, Pending), {{f, 40, 0}, Ref}),
        First = guild_thread_watches:fetched(
            Ref,
            {[40], {ok, #{<<"threads">> => [thread(40)]}}},
            Pending#{thread_watch_fetch => Ref}
        ),
        ?assertEqual(256, ack_count()),
        ?assertEqual(256, length(guild_thread_watches:sessions(40, First))),
        Complete =
            receive
                {thread_watch_resolve, Ref, Ids, Outcome} ->
                    guild_thread_watches:resolve(Ref, Ids, Outcome, First)
            after 1000 -> error(missing_resolution_continuation)
            end,
        ?assertEqual(44, ack_count()),
        ?assertEqual(300, length(guild_thread_watches:sessions(40, Complete)))
    after
        teardown()
    end,
    ok.

%% 只统计本次测试已经收到的订阅确认
-spec ack_count() -> non_neg_integer().
ack_count() ->
    receive
        {'$gen_cast', {thread_watch_ack, _Ack}} -> 1 + ack_count()
    after 0 -> 0
    end.

%% 替换权限边界，保留真实候选索引和租约实现
-spec setup() -> ok.
setup() ->
    meck:new(guild_permissions_check, [non_strict, no_link]),
    meck:expect(guild_permissions_check, find_channel_by_id, fun(100, _) ->
        #{<<"id">> => <<"100">>, <<"type">> => 15}
    end),
    meck:expect(guild_permissions_check, find_member_by_user_id, fun(_, _) -> #{} end),
    meck:new(guild_thread_permissions, [passthrough, no_link]),
    meck:expect(guild_thread_permissions, resolve, fun(_, _, _, _) -> 0 end),
    meck:new(guild_dispatch_filter, [non_strict, no_link]),
    meck:expect(guild_dispatch_filter, is_message_access_filtered_event, fun(_) -> false end),
    ok.

%% 测试结束时移除权限替身
-spec teardown() -> ok.
teardown() ->
    meck:unload(guild_dispatch_filter),
    meck:unload(guild_thread_permissions),
    meck:unload(guild_permissions_check),
    ok.

%% 创建同一用户的两个独立设备会话
-spec state() -> map().
state() ->
    Tab = guild_thread_store:new(),
    guild_thread_store:put_thread(Tab, thread(20)),
    Session = #{
        pid => self(),
        user_id => 1,
        thread_viewer => true,
        viewable_channels => #{100 => true}
    },
    #{
        id => 1,
        data => #{
            thread_gate => #{active => true},
            thread_store => Tab,
            <<"channel_index">> => #{100 => #{<<"type">> => 15}}
        },
        sessions => #{<<"a">> => Session, <<"b">> => Session}
    }.

%% 构造可信公开帖子上下文
-spec thread(integer()) -> map().
thread(Id) ->
    #{
        <<"id">> => integer_to_binary(Id),
        <<"parent_id">> => <<"100">>,
        <<"guild_id">> => <<"1">>,
        <<"type">> => 11
    }.

%% 构造会话已经通过额度检查的内部请求
-spec request(binary(), [integer()], integer()) -> map().
request(Sid, Ids, Generation) ->
    #{
        session_id => Sid,
        session_pid => self(),
        user_id => 1,
        ids => Ids,
        expires => erlang:system_time(millisecond) + 600000,
        generation => Generation,
        nonce => integer_to_binary(Generation)
    }.

%% 等待实际安装关系之后发送的确认
-spec ack() -> map().
ack() ->
    receive
        {'$gen_cast', {thread_watch_ack, Ack}} -> Ack
    after 1000 -> error(missing_ack)
    end.
