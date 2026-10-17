%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(session_thread_watches_tests).
-include_lib("eunit/include/eunit.hrl").

%% 跨服务器最终集合达到十一条时整次拒绝且不刷新期限
-spec cross_guild_limit_test() -> ok.
cross_guild_limit_test() ->
    meck:new(session_dispatch, [non_strict, no_link]),
    meck:expect(session_dispatch, handle_dispatch, fun(thread_watch_ack, Ack, State) ->
        {noreply, State#{test_ack => Ack}}
    end),
    try
        State = state(),
        {noreply, Joined} = session_thread_watches:update(
            request(1, lists:seq(10, 19)), self(), State
        ),
        flush_updates(),
        Leases = maps:get(thread_watch_leases, Joined),
        {noreply, Rejected} = session_thread_watches:update(request(2, [30]), self(), Joined),
        ?assertEqual(Leases, maps:get(thread_watch_leases, Rejected)),
        Ack = maps:get(test_ack, Rejected),
        ?assertEqual(<<"THREAD_WATCH_LIMIT_EXCEEDED">>, maps:get(<<"code">>, Ack)),
        ?assertEqual(11, maps:get(<<"requested_count">>, Ack)),
        ?assertEqual(10, maps:get(<<"limit">>, Ack)),
        ?assertEqual([], flush_updates())
    after
        meck:unload(session_dispatch)
    end,
    ok.

%% 同一请求先移除旧服务器后加入新服务器时按最终十条计数
-spec atomic_switch_and_duplicate_ids_test() -> ok.
atomic_switch_and_duplicate_ids_test() ->
    {noreply, Joined} = session_thread_watches:update(
        request(1, lists:seq(10, 19)), self(), state()
    ),
    flush_updates(),
    Update = #{
        <<"thread_watch_nonce">> => <<"next">>,
        <<"subscriptions">> => #{
            <<"1">> => #{<<"thread_watches">> => []},
            <<"2">> => #{
                <<"thread_watches">> => [
                    integer_to_binary(Id)
                 || Id <- [30, 30 | lists:seq(31, 39)]
                ]
            }
        }
    },
    {noreply, Next} = session_thread_watches:update(Update, self(), Joined),
    Leases = maps:get(thread_watch_leases, Next),
    ?assertNot(maps:is_key(1, Leases)),
    ?assertEqual(10, length(maps:get(ids, maps:get(2, Leases)))),
    ?assertEqual(2, length(flush_updates())),
    ok.

%% 已被替换的连接不能修改订阅
-spec stale_socket_is_ignored_test() -> ok.
stale_socket_is_ignored_test() ->
    Other = spawn(fun() ->
        receive
            stop -> ok
        end
    end),
    State = state(),
    ?assertEqual(
        {noreply, State}, session_thread_watches:update(request(1, [20]), Other, State)
    ),
    Other ! stop,
    ?assertEqual([], flush_updates()),
    ok.

%% 构造只含相关会话的最小状态
-spec state() -> map().
state() ->
    #{
        id => <<"s">>,
        user_id => 1,
        socket_pid => self(),
        thread_channels_capable => true,
        guilds => #{1 => {self(), make_ref()}, 2 => {self(), make_ref()}}
    }.

%% 构造浏览集合完整替换请求
-spec request(integer(), [integer()]) -> map().
request(GuildId, Ids) ->
    #{
        <<"thread_watch_nonce">> => <<"test">>,
        <<"subscriptions">> => #{
            integer_to_binary(GuildId) => #{
                <<"thread_watches">> => [integer_to_binary(Id) || Id <- Ids]
            }
        }
    }.

%% 只清理本测试产生的服务器更新消息
-spec flush_updates() -> [map()].
flush_updates() ->
    receive
        {'$gen_cast', {thread_watch_update, Update}} -> [Update | flush_updates()]
    after 0 -> []
    end.
