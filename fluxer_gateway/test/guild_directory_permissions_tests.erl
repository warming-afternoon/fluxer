%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(guild_directory_permissions_tests).

-include_lib("eunit/include/eunit.hrl").
-export([fixture/0]).

%% 构造共享父频道的目录权限测试状态。
-spec fixture() -> {map(), map()}.
fixture() ->
    Member = #{
        %% 当前遍历使用的固定成员身份。
        <<"user">> => #{<<"id">> => <<"10">>},

        %% 无附加角色，仅继承服务器默认权限。
        <<"roles">> => []
    },
    Data = guild_data_index:normalize_map(#{
        %% 默认服务器和非当前成员的所有者。
        <<"guild">> => #{<<"id">> => <<"1">>, <<"owner_id">> => <<"999">>},

        %% 默认角色允许查看频道。
        <<"roles">> => [#{<<"id">> => <<"1">>, <<"permissions">> => <<"1024">>}],

        %% 多个子频道复用同一父频道。
        <<"channels">> => [
            #{
                <<"id">> => <<"100">>,
                <<"type">> => 0,
                <<"permission_overwrites">> => []
            }
        ],

        %% 将当前成员加入权限索引。
        <<"members">> => [Member]
    }),
    {Member, #{id => 1, data => Data}}.

%% 构造保留成员列表的子频道测试数据。
-spec thread(integer(), integer(), [binary()]) -> map().
thread(Id, Type, Members) ->
    #{
        %% 当前子频道标识。
        <<"id">> => integer_to_binary(Id),

        %% 共享父权限计算的频道标识。
        <<"parent_id">> => <<"100">>,

        %% 区分公开与私有子频道。
        <<"type">> => Type,

        %% 私有子频道可见性使用的成员列表。
        <<"_fluxer_member_ids">> => Members
    }.

%% 验证父权限复用仍逐项检查私有子频道成员。
-spec cached_permissions_keep_per_thread_membership_test() -> term().
cached_permissions_keep_per_thread_membership_test() ->
    {Member, State} = fixture(),
    Threads = [
        thread(200, 11, []),
        thread(201, 12, []),
        thread(202, 12, [<<"10">>]),
        (thread(203, 11, []))#{<<"parent_id">> => <<"404">>}
    ],
    %% 同一缓存下仍需区分私有成员和未知父频道。
    {Permissions, Cache} = lists:mapfoldl(
        fun(Thread, Acc) ->
            guild_thread_permissions:resolve_cached(10, Thread, Member, State, Acc)
        end,
        #{},
        Threads
    ),
    ?assertEqual([true, false, true, false], [bitset:has(P, 1024) || P <- Permissions]),
    ?assertEqual([100], maps:keys(Cache)),
    ?assertEqual(
        [guild_thread_permissions:resolve(10, T, Member, State) || T <- Threads], Permissions
    ).

%% 验证新遍历立即观察权限变更。
-spec new_traversal_observes_permission_changes_test() -> term().
new_traversal_observes_permission_changes_test() ->
    {Member, State} = fixture(),
    T = thread(200, 11, []),
    {Before, _} = guild_thread_permissions:resolve_cached(10, T, Member, State, #{}),
    Data = maps:get(data, State),
    %% 显式拒绝当前成员后，新遍历不能沿用旧权限。
    Changed = guild_data_index:put_channels(
        [
            #{
                <<"id">> => <<"100">>,
                <<"type">> => 0,
                <<"permission_overwrites">> => [
                    #{
                        <<"id">> => <<"10">>,
                        <<"type">> => 1,
                        <<"allow">> => <<"0">>,
                        <<"deny">> => <<"1024">>
                    }
                ]
            }
        ],
        Data
    ),
    {After, _} = guild_thread_permissions:resolve_cached(
        10, T, Member, State#{data => Changed}, #{}
    ),
    ?assert(bitset:has(Before, 1024)),
    ?assertNot(bitset:has(After, 1024)).

%% 验证目录成员信息与可见结果顺序一致。
-spec directory_members_and_order_match_test() -> term().
directory_members_and_order_match_test() ->
    {Member, State0} = fixture(),
    Tab = guild_thread_store:new(),
    try
        Ts = [thread(200, 11, []), thread(201, 12, []), thread(202, 12, [<<"10">>])],
        lists:foreach(fun(T) -> guild_thread_store:put_thread(Tab, T) end, Ts),
        guild_thread_store:put_member(Tab, 202, 10, #{<<"flags">> => 1}),
        %% 启用目录门并验证成员投影与遍历顺序。
        State = State0#{
            data => (maps:get(data, State0))#{
                thread_gate => #{active => true}, thread_store => Tab
            }
        },
        Result = guild_thread_view:guild_threads(10, #{}, Member, State),
        ?assertEqual([<<"200">>, <<"202">>], [maps:get(<<"id">>, T) || T <- Result]),
        ?assert(maps:is_key(<<"member">>, lists:last(Result))),
        Sync = guild_thread_view:list_sync(1, 10, all, Member, State),
        ?assertEqual(
            [<<"200">>, <<"202">>],
            [maps:get(<<"id">>, T) || T <- maps:get(<<"threads">>, Sync)]
        )
    after
        guild_thread_store:destroy(Tab)
    end.
