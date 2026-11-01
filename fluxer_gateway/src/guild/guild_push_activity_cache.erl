%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_push_activity_cache).
-typing([eqwalizer]).

-export([get/4]).

-define(CACHE_KEY, {?MODULE, snapshot}).

%% 复用活跃状态推导的通知资格和等待会话，宽限截止时间由调用方逐条生成
-spec get(map(), term(), boolean(), fun(() -> {map(), map()})) -> {map(), map()}.
get(Sessions, Presences, PresenceMode, Build) ->
    %% 在线状态在 ETS 中原地更新，需要同时检查写入序列和表身份
    Seq = guild_member_list_read:presence_seq(),
    case erlang:get(?CACHE_KEY) of
        {OldSessions, OldPresences, Seq, PresenceMode, Eligibility, Held} ->
            case
                erts_debug:same(OldSessions, Sessions) andalso
                    erts_debug:same(OldPresences, Presences)
            of
                true -> {Eligibility, Held};
                false -> build(Sessions, Presences, Seq, PresenceMode, Build)
            end;
        _ ->
            build(Sessions, Presences, Seq, PresenceMode, Build)
    end.

%% 状态变化后重新计算并保存通知资格，避免跨消息复用截止时间
-spec build(map(), term(), non_neg_integer(), boolean(), fun(() -> {map(), map()})) ->
    {map(), map()}.
build(Sessions, Presences, Seq, PresenceMode, Build) ->
    {Eligibility, Held} = Build(),
    _ = erlang:put(?CACHE_KEY, {Sessions, Presences, Seq, PresenceMode, Eligibility, Held}),
    {Eligibility, Held}.
