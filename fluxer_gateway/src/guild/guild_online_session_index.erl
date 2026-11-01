%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_online_session_index).
-typing([eqwalizer]).

-export([for_users/2, for_thread_members/4]).

-define(CACHE_KEY, {?MODULE, by_user}).

%% 按用户取得全部在线设备，会话映射变化后重新构建索引
-spec for_users(map(), [integer()]) -> map().
for_users(_Sessions, []) ->
    #{};
for_users(Sessions, UserIds) ->
    %% 社区进程持有不可变会话映射，身份不变时可复用用户索引
    Index = index(Sessions),
    lists:foldl(
        fun(UserId, Acc) -> maps:merge(Acc, maps:get(UserId, Index, #{})) end,
        #{},
        UserIds
    ).

%% 比较可信关注计数与社区唯一在线用户数，单条消息只扫描较小集合。
-spec for_thread_members(map(), ets:table(), integer(), non_neg_integer()) ->
    {members | online, non_neg_integer(), non_neg_integer(), map()}.
for_thread_members(Sessions, Tab, ThreadId, MemberCount) ->
    %% 索引继续使用同一个会话映射引用失效，不缓存成员关系或权限。
    Index = index(Sessions),
    OnlineCount = map_size(Index),
    case MemberCount =< OnlineCount of
        true ->
            Members = guild_thread_store:member_ids(Tab, ThreadId),
            Candidates = for_users(Sessions, Members),
            {members, OnlineCount, MemberCount, Candidates};
        false ->
            %% 每位在线用户仅探测一次，命中后展开全部设备并按SID去重。
            Candidates = maps:fold(
                fun(UserId, UserSessions, Acc) ->
                    case guild_thread_store:is_member(Tab, ThreadId, UserId) of
                        true -> maps:merge(Acc, UserSessions);
                        false -> Acc
                    end
                end,
                #{},
                Index
            ),
            {online, OnlineCount, OnlineCount, Candidates}
    end.
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
