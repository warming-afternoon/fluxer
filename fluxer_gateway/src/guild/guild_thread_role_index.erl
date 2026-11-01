%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(guild_thread_role_index).
-export([install/1, rebuild/2, update_member/4, roles_changed/2, destroy/1, count/2, decide/2]).
-define(KEY, thread_role_counts).
-define(LIMIT, 3000).
-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").
-endif.

%% 仅guild持有进程建立小计数表；成员集合继续复用原不可变索引，不复制第二份全成员表。
-spec install(map()) -> map().
install(Data) ->
    Tab = ets:new(?MODULE, [set, protected, {read_concurrency, true}]),
    Gen = make_ref(),
    ets:insert(Tab, [{ready, false}, {generation, Gen}]),
    Handle = #{table => Tab, generation => Gen, owner => self()},
    try
        Index = maps:get(<<"member_role_index">>, Data),
        true = is_map(Index),
        maps:foreach(
            fun(RoleId, Members) ->
                true = is_map(Members),
                ets:insert(Tab, {{role, RoleId}, map_size(Members)})
            end,
            Index
        ),
        %% 明确的部分加载或总人数不一致不能发布ready。
        Members = guild_data_index_members:member_map(Data),
        Expected = type_conv:to_integer(maps:get(members_loaded_count, Data, undefined)),
        Complete =
            maps:get(members_complete, Data, false) =:= true andalso
                Expected =:= map_size(Members),
        ets:insert(Tab, {ready, Complete}),
        Data#{?KEY => Handle}
    catch
        _:_ -> Data#{?KEY => Handle}
    end.

%% 重建先撤销旧代，旧快照不能用新计数搭配旧成员集合。
-spec rebuild(map(), map()) -> map().
rebuild(Old, New) ->
    destroy(Old),
    install(maps:remove(?KEY, New)).

%% 加入退出或角色变更只更新差集计数，并给返回数据换代。
-spec update_member(map(), integer(), [integer()], [integer()]) -> map().
update_member(Data, _UserId, OldRoles0, NewRoles0) ->
    case maps:get(?KEY, Data, undefined) of
        #{table := Tab, owner := Owner} = Handle when Owner =:= self() ->
            try
                WasReady = ets:lookup_element(Tab, ready, 2),
                Gen = make_ref(),
                ets:insert(Tab, [{ready, false}, {generation, Gen}]),
                OldRoles = lists:usort(OldRoles0),
                NewRoles = lists:usort(NewRoles0),
                lists:foreach(
                    fun(Role) ->
                        case ets:lookup(Tab, {role, Role}) of
                            [] ->
                                ok;
                            [{{role, Role}, N}] when N > 0 ->
                                ets:update_counter(Tab, {role, Role}, -1);
                            _ ->
                                error(role_count_underflow)
                        end
                    end,
                    OldRoles -- NewRoles
                ),
                lists:foreach(
                    fun(Role) ->
                        ets:update_counter(
                            Tab,
                            {role, Role},
                            1,
                            {{role, Role}, 0}
                        )
                    end,
                    NewRoles -- OldRoles
                ),
                ets:insert(Tab, {ready, WasReady}),
                Data#{
                    ?KEY => Handle#{generation => Gen},
                    members_loaded_count => map_size(maps:get(members_normalized, Data, #{}))
                }
            catch
                _:_ ->
                    try
                        ets:insert(Tab, {ready, false})
                    catch
                        _:_ -> ok
                    end,
                    maps:remove(?KEY, Data)
            end;
        _ ->
            Data
    end.

-ifdef(TEST).
%% 超大组只读计数，不创建持有人列表；并集超限停止且direct由独立层处理。
role_boundaries_test() ->
    lists:foreach(
        fun(N) ->
            Data = install(#{
                members_complete => true,
                members_loaded_count => 0,
                members_normalized => #{},
                <<"member_role_index">> =>
                    #{10 => maps:from_keys(lists:seq(1, N), true)}
            }),
            try
                D = decide(Data, [10]),
                case N =< 3000 of
                    true ->
                        ?assertEqual(N, length(maps:get(role_user_ids, D)));
                    false ->
                        ?assertEqual(0, maps:get(enumerated_ids, D)),
                        ?assertEqual([role_group_too_large], maps:get(warnings, D))
                end
            after
                destroy(Data)
            end
        end,
        [2999, 3000, 3001, 300000]
    ).

%% 重叠允许去重，超限不得截断；超大组不影响其余小组。
role_union_test() ->
    Data = install(#{
        members_complete => true,
        members_loaded_count => 0,
        members_normalized => #{},
        <<"member_role_index">> =>
            #{
                10 => maps:from_keys(lists:seq(1, 3000), true),
                20 => #{3000 => true},
                30 => #{3001 => true},
                40 => maps:from_keys(lists:seq(1, 3001), true)
            }
    }),
    try
        ?assertEqual(3000, length(maps:get(role_user_ids, decide(Data, [10, 20])))),
        D = decide(Data, [10, 30]),
        ?assertEqual([], maps:get(role_user_ids, D)),
        ?assertEqual([role_union_too_large], maps:get(warnings, D)),
        ?assertEqual(3001, maps:get(enumerated_ids, D)),
        Small = decide(Data, [20, 40]),
        ?assertEqual([3000], maps:get(role_user_ids, Small)),
        ?assertEqual([role_group_too_large], maps:get(warnings, Small))
    after
        destroy(Data)
    end.

%% 旧代和未完成加载一律跳过；索引维护遗漏不得触发大枚举。
generation_and_readiness_test() ->
    Data = install(#{
        members_complete => true,
        members_loaded_count => 0,
        members_normalized => #{},
        <<"member_role_index">> => #{10 => #{1 => true}}
    }),
    Next = update_member(Data, 2, [], [10]),
    ?assertEqual(unavailable, count(Data, 10)),
    ?assertEqual({ok, 2}, count(Next, 10)),
    ?assertEqual([role_index_unavailable], maps:get(warnings, decide(Next, [10]))),
    destroy(Next),
    ?assertEqual(unavailable, count(Next, 10)),
    Pending = install(#{
        members_complete => false, members_normalized => #{}, <<"member_role_index">> => #{}
    }),
    try
        ?assertEqual(unavailable, count(Pending, 10))
    after
        destroy(Pending)
    end.

%% 实际成员写入口跨过阈值并退出后恢复，重复写入不重复增加人数。
member_mutation_threshold_test() ->
    Holders = maps:from_keys(lists:seq(1, 3000), true),
    Data0 = install(#{
        members_complete => true,
        members_loaded_count => 0,
        members_normalized => #{},
        <<"member_role_index">> => #{9 => Holders}
    }),
    Member = #{<<"user">> => #{<<"id">> => <<"3001">>}, <<"roles">> => [<<"9">>]},
    Data1 = guild_data_index_members:put_member(Member, Data0),
    Data2 = guild_data_index_members:put_member(Member, Data1),
    try
        ?assertEqual({ok, 3001}, count(Data2, 9)),
        ?assertEqual(0, maps:get(enumerated_ids, decide(Data2, [9]))),
        Data3 = guild_data_index_members:remove_member(3001, Data2),
        ?assertEqual({ok, 3000}, count(Data3, 9)),
        ?assertEqual(3000, length(maps:get(role_user_ids, decide(Data3, [9]))))
    after
        destroy(Data2)
    end.
-endif.

%% 退出或换代只删除本进程拥有的表，不能误删handoff来源的表。
-spec destroy(map()) -> ok.
destroy(Data) ->
    case maps:get(?KEY, Data, undefined) of
        #{table := Tab, owner := Owner} when Owner =:= self() ->
            try
                ets:insert(Tab, {ready, false}),
                ets:delete(Tab),
                ok
            catch
                _:_ -> ok
            end;
        _ ->
            ok
    end.

%% 独立读取小计数和ready/generation，不查找或复制角色成员大map。
-spec count(map(), integer()) -> {ok, non_neg_integer()} | unavailable.
count(#{?KEY := #{table := Tab, generation := Gen}}, RoleId) ->
    try
        true = ets:lookup_element(Tab, ready, 2),
        Gen = ets:lookup_element(Tab, generation, 2),
        N =
            case ets:lookup(Tab, {role, RoleId}) of
                [] -> 0;
                [{{role, RoleId}, Value}] -> Value
            end,
        true = is_integer(N) andalso N >= 0,
        Gen = ets:lookup_element(Tab, generation, 2),
        true = ets:lookup_element(Tab, ready, 2),
        {ok, N}
    catch
        _:_ -> unavailable
    end;
count(_, _) ->
    unavailable.

%% 在拥有索引的进程同步计算有界角色决策，不附加诊断基础设施。
-spec decide(map(), [integer()]) -> map().
decide(Data, Roles) -> decide_raw(Data, Roles).

%% 必须在guild进程内同步决策，原角色map只传引用；先计数再有界枚举。
-spec decide_raw(map(), [integer()]) -> map().
decide_raw(_Data, []) ->
    #{allowed_role_ids => [], role_user_ids => [], warnings => [], enumerated_ids => 0};
decide_raw(Data, RoleIds0) ->
    RoleIds = lists:usort(RoleIds0),
    Handle = maps:get(?KEY, Data, #{}),
    case maps:get(owner, Handle, undefined) =:= self() andalso length(RoleIds) =< 1024 of
        false ->
            #{
                allowed_role_ids => [],
                role_user_ids => [],
                warnings => [role_index_unavailable],
                enumerated_ids => 0
            };
        true ->
            Decisions = [{RoleId, count(Data, RoleId)} || RoleId <- RoleIds],
            case lists:any(fun({_, C}) -> C =:= unavailable end, Decisions) of
                true ->
                    #{
                        allowed_role_ids => [],
                        role_user_ids => [],
                        warnings => [role_index_unavailable],
                        enumerated_ids => 0
                    };
                false ->
                    Allowed = [RoleId || {RoleId, {ok, N}} <- Decisions, N =< ?LIMIT],
                    Warnings =
                        case length(Allowed) < length(RoleIds) of
                            true -> [role_group_too_large];
                            false -> []
                        end,
                    Index = maps:get(<<"member_role_index">>, Data, #{}),
                    %% 对允许的小组再做O(1)尺寸一致性检查，漏维护也不能变成大展开。
                    Consistent = lists:all(
                        fun(Role) ->
                            Members = maps:get(Role, Index, #{}),
                            {ok, N} = count(Data, Role),
                            is_map(Members) andalso map_size(Members) =:= N
                        end,
                        Allowed
                    ),
                    case Consistent of
                        true ->
                            enumerate_roles(Allowed, Index, #{}, 0, Allowed, Warnings);
                        false ->
                            #{
                                allowed_role_ids => [],
                                role_user_ids => [],
                                warnings => [role_index_unavailable],
                                enumerated_ids => 0
                            }
                    end
            end
    end.

%% 删除角色只裁掉索引顶层引用与小计数，不遍历大组全部持有人。
-spec roles_changed(map(), [integer()]) -> map().
roles_changed(Data, RoleIds) ->
    case maps:get(?KEY, Data, undefined) of
        #{table := Tab, owner := Owner} = Handle when Owner =:= self() ->
            try
                Keep = maps:from_keys(RoleIds, true),
                lists:foreach(
                    fun
                        ({{role, Id}, _}) ->
                            case maps:is_key(Id, Keep) of
                                true -> ok;
                                false -> ets:delete(Tab, {role, Id})
                            end;
                        (_) ->
                            ok
                    end,
                    ets:tab2list(Tab)
                ),
                Index = maps:with(RoleIds, maps:get(<<"member_role_index">>, Data, #{})),
                Gen = make_ref(),
                ets:insert(Tab, {generation, Gen}),
                Data#{?KEY => Handle#{generation => Gen}, <<"member_role_index">> => Index}
            catch
                _:_ -> maps:remove(?KEY, Data)
            end;
        _ ->
            Data
    end.

%% 每组只有已验证不超过3000的集合才取迭代器；并集见3001即结束。
-spec enumerate_roles([integer()], map(), map(), non_neg_integer(), [integer()], [atom()]) ->
    map().
enumerate_roles([], _Index, Union, Enumerated, Allowed, Warnings) ->
    #{
        allowed_role_ids => Allowed,
        role_user_ids => lists:sort(maps:keys(Union)),
        warnings => Warnings,
        enumerated_ids => Enumerated
    };
enumerate_roles([RoleId | Rest], Index, Union, Enumerated, Allowed, Warnings) ->
    Members = maps:get(RoleId, Index, #{}),
    case add_members(maps:iterator(Members), Union, Enumerated) of
        {ok, Next, N} ->
            enumerate_roles(Rest, Index, Next, N, Allowed, Warnings);
        {overflow, N} ->
            #{
                allowed_role_ids => [],
                role_user_ids => [],
                warnings => lists:usort([role_union_too_large | Warnings]),
                enumerated_ids => N
            }
    end.

%% 只保留最多3001个不同ID；重复角色持有人不会重复计入并集。
-spec add_members(maps:iterator(), map(), non_neg_integer()) ->
    {ok, map(), non_neg_integer()} | {overflow, non_neg_integer()}.
add_members(Iterator, Union, Enumerated) ->
    case maps:next(Iterator) of
        none ->
            {ok, Union, Enumerated};
        {Id, _, Rest} ->
            Next = Union#{Id => true},
            case map_size(Next) > ?LIMIT of
                true -> {overflow, Enumerated + 1};
                false -> add_members(Rest, Next, Enumerated + 1)
            end
    end.
