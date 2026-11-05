%% SPDX-License-Identifier: AGPL-3.0-or-later

%% Display preference, deliberately separate from roles, age gates and membership.
%% Only startup/update paths mutate these node-local tables. Delivery performs no RPC.
-module(gateway_nsfw_preferences).

-export([
    init/0, scope/0, seed_scope/1, from_startup/1, import/2, attach/2, detach/0, connect_allowed/3,
    current/2, allowed/3, channel_allowed/3, channel_sensitive/2, apply_permissions/4,
    sync_local/1, sync_cluster/1, begin_local/1, begin_local_with_read/2, begin_cluster/1, fenced/2, requires_identify/1, stale_session/1, cache_key/2, note_nodes/1, sync_nodes/0
]).

-define(PREFS, gateway_nsfw_preferences).
-define(SESSIONS, gateway_nsfw_sessions).

init() ->
    %% Keep revocation watermarks if the shared table owner restarts. The top
    %% supervisor outlives every session; a full node restart discards them all.
    Heir = case whereis(fluxer_gateway_sup) of
        Pid when is_pid(Pid), Pid =/= self() -> [{heir, Pid, nsfw_preferences}];
        _ -> []
    end,
    ok = guild_ets_utils:ensure_table(?PREFS,
        [named_table, public, set, {read_concurrency, true} | Heir]),
    ok = guild_ets_utils:ensure_table(?SESSIONS,
        [named_table, public, bag, {read_concurrency, true} | Heir]),
    case os:getenv("INTEGRATION_GUILD_ID") of
        false -> ok;
        Value -> seed_scope(Value)
    end.

scope() ->
    persistent_term:get({?MODULE, scope}, undefined).

seed_scope(Value) ->
    case {scope(), parse_id(Value)} of
        {undefined, GuildId} when is_integer(GuildId), GuildId > 0 ->
            %% Only trusted API startup data or deployment config supplies this.
            persistent_term:put({?MODULE, scope}, GuildId),
            ok;
        _ -> ok
    end.

from_startup(Data) ->
    WireScope = parse_id(maps:get(<<"forum_nsfw_guild_id">>, Data, undefined)),
    Candidate = case scope() of undefined -> WireScope; Configured -> Configured end,
    MemberIds = session_manager_shard_lookup:parse_guild_ids(Data),
    VisitIds = snowflake_id:parse_list(maps:get(<<"visit_guild_ids">>, Data, [])),
    Scope = case lists:member(Candidate, MemberIds ++ VisitIds) of
        true -> Candidate; false -> undefined
    end,
    ValidScope = is_integer(Scope) andalso WireScope =:= Scope,
    Settings = maps:get(<<"user_guild_settings">>, Data, []),
    Setting = lists:foldl(fun
        (S, Acc) when is_map(S) ->
            case parse_id(maps:get(<<"guild_id">>, S, undefined)) =:= Scope of
                true -> S;
                false -> Acc
            end;
        (_, Acc) -> Acc
    end, #{}, Settings),
    #{guild_id => Scope, show_nsfw => ValidScope andalso maps:get(<<"show_nsfw">>, Setting, false) =:= true,
      nsfw_version => version(maps:get(<<"nsfw_version">>, Setting, 0))}.

import(UserId, #{guild_id := GuildId} = Preference) when is_integer(GuildId) ->
    ok = seed_scope(GuildId),
    case GuildId =:= scope() of
        true ->
            merge_preference({GuildId, UserId}, normalized(Preference), false);
        false -> {false, 0}
    end;
import(_UserId, _Preference) -> {false, 0}.

%% Insert before checking the watermark, closing the update/registration race.
attach(UserId, Preference0) ->
    GuildId = maps:get(guild_id, Preference0, undefined),
    Preference = Preference0#{guild_id => GuildId},
    case is_integer(GuildId) of
        false -> Preference;
        true ->
            Snapshot = normalized(Preference),
            _ = import(UserId, Preference),
            true = ets:insert(?SESSIONS, {{GuildId, UserId}, self(), Snapshot}),
            case not fenced(GuildId, UserId) andalso current(GuildId, UserId) =:= Snapshot of
                true -> Preference;
                false ->
                    true = ets:delete_object(?SESSIONS, {{GuildId, UserId}, self(), Snapshot}),
                    error(stale_nsfw_bootstrap)
            end
    end.

%% A newly joined/visited target guild must not borrow another device's cached
%% authority before this session has registered for revocation. Require identify.
connect_allowed(Request, Pid, State) ->
    GuildId = maps:get(id, State, undefined),
    Preference = maps:get(forum_nsfw_preference, Request, #{}),
    case is_integer(GuildId) andalso GuildId =:= scope() andalso
        maps:get(guild_id, Preference, undefined) =/= GuildId of
        true -> gen_server:cast(Pid, nsfw_preference_revoked), false;
        false -> true
    end.

detach() ->
    try ets:match_delete(?SESSIONS, {'_', self(), '_'}) of _ -> ok
    catch error:badarg -> ok end.

current(GuildId, UserId) ->
    try ets:lookup(?PREFS, {GuildId, UserId}) of
        [{{GuildId, UserId}, Show, Version, _Fence}] -> {Show, Version};
        _ -> {false, 0}
    catch error:badarg -> {false, 0} end.

normalized(Preference) ->
    Version = version(maps:get(nsfw_version, Preference, 0)),
    {Version > 0 andalso maps:get(show_nsfw, Preference, false) =:= true, Version}.

version(V) when is_integer(V), V >= 0 -> V;
version(_) -> 0.

%% Preference, version and in-progress fence share ONE atomic ETS row. This
%% prevents an old begin racing a newer commit from resurrecting a cleared fence.
merge_preference(Key, {Show, Version}, Commit) ->
    _ = ets:insert_new(?PREFS, {Key, false, 0, 0}),
    [Old = {Key, OldShow, OldVersion, Fence}] = ets:lookup(?PREFS, Key),
    {NewShow, NewVersion} = case Version > OldVersion orelse
        (Version =:= OldVersion andalso Show =:= false) of
        true -> {Show, Version}; false -> {OldShow, OldVersion}
    end,
    NewFence = case Commit andalso Version >= Fence of true -> 0; false -> Fence end,
    New = {Key, NewShow, NewVersion, NewFence},
    case Old =:= New orelse ets:select_replace(?PREFS, [{Old, [], [{const, New}]}]) =:= 1 of
        true -> {NewShow, NewVersion};
        false -> merge_preference(Key, {Show, Version}, Commit)
    end.

raise_fence(Key, Required) ->
    _ = ets:insert_new(?PREFS, {Key, false, 0, 0}),
    [Old = {Key, Show, Version, Fence}] = ets:lookup(?PREFS, Key),
    case Version >= Required of
        true -> false;
        false ->
            New = {Key, Show, Version, max(Fence, Required)},
            case Old =:= New orelse ets:select_replace(?PREFS, [{Old, [], [{const, New}]}]) =:= 1 of
                true -> true;
                false -> raise_fence(Key, Required)
            end
    end.


allowed(_UserId, _ChannelId, #{api_native_permissions := true}) -> true;
allowed(UserId, ChannelId, State) ->
    GuildId = maps:get(id, State, undefined),
    case GuildId =:= scope() andalso is_integer(GuildId) of
        false -> true;
        true ->
            case current(GuildId, UserId) of
                {true, _} -> (not fenced(GuildId, UserId))
                    orelse not nsfw_channel(ChannelId, State);
                _ -> not nsfw_channel(ChannelId, State)
            end
    end.

channel_allowed(_UserId, _Channel, #{api_native_permissions := true}) -> true;
channel_allowed(UserId, Channel, State) when is_map(Channel) ->
    GuildId = maps:get(id, State, undefined),
    case GuildId =:= scope() andalso is_integer(GuildId) of
        false -> true;
        true ->
            case current(GuildId, UserId) of
                {true, _} -> (not fenced(GuildId, UserId))
                    orelse not nsfw_map(Channel, State);
                _ -> not nsfw_map(Channel, State)
            end
    end.

channel_sensitive(ChannelId, State) -> nsfw_channel(ChannelId, State).

nsfw_channel(undefined, _State) -> false;
nsfw_channel(ChannelId, State) ->
    case guild_permissions_check:find_channel_by_id(ChannelId, State) of
        Channel when is_map(Channel) -> nsfw_map(Channel, State);
        _ ->
            case guild_thread_gate:thread(ChannelId, State) of
                Thread when is_map(Thread) -> nsfw_map(Thread, State);
                _ -> true %% Unknown channels fail closed inside the scoped guild.
            end
    end.

nsfw_map(Channel, State) ->
    case maps:get(<<"type">>, Channel, undefined) of
        T when T =:= 10; T =:= 11; T =:= 12 ->
            ParentId = parse_id(maps:get(<<"parent_id">>, Channel, undefined)),
            case guild_permissions_check:find_channel_by_id(ParentId, State) of
                Parent when is_map(Parent) -> effective_nsfw(Parent, State);
                _ -> true
            end;
        _ -> effective_nsfw(Channel, State)
    end.

effective_nsfw(Channel, State) ->
    case override(Channel) of
        Value when is_boolean(Value) -> Value;
        undefined -> inherited_nsfw(Channel, State)
    end.

inherited_nsfw(#{<<"type">> := 4}, State) -> guild_nsfw(State);
inherited_nsfw(Channel, State) ->
    case parse_id(maps:get(<<"parent_id">>, Channel, undefined)) of
        undefined -> guild_nsfw(State);
        ParentId ->
            case guild_permissions_check:find_channel_by_id(ParentId, State) of
                #{<<"type">> := 4} = Parent ->
                    case override(Parent) of
                        Value when is_boolean(Value) -> Value;
                        undefined -> guild_nsfw(State)
                    end;
                _ -> true
            end
    end.

override(Channel) ->
    case maps:find(<<"nsfw_override">>, Channel) of
        {ok, Value} when is_boolean(Value) -> Value;
        {ok, _} -> undefined;
        error ->
            case maps:get(<<"nsfw">>, Channel, undefined) of
                Value when is_boolean(Value) -> Value;
                _ -> undefined
            end
    end.

guild_nsfw(State) ->
    guild_visitor_permissions:guild_nsfw(maps:get(data, State, #{})).

apply_permissions(Permissions, UserId, ChannelId, State) ->
    case allowed(UserId, ChannelId, State) of true -> Permissions; false -> 0 end.

cache_key(_UserId, #{api_native_permissions := true}) -> api_native_permissions;
cache_key(UserId, State) ->
    GuildId = maps:get(id, State, undefined),
    case GuildId =:= scope() andalso is_integer(GuildId) of
        true -> {current(GuildId, UserId), fenced(GuildId, UserId)};
        false -> unrestricted
    end.

note_nodes(Nodes) ->
    Old = persistent_term:get({?MODULE, peers}, []),
    New = lists:usort(Old ++ Nodes),
    case New =:= Old of true -> ok; false -> persistent_term:put({?MODULE, peers}, New) end.

sync_nodes() ->
    Current = lists:usort([node() | nodes()] ++ gateway_node_router:active_nodes()),
    ok = note_nodes(Current),
    Configured = configured_nodes(),
    Required = cluster_enabled(),
    Complete = Configured =/= [] andalso lists:all(fun(N) -> lists:member(N, Configured) end, Current),
    case Required andalso not Complete of
        true -> gateway_rpc_error:raise(<<"nsfw_expected_gateway_nodes_required">>);
        false -> lists:usort(Current ++ Configured ++ persistent_term:get({?MODULE, peers}, []))
    end.

cluster_enabled() ->
    Configured = try fluxer_gateway_env:get(cluster_enabled) of true -> true; _ -> false
        catch _:_ -> false end,
    Configured orelse nodes() =/= [] orelse
        lists:any(fun(N) -> N =/= node() end, persistent_term:get({?MODULE, peers}, [])).

configured_nodes() ->
    case os:getenv("INTEGRATION_NSFW_GATEWAY_NODES") of
        false -> [];
        Value -> [list_to_atom(string:trim(N)) || N <- string:tokens(Value, ","),
            string:trim(N) =/= ""]
    end.

begin_cluster(Params) -> fanout(begin_local, Params).
sync_cluster(Params) -> fanout(sync_local, Params).

fanout(Function, Params) ->
    Nodes = sync_nodes(),
    {Replies, Failed} = rpc:multicall(Nodes, ?MODULE, Function, [Params], 12000),
    case Failed =:= [] andalso lists:all(fun(R) -> R =:= true end, Replies) of
        true -> true;
        false -> gateway_rpc_error:raise(<<"nsfw_preference_sync_failed">>)
    end.

sync_local(Params) ->
    GuildId = parse_id(maps:get(<<"guild_id">>, Params)),
    UserId = parse_id(maps:get(<<"user_id">>, Params)),
    GuildId = parse_id(maps:get(<<"forum_nsfw_guild_id">>, Params)),
    true = is_integer(GuildId) andalso is_integer(UserId),
    ok = seed_scope(GuildId),
    GuildId = scope(),
    Show = maps:get(<<"show_nsfw">>, Params),
    Version = maps:get(<<"nsfw_version">>, Params),
    true = is_boolean(Show) andalso is_integer(Version) andalso Version >= 0,
    Preference = #{guild_id => GuildId, show_nsfw => Show, nsfw_version => Version},
    Current = merge_preference({GuildId, UserId}, normalized(Preference), true),
    %% Include disconnected/resumable sessions. Wait for termination, not just a cast.
    Sessions = ets:lookup(?SESSIONS, {GuildId, UserId}),
    Results = [case Snapshot =:= Current of
        true -> case fenced(GuildId, UserId) of true -> revoke(Pid); false -> true end;
        false -> revoke(Pid)
    end || {_, Pid, Snapshot} <- Sessions],
    lists:all(fun(Result) -> Result =:= true end, Results) andalso not fenced(GuildId, UserId).

begin_local(Params) ->
    begin_local_with_read(Params, fun(UserId, GuildId) ->
        rpc_client:call(#{<<"type">> => <<"get_nsfw_display_preference">>,
            <<"user_id">> => integer_to_binary(UserId), <<"guild_id">> => integer_to_binary(GuildId)})
    end).

%% Explicit read function keeps the transition independently testable offline.
%% This is internal Erlang code, never a websocket or wire-controlled callback.
begin_local_with_read(Params, Read) ->
    GuildId = parse_id(maps:get(<<"guild_id">>, Params)),
    UserId = parse_id(maps:get(<<"user_id">>, Params)),
    GuildId = parse_id(maps:get(<<"forum_nsfw_guild_id">>, Params)),
    ok = seed_scope(GuildId),
    GuildId = scope(),
    Expected = maps:get(<<"expected_nsfw_version">>, Params),
    true = is_integer(Expected) andalso Expected >= 0 andalso is_integer(UserId),
    %% A node restart clears its memory. Read authority before raising a fence
    %% so an original request paused before begin cannot recreate a fence after
    %% durable recovery has already committed and removed its intent.
    {ok, Native} = Read(UserId, GuildId),
    GuildId = parse_id(maps:get(<<"guild_id">>, Native)),
    NativeVersion = maps:get(<<"nsfw_version">>, Native),
    NativeShow = maps:get(<<"show_nsfw">>, Native),
    true = is_integer(NativeVersion) andalso NativeVersion >= 0 andalso is_boolean(NativeShow),
    case NativeVersion > Expected of
        true -> sync_local(Params#{<<"nsfw_version">> => NativeVersion, <<"show_nsfw">> => NativeShow});
        false ->
            true = NativeVersion =:= Expected,
            case raise_fence({GuildId, UserId}, Expected + 1) of
                false -> true;
                true ->
                    Results = [revoke(Pid) || {_, Pid, _} <- ets:lookup(?SESSIONS, {GuildId, UserId})],
                    lists:all(fun(Result) -> Result =:= true end, Results)
            end
    end.

fenced(GuildId, UserId) ->
    try ets:lookup(?PREFS, {GuildId, UserId}) of
        [{{GuildId, UserId}, _, _, Fence}] -> Fence > 0;
        _ -> false
    catch error:badarg -> true end.

revoke(Pid) ->
    Ref = erlang:monitor(process, Pid),
    Result = try gen_server:call(Pid, nsfw_preference_revoke, 5000) of
        {ok, SocketPid} -> wait_down(Ref, Pid) andalso wait_socket(SocketPid);
        _ -> false
    catch exit:{noproc, _} -> true; exit:{normal, _} -> true; exit:_ -> false end,
    erlang:demonitor(Ref, [flush]),
    Result.

wait_down(Ref, Pid) ->
    receive {'DOWN', Ref, process, Pid, _} -> true
    after 5000 -> false end.

wait_socket(Pid) when is_pid(Pid) ->
    Ref = erlang:monitor(process, Pid),
    Result = wait_down(Ref, Pid),
    erlang:demonitor(Ref, [flush]),
    Result;
wait_socket(_) -> true.

requires_identify(State) ->
    GuildId = scope(),
    case is_integer(GuildId) of
        false -> false;
        true ->
            Preference = maps:get(forum_nsfw_preference, State, #{}),
            maps:get(guild_id, Preference, undefined) =:= GuildId orelse
                lists:member(GuildId, session_init:normalize_guild_ids(maps:get(guilds, State, [])))
    end.

stale_session(State) ->
    case maps:get(forum_nsfw_preference, State, undefined) of
        #{guild_id := GuildId} = Preference when is_integer(GuildId) ->
            UserId = maps:get(user_id, State),
            fenced(GuildId, UserId) orelse
                current(GuildId, UserId) =/= normalized(Preference);
        _ -> false
    end.

parse_id(Value) when is_list(Value) -> parse_id(list_to_binary(Value));
parse_id(Value) -> snowflake_id:parse_optional(Value).
