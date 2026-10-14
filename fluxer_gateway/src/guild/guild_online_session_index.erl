%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_online_session_index).
-typing([eqwalizer]).

-export([for_users/2]).

-define(CACHE_KEY, {?MODULE, by_user}).

%% 按用户取得全部在线设备，会话映射变化后重新构建索引
-spec for_users(map(), [integer()]) -> map().
for_users(Sessions, UserIds) ->
    %% 社区进程持有不可变会话映射，身份不变时可复用用户索引
    Index = index(Sessions),
    lists:foldl(
        fun(UserId, Acc) -> maps:merge(Acc, maps:get(UserId, Index, #{})) end,
        #{},
        UserIds
    ).

%% 复用当前会话映射的索引，连接、断开和设备更新都会使缓存失效
-spec index(map()) -> map().
index(Sessions) ->
    case erlang:get(?CACHE_KEY) of
        {Previous, Index} ->
            case erts_debug:same(Previous, Sessions) of
                true -> Index;
                false -> build(Sessions)
            end;
        _ ->
            build(Sessions)
    end.

%% 将每个用户的多设备会话聚合，并保存本进程的索引快照
-spec build(map()) -> map().
build(Sessions) ->
    %% 一次遍历收集所有设备，同一用户的会话不会互相覆盖
    Index = maps:fold(
        fun
            (Sid, #{user_id := UserId} = Session, Acc) when is_integer(UserId) ->
                UserSessions = maps:get(UserId, Acc, #{}),
                Acc#{UserId => UserSessions#{Sid => Session}};
            (_Sid, _Session, Acc) ->
                Acc
        end,
        #{},
        Sessions
    ),
    _ = erlang:put(?CACHE_KEY, {Sessions, Index}),
    Index.
