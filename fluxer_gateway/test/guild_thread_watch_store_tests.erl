%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_thread_watch_store_tests).
-include_lib("eunit/include/eunit.hrl").

%% 续期替换到期索引，不丢上下文也不增加索引行数
-spec renewal_keeps_indexes_bounded_test() -> ok.
renewal_keeps_indexes_bounded_test() ->
    Tab = guild_thread_watch_store:new(),
    Thread = #{<<"id">> => <<"20">>, <<"type">> => 11},
    Now = erlang:system_time(millisecond),
    guild_thread_watch_store:put_context(Tab, 20, Thread),
    ?assertEqual([20], guild_thread_watch_store:replace(Tab, <<"a">>, [20], Now + 10000)),
    lists:foreach(
        fun(N) ->
            ?assertEqual(
                [], guild_thread_watch_store:replace(Tab, <<"a">>, [20], Now + 10000 + N)
            )
        end,
        lists:seq(1, 40)
    ),
    ?assertEqual(5, ets:info(Tab, size)),
    ?assertEqual(Thread, guild_thread_watch_store:context(Tab, 20)),
    ?assertEqual([<<"a">>], guild_thread_watch_store:sessions(Tab, 20, Now)),
    ets:delete(Tab),
    ok.

%% 即使清理尚未执行，到期关系也不能进入接收集合
-spec expiry_does_not_depend_on_sweep_test() -> ok.
expiry_does_not_depend_on_sweep_test() ->
    Tab = guild_thread_watch_store:new(),
    Now = erlang:system_time(millisecond),
    guild_thread_watch_store:replace(Tab, <<"a">>, [20, 21], Now - 1),
    ?assertNot(guild_thread_watch_store:watching(Tab, <<"a">>, 20, Now)),
    ?assertEqual([], guild_thread_watch_store:sessions(Tab, 20, Now)),
    ?assert(guild_thread_watch_store:sweep(Tab, Now, 1)),
    ?assertEqual(4, ets:info(Tab, size)),
    ?assertNot(guild_thread_watch_store:sweep(Tab, Now, 10)),
    ?assertEqual(1, ets:info(Tab, size)),
    ets:delete(Tab),
    ok.

%% 退出只移除目标会话，不影响其他设备和其他帖子
-spec session_and_thread_cleanup_test() -> ok.
session_and_thread_cleanup_test() ->
    Tab = guild_thread_watch_store:new(),
    Expires = erlang:system_time(millisecond) + 600000,
    guild_thread_watch_store:replace(Tab, <<"a">>, [20, 21], Expires),
    guild_thread_watch_store:replace(Tab, <<"b">>, [20], Expires),
    guild_thread_watch_store:remove_session(Tab, <<"a">>),
    ?assertEqual([<<"b">>], guild_thread_watch_store:sessions(Tab, 20, Expires - 1)),
    ?assertEqual([], guild_thread_watch_store:sessions(Tab, 21, Expires - 1)),
    guild_thread_watch_store:remove_thread(Tab, 20),
    ?assertEqual(1, ets:info(Tab, size)),
    ets:delete(Tab),
    ok.

%% 迁移恢复必须保留到期时间且不恢复已消失的会话
-spec handoff_preserves_expiry_test() -> ok.
handoff_preserves_expiry_test() ->
    Tab = guild_thread_watch_store:new(),
    Next = guild_thread_watch_store:new(),
    Now = erlang:system_time(millisecond),
    guild_thread_watch_store:replace(Tab, <<"a">>, [20], Now + 10000),
    guild_thread_watch_store:replace(Tab, <<"gone">>, [21], Now + 10000),
    Rows = guild_thread_watch_store:export(Tab, Now),
    guild_thread_watch_store:restore(Next, Rows, #{<<"a">> => #{}}),
    ?assert(guild_thread_watch_store:watching(Next, <<"a">>, 20, Now + 9999)),
    ?assertNot(guild_thread_watch_store:watching(Next, <<"a">>, 20, Now + 10000)),
    ?assertEqual([], guild_thread_watch_store:sessions(Next, 21, Now)),
    ets:delete(Tab),
    ets:delete(Next),
    ok.

%% 导出前已经过期但尚未清扫的上下文不得留在目标存储
-spec handoff_discards_expired_context_before_sweep_test() -> ok.
handoff_discards_expired_context_before_sweep_test() ->
    Tab = guild_thread_watch_store:new(),
    Next = guild_thread_watch_store:new(),
    Now = erlang:system_time(millisecond),
    try
        guild_thread_watch_store:put_context(Tab, 20, #{<<"id">> => <<"20">>}),
        guild_thread_watch_store:replace(Tab, <<"a">>, [20], Now - 1),
        Rows = guild_thread_watch_store:export(Tab, Now),
        ?assertNot(lists:keymember({s, <<"a">>, 20}, 1, Rows)),
        ?assert(lists:keymember({c, 20, 0}, 1, Rows)),
        guild_thread_watch_store:restore(Next, Rows, #{<<"a">> => #{}}),
        ?assertEqual(undefined, guild_thread_watch_store:context(Next, 20)),
        ?assertNot(guild_thread_watch_store:sweep(Next, Now + 600000, 10)),
        ?assertEqual(1, ets:info(Next, size))
    after
        ets:delete(Tab),
        ets:delete(Next)
    end.

%% 导出时仍有效的租约在迁移途中到期，恢复时也不能留下上下文
-spec handoff_discards_context_expired_during_transfer_test() -> ok.
handoff_discards_context_expired_during_transfer_test() ->
    Tab = guild_thread_watch_store:new(),
    Next = guild_thread_watch_store:new(),
    Now = erlang:system_time(millisecond),
    try
        guild_thread_watch_store:put_context(Tab, 20, #{<<"id">> => <<"20">>}),
        guild_thread_watch_store:replace(Tab, <<"a">>, [20], Now - 1),
        %% 使用较早的导出时刻模拟运输耗时，无需等待真实租约过期
        Rows = guild_thread_watch_store:export(Tab, Now - 10000),
        ?assert(lists:keymember({s, <<"a">>, 20}, 1, Rows)),
        guild_thread_watch_store:restore(Next, Rows, #{<<"a">> => #{}}),
        ?assertEqual([], guild_thread_watch_store:ids(Next, <<"a">>, Now)),
        ?assertEqual(undefined, guild_thread_watch_store:context(Next, 20)),
        ?assertEqual(1, ets:info(Next, size))
    after
        ets:delete(Tab),
        ets:delete(Next)
    end.

%% 只恢复存活会话需要的共享上下文，并保证后续退出仍可完整回收
-spec handoff_restores_only_referenced_contexts_test() -> ok.
handoff_restores_only_referenced_contexts_test() ->
    Tab = guild_thread_watch_store:new(),
    Next = guild_thread_watch_store:new(),
    Now = erlang:system_time(millisecond),
    Thread = #{<<"id">> => <<"20">>, <<"type">> => 11},
    try
        guild_thread_watch_store:put_context(Tab, 20, Thread),
        guild_thread_watch_store:put_context(Tab, 21, #{<<"id">> => <<"21">>}),
        guild_thread_watch_store:replace(Tab, <<"a">>, [20], Now + 600000),
        guild_thread_watch_store:replace(Tab, <<"gone">>, [20, 21], Now + 600000),
        guild_thread_watch_store:put_context(Tab, 22, #{<<"id">> => <<"22">>}),
        %% 上下文先于租约到达，恢复结果仍只由有效租约决定
        Rows = lists:reverse(guild_thread_watch_store:export(Tab, Now)),
        guild_thread_watch_store:restore(Next, Rows, #{<<"a">> => #{}}),
        ?assertEqual([<<"a">>], guild_thread_watch_store:sessions(Next, 20, Now)),
        ?assertEqual(Thread, guild_thread_watch_store:context(Next, 20)),
        ?assertEqual(undefined, guild_thread_watch_store:context(Next, 21)),
        ?assertEqual(undefined, guild_thread_watch_store:context(Next, 22)),
        ?assertEqual(5, ets:info(Next, size)),
        guild_thread_watch_store:remove_session(Next, <<"a">>),
        ?assertEqual(undefined, guild_thread_watch_store:context(Next, 20)),
        ?assertEqual(1, ets:info(Next, size))
    after
        ets:delete(Tab),
        ets:delete(Next)
    end.
