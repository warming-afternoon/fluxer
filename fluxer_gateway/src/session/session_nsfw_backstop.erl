%% SPDX-License-Identifier: AGPL-3.0-or-later
%% Session-side defense for presence/read-state events, including channel-only ACKs.
-module(session_nsfw_backstop).
-export([snapshot/1, attach_snapshot/2, consume_snapshot/2, publish_changes/3, check/3]).
-define(KEY, <<"__forum_nsfw_channels">>).

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

attach_snapshot(GuildState, State) ->
    case maps:get(id, State, undefined) =:= gateway_nsfw_preferences:scope() of
        true -> GuildState#{?KEY => snapshot(State)};
        false -> GuildState
    end.

consume_snapshot(GuildState, State) ->
    case maps:take(?KEY, GuildState) of
        {Channels, Public} when is_map(Channels) ->
            {Public, State#{forum_nsfw_channels => Channels}};
        error -> {GuildState, State}
    end.

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

hides_nsfw(#{forum_nsfw_preference := #{guild_id := GuildId}, user_id := UserId}) when
    is_integer(GuildId) ->
    gateway_nsfw_preferences:fenced(GuildId, UserId) orelse
        element(1, gateway_nsfw_preferences:current(GuildId, UserId)) =/= true;
hides_nsfw(_State) -> false.

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

parent_hidden(Data, Channels) ->
    Context = maps:get(<<"channel_context">>, Data, Data),
    ParentId = snowflake_id:parse_optional(maps:get(<<"parent_id">>, Context, undefined)),
    maps:get(ParentId, Channels, true) =/= false.

channel_id(Event, Data) when Event =:= channel_create; Event =:= channel_update;
    Event =:= channel_delete; Event =:= thread_create; Event =:= thread_update;
    Event =:= thread_delete ->
    snowflake_id:parse_optional(maps:get(<<"id">>, Data, undefined));
channel_id(_Event, Data) ->
    snowflake_id:parse_optional(maps:get(<<"channel_id">>, Data, undefined)).

guild_id(Data) ->
    snowflake_id:parse_optional(maps:get(<<"__guild_id">>, Data,
        maps:get(<<"__thread_scoped">>, Data, maps:get(<<"guild_id">>, Data, undefined)))).
