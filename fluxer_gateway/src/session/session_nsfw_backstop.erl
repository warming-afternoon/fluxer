%% SPDX-License-Identifier: AGPL-3.0-or-later
%% 会话侧过滤补充频道投递检查，覆盖在线状态和已读事件。
-module(session_nsfw_backstop).
-export([snapshot/1, attach_snapshot/2, consume_snapshot/2, publish_changes/3, check/3]).
-define(KEY, <<"__forum_nsfw_channels">>).

%% 频道分类快照

%% 生成目标社区的频道敏感分类快照。
-spec snapshot(map()) -> #{integer() => boolean()}.
snapshot(#{id := GuildId} = State) ->
    case GuildId =:= gateway_nsfw_preferences:scope() of
        false -> #{};
        true ->
            maps:from_list([
                {snowflake_id:parse(maps:get(<<"id">>, C)),
                    not gateway_nsfw_preferences:channel_allowed(undefined, C, State)}
             || C <- guild_data_channels:channels_from_state(State)
            ])
    end.

%% 将内部分类快照附加到目标社区状态。
-spec attach_snapshot(map(), map()) -> map().
attach_snapshot(GuildState, State) ->
    case maps:get(id, State, undefined) =:= gateway_nsfw_preferences:scope() of
        true -> GuildState#{?KEY => snapshot(State)};
        false -> GuildState
    end.

%% 提取内部快照到会话状态，避免传给客户端。
-spec consume_snapshot(map(), map()) -> {map(), map()}.
consume_snapshot(GuildState, State) ->
    case maps:take(?KEY, GuildState) of
        {Channels, Public} when is_map(Channels) ->
            {Public, State#{forum_nsfw_channels => Channels}};
        error -> {GuildState, State}
    end.

%% 分类变化时通知成员和访客会话更新快照。
-spec publish_changes(atom(), map(), map()) -> ok.
publish_changes(Event, Old, New) when Event =:= channel_create; Event =:= channel_update;
    Event =:= channel_update_bulk; Event =:= channel_delete; Event =:= guild_update ->
    Before = snapshot(Old), After = snapshot(New),
    case Before =:= After of
        true -> ok;
        false ->
            Sessions = maps:values(maps:get(sessions, New, #{})) ++
                maps:values(guild_visitors:sessions(New)),
            [gen_server:cast(Pid, {nsfw_channel_classification, After}) ||
                #{pid := Pid} <- Sessions, is_pid(Pid)],
            ok
    end;
publish_changes(_Event, _Old, _New) -> ok.

%% 事件载荷过滤

%% 过滤隐藏频道事件，并剥离内部社区标识。
-spec check(atom(), term(), map()) -> drop | {ok, term()}.
check(Event, {pre_encoded, Bytes} = Encoded, State) ->
    case hides_nsfw(State) orelse binary:match(Bytes, <<"\"__guild_id\"">>) =/= nomatch of
        false -> {ok, Encoded};
        true ->
            try json:decode(Bytes) of
                Data -> check(Event, Data, State)
            catch _:_ -> drop end
    end;
check(Event, Data, State) when is_map(Data) ->
    case hides_nsfw(State) andalso hidden_payload(Event, Data, State) of
        true -> drop;
        false -> {ok, maps:remove(<<"__guild_id">>, Data)}
    end;
check(Event, Data, State) when is_list(Data) ->
    {ok, [Value || Item <- Data, {ok, Value} <- [check(Event, Item, State)]]};
check(_Event, Data, _State) -> {ok, Data}.

%% 按节点偏好及更新屏障判断会话是否隐藏敏感内容。
-spec hides_nsfw(map()) -> boolean().
hides_nsfw(#{forum_nsfw_preference := #{guild_id := GuildId}, user_id := UserId}) when
    is_integer(GuildId) ->
    gateway_nsfw_preferences:fenced(GuildId, UserId) orelse
        element(1, gateway_nsfw_preferences:current(GuildId, UserId)) =/= true;
hides_nsfw(_State) -> false.

%% 结合频道快照和社区上下文判断载荷是否应丢弃。
-spec hidden_payload(atom(), map(), map()) -> boolean().
hidden_payload(Event, Data, State) ->
    Channels = maps:get(forum_nsfw_channels, State, #{}),
    ChannelId = channel_id(Event, Data),
    GuildId = guild_id(Data),
    case maps:get(ChannelId, Channels, undefined) of
        true -> true;
        false -> false;
        undefined ->
            case GuildId =:= gateway_nsfw_preferences:scope() andalso is_integer(GuildId) of
                false -> false;
                true when ChannelId =:= undefined -> false;
                true -> parent_hidden(Data, Channels)
            end
    end.

%% 未知子频道按父级分类过滤，缺失分类时默认隐藏。
-spec parent_hidden(map(), map()) -> boolean().
parent_hidden(Data, Channels) ->
    Context = maps:get(<<"channel_context">>, Data, Data),
    ParentId = snowflake_id:parse_optional(maps:get(<<"parent_id">>, Context, undefined)),
    maps:get(ParentId, Channels, true) =/= false.

%% 按事件类型读取频道标识。
-spec channel_id(atom(), map()) -> integer() | undefined.
channel_id(Event, Data) when Event =:= channel_create; Event =:= channel_update;
    Event =:= channel_delete; Event =:= thread_create; Event =:= thread_update;
    Event =:= thread_delete ->
    snowflake_id:parse_optional(maps:get(<<"id">>, Data, undefined));
channel_id(_Event, Data) ->
    snowflake_id:parse_optional(maps:get(<<"channel_id">>, Data, undefined)).

%% 兼容内部路由字段并提取社区标识。
-spec guild_id(map()) -> integer() | undefined.
guild_id(Data) ->
    snowflake_id:parse_optional(maps:get(<<"__guild_id">>, Data,
        maps:get(<<"__thread_scoped">>, Data, maps:get(<<"guild_id">>, Data, undefined)))).
