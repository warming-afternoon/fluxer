%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_request_forum_unreads).
-typing([eqwalizer]).

-export([handle_request/3, scope/3]).

-define(MAX_THREADS, 40).
-define(MAX_COUNT, 25).
-define(GUILD_CALL_TIMEOUT_MS, 2000).

-type request_context() :: #{
    guild_id := integer(), channel_id := integer(), user_id := integer()
}.
-type thread_request() :: {integer(), integer() | undefined}.
-type thread_scope() :: {stored, integer() | undefined} | unstored.

-spec handle_request(map(), pid(), map()) -> ok.
handle_request(Data, SocketPid, SessionState) ->
    UserId = snowflake_id:parse_maybe(maps:get(user_id, SessionState, undefined)),
    case session_viewer(UserId, SessionState) of
        false ->
            SocketPid ! forum_unreads_unknown_opcode,
            ok;
        true ->
            handle_viewer_request(Data, UserId, SessionState)
    end.

-spec session_viewer(integer() | undefined, map()) -> boolean().
session_viewer(UserId, SessionState) ->
    Bot = type_conv:is_true(maps:get(bot, SessionState, false)),
    Capable = type_conv:is_true(maps:get(thread_channels_capable, SessionState, false)),
    case channel_threads_config:loaded() of
        false -> (Bot orelse Capable) andalso is_integer(UserId);
        true -> guild_thread_gate:compute_viewer(true, Bot, Capable, UserId)
    end.

-spec handle_viewer_request(map(), integer() | undefined, map()) -> ok.
handle_viewer_request(Data, UserId, SessionState) ->
    GuildId = snowflake_id:parse_maybe(maps:get(<<"guild_id">>, Data, undefined)),
    ChannelId = snowflake_id:parse_maybe(maps:get(<<"channel_id">>, Data, undefined)),
    SessionPid = maps:get(session_pid, SessionState, undefined),
    SessionId = maps:get(session_id, SessionState, undefined),
    Parsed =
        case
            {GuildId, ChannelId, parse_threads(maps:get(<<"threads">>, Data, undefined)),
                SessionPid}
        of
            {ParsedGuildId, ParsedChannelId, [_ | _] = ParsedThreads, ParsedPid} when
                is_integer(ParsedGuildId),
                is_integer(ParsedChannelId),
                is_integer(UserId),
                is_pid(ParsedPid),
                is_binary(SessionId)
            ->
                {
                    #{
                        guild_id => ParsedGuildId,
                        channel_id => ParsedChannelId,
                        user_id => UserId
                    },
                    ParsedThreads,
                    ParsedPid,
                    SessionId
                };
            _ ->
                undefined
        end,
    maybe
        {#{guild_id := G, channel_id := C, user_id := U} = Context, Threads, Pid, S} ?= Parsed,
        Request = #{
            session_id => S,
            user_id => U,
            channel_id => C,
            thread_ids => [ThreadId || {ThreadId, _Ack} <- Threads]
        },
        Guilds = session_visits:member_guilds(SessionState),
        {ok, Scopes} ?= guild_scope(maps:get(G, Guilds, undefined), Request),
        Entries = resolve(Context, Threads, Scopes),
        dispatch(Pid, Context, Entries)
    else
        _ -> ok
    end.

-spec parse_threads(term()) -> [thread_request()].
parse_threads(Threads) when is_list(Threads) ->
    take_threads(Threads, #{}, []);
parse_threads(_Threads) ->
    [].

-spec take_threads([term()], #{integer() => true}, [thread_request()]) -> [thread_request()].
take_threads(_Rest, _Seen, Acc) when length(Acc) >= ?MAX_THREADS ->
    lists:reverse(Acc);
take_threads([], _Seen, Acc) ->
    lists:reverse(Acc);
take_threads([#{<<"thread_id">> := RawId} = Entry | Rest], Seen, Acc) ->
    case snowflake_id:parse_maybe(RawId) of
        ThreadId when is_integer(ThreadId), not is_map_key(ThreadId, Seen) ->
            Ack = snowflake_id:parse_maybe(maps:get(<<"ack_message_id">>, Entry, undefined)),
            take_threads(Rest, Seen#{ThreadId => true}, [{ThreadId, Ack} | Acc]);
        _ ->
            take_threads(Rest, Seen, Acc)
    end;
take_threads([_ | Rest], Seen, Acc) ->
    take_threads(Rest, Seen, Acc).

-spec guild_scope(term(), map()) -> {ok, map()} | denied.
guild_scope({GuildPid, _Ref}, Request) when is_pid(GuildPid) ->
    try
        guild_query_handler:call(
            GuildPid, {get_forum_unread_scope, Request}, ?GUILD_CALL_TIMEOUT_MS
        )
    of
        {ok, Scopes} when is_map(Scopes) -> {ok, Scopes};
        _ -> denied
    catch
        exit:{noproc, _} ->
            denied;
        exit:{timeout, _} ->
            denied;
        Class:Reason:Stacktrace ->
            logger:warning(
                "guild_forum_unread_scope_failed: guild_pid=~p request=~p "
                "class=~p reason=~p stack=~p",
                [GuildPid, Request, Class, Reason, Stacktrace]
            ),
            denied
    end;
guild_scope(_Guild, _Request) ->
    denied.

%% 主动未读查询按真实访问权限处理，冷帖子交由API再次授权。
-spec scope(map() | undefined, map(), map()) -> {ok, #{integer() => thread_scope()}} | denied.
scope(undefined, _Request, _State) ->
    denied;
scope(Session, #{channel_id := ForumId, thread_ids := ThreadIds}, State) when
    is_integer(ForumId), is_list(ThreadIds)
->
    case
        guild_thread_gate:session_viewer(Session) andalso is_forum(ForumId, State) andalso
            guild_member_list_connected:session_can_view_channel(Session, ForumId, State)
    of
        true ->
            {ok, thread_scopes(Session, ForumId, ThreadIds, State)};
        false ->
            denied
    end;
scope(_Session, _Request, _State) ->
    denied.

-spec is_forum(integer(), map()) -> boolean().
is_forum(ChannelId, State) ->
    case
        maps:get(
            ChannelId,
            guild_data_index_channels:channel_index(maps:get(data, State)),
            undefined
        )
    of
        #{<<"type">> := Type} -> channel_types:is_thread_only(Type);
        _ -> false
    end.

-spec thread_scopes(map(), integer(), [term()], map()) -> #{integer() => thread_scope()}.
thread_scopes(Session, ForumId, ThreadIds, State) ->
    maps:from_list([
        {ThreadId, Scope}
     || ThreadId <- ThreadIds,
        is_integer(ThreadId),
        Scope <- [thread_scope(Session, ThreadId, ForumId, State)],
        Scope =/= foreign
    ]).

-spec thread_scope(map(), integer(), integer(), map()) -> thread_scope() | foreign.
thread_scope(Session, ThreadId, ForumId, State) ->
    case guild_thread_gate:thread(ThreadId, State) of
        undefined ->
            unstored;
        Thread ->
            case snowflake_id:parse_maybe(maps:get(<<"parent_id">>, Thread, undefined)) of
                ForumId ->
                    case guild_thread_gate:thread_view_access(Session, Thread, State, #{}) of
                        {true, _} ->
                            {stored,
                                snowflake_id:parse_maybe(
                                    maps:get(<<"last_message_id">>, Thread, undefined)
                                )};
                        {false, _} ->
                            foreign
                    end;
                _ ->
                    foreign
            end
    end.

-spec resolve(request_context(), [thread_request()], #{
    integer() => thread_scope()
}) ->
    [map()].
resolve(Context, Threads, Scopes) ->
    Local = [
        {ThreadId, local_entry(Ack, maps:get(ThreadId, Scopes))}
     || {ThreadId, Ack} <- Threads, is_map_key(ThreadId, Scopes)
    ],
    Remote = remote_entries(
        Context, [{ThreadId, Ack} || {ThreadId, {remote, Ack}} <- Local]
    ),
    lists:flatmap(
        fun
            ({ThreadId, {remote, _Ack}}) ->
                [Entry || {ok, Entry} <- [maps:find(ThreadId, Remote)]];
            ({ThreadId, Fields}) ->
                [Fields#{<<"thread_id">> => integer_to_binary(ThreadId)}]
        end,
        Local
    ).

-spec local_entry(integer() | undefined, thread_scope()) ->
    map() | {remote, integer() | undefined}.
%% 会话缓存没有年龄与消息历史授权信息，冷热请求统一交由API验证。
local_entry(Ack, _Scope) ->
    {remote, Ack}.

-spec remote_entries(request_context(), [thread_request()]) ->
    #{integer() => map()}.
remote_entries(_Context, []) ->
    #{};
remote_entries(#{guild_id := GuildId, channel_id := ChannelId, user_id := UserId}, Threads) ->
    Request = #{
        <<"type">> => <<"forum_unreads">>,
        <<"guild_id">> => integer_to_binary(GuildId),
        <<"channel_id">> => integer_to_binary(ChannelId),
        <<"user_id">> => integer_to_binary(UserId),
        <<"threads">> => [thread_rpc_entry(ThreadId, Ack) || {ThreadId, Ack} <- Threads]
    },
    maybe
        {ok, #{<<"threads">> := Entries}} ?= rpc_client:call(Request),
        true ?= is_list(Entries),
        Requested = maps:from_keys([ThreadId || {ThreadId, _Ack} <- Threads], true),
        maps:from_list([
            Result
         || Entry <- Entries, {true, Result} <- [rpc_entry(Entry, Requested)]
        ])
    else
        _ -> #{}
    end.

-spec thread_rpc_entry(integer(), integer() | undefined) -> map().
thread_rpc_entry(ThreadId, undefined) ->
    #{<<"thread_id">> => integer_to_binary(ThreadId)};
thread_rpc_entry(ThreadId, Ack) ->
    #{
        <<"thread_id">> => integer_to_binary(ThreadId),
        <<"ack_message_id">> => integer_to_binary(Ack)
    }.

-spec rpc_entry(term(), #{integer() => true}) -> {true, {integer(), map()}} | false.
rpc_entry(#{<<"thread_id">> := RawId} = Entry, Requested) ->
    Parsed =
        case snowflake_id:parse_maybe(RawId) of
            ThreadId when is_integer(ThreadId), is_map_key(ThreadId, Requested) ->
                {ThreadId, rpc_fields(Entry)};
            _ ->
                false
        end,
    case Parsed of
        {Id, #{} = Fields} -> {true, {Id, Fields#{<<"thread_id">> => integer_to_binary(Id)}}};
        _ -> false
    end;
rpc_entry(_Entry, _Requested) ->
    false.

-spec rpc_fields(map()) -> map() | undefined.
rpc_fields(#{<<"missing">> := true}) ->
    #{<<"missing">> => true};
rpc_fields(#{<<"count">> := Count}) when is_integer(Count), Count >= 0 ->
    #{<<"count">> => min(Count, ?MAX_COUNT)};
rpc_fields(_Entry) ->
    undefined.

-spec dispatch(pid(), request_context(), [map()]) -> ok.
dispatch(SessionPid, #{guild_id := GuildId, channel_id := ChannelId}, Entries) ->
    gateway_dispatch_relay:dispatch(SessionPid, forum_unreads, #{
        <<"guild_id">> => integer_to_binary(GuildId),
        <<"channel_id">> => integer_to_binary(ChannelId),
        <<"threads">> => Entries
    }).

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

thread_entry(Id) ->
    #{<<"thread_id">> => integer_to_binary(Id), <<"ack_message_id">> => <<"7">>}.

parse_threads_dedupes_and_caps_at_forty_test() ->
    Raw = [thread_entry(Id) || Id <- lists:seq(1, 60)],
    Parsed = parse_threads([thread_entry(1), #{<<"thread_id">> => <<"x">>}, 5 | Raw]),
    ?assertEqual(?MAX_THREADS, length(Parsed)),
    ?assertEqual({1, 7}, hd(Parsed)),
    ?assertEqual(lists:seq(1, 40), [Id || {Id, _} <- Parsed]),
    ?assertEqual([{9, undefined}], parse_threads([#{<<"thread_id">> => 9}])),
    ?assertEqual([], parse_threads(null)).

local_entries_require_api_authorization_for_warm_and_cold_posts_test() ->
    ?assertEqual({remote, undefined}, local_entry(undefined, {stored, 10})),
    ?assertEqual({remote, 10}, local_entry(10, {stored, 10})),
    ?assertEqual({remote, 10}, local_entry(10, {stored, undefined})),
    ?assertEqual({remote, 10}, local_entry(10, {stored, 11})),
    ?assertEqual({remote, undefined}, local_entry(undefined, unstored)).

rpc_entries_are_clamped_and_limited_to_requested_threads_test() ->
    Requested = #{1 => true},
    ?assertEqual(
        {true, {1, #{<<"thread_id">> => <<"1">>, <<"count">> => 25}}},
        rpc_entry(#{<<"thread_id">> => <<"1">>, <<"count">> => 90}, Requested)
    ),
    ?assertEqual(
        {true, {1, #{<<"thread_id">> => <<"1">>, <<"missing">> => true}}},
        rpc_entry(#{<<"thread_id">> => <<"1">>, <<"missing">> => true}, Requested)
    ),
    ?assertEqual(false, rpc_entry(#{<<"thread_id">> => <<"2">>, <<"count">> => 1}, Requested)),
    ?assertEqual(false, rpc_entry(#{<<"thread_id">> => <<"1">>, <<"count">> => -1}, Requested)).

non_viewer_sessions_get_the_unknown_opcode_close_test() ->
    ok = handle_request(#{}, self(), #{user_id => <<"5">>, thread_channels_capable => false}),
    receive
        forum_unreads_unknown_opcode -> ok
    after 100 -> ?assert(false)
    end.

with_forum_state(Fun) ->
    Tab = guild_thread_store:new(),
    try
        guild_thread_store:load(
            Tab,
            [
                #{
                    <<"id">> => 500,
                    <<"parent_id">> => 200,
                    <<"type">> => 11,
                    <<"last_message_id">> => 510
                },
                #{<<"id">> => 600, <<"parent_id">> => 300, <<"type">> => 11}
            ],
            []
        ),
        Fun(#{
            data => #{
                thread_gate => #{active => true, version => 1},
                thread_store => Tab,
                <<"channels">> => [
                    #{<<"id">> => 200, <<"type">> => 15},
                    #{<<"id">> => 300, <<"type">> => 0}
                ]
            }
        })
    after
        guild_thread_store:destroy(Tab)
    end.

viewer(ViewableChannels) ->
    #{user_id => 1, thread_viewer => true, viewable_channels => ViewableChannels}.

session_viewer_admits_capable_sessions_before_the_config_loads_test() ->
    Key = channel_threads_config,
    Previous = persistent_term:get(Key, undefined),
    PulledKey = {channel_threads_config, pulled},
    PreviousPulled = persistent_term:get(PulledKey, undefined),
    persistent_term:put(Key, #{enabled => false, config_version => 0}),
    persistent_term:put(PulledKey, false),
    try
        ?assert(session_viewer(7, #{thread_channels_capable => true})),
        ?assert(session_viewer(7, #{bot => true})),
        ?assertNot(session_viewer(7, #{})),
        ?assertNot(session_viewer(undefined, #{thread_channels_capable => true}))
    after
        case Previous of
            undefined -> persistent_term:erase(Key);
            _ -> persistent_term:put(Key, Previous)
        end,
        case PreviousPulled of
            undefined -> persistent_term:erase(PulledKey);
            _ -> persistent_term:put(PulledKey, PreviousPulled)
        end
    end.

scope_requires_a_viewer_session_on_a_visible_forum_test() ->
    with_forum_state(fun(State) ->
        Request = #{channel_id => 200, thread_ids => [500, 600, 700]},
        ?assertEqual(
            {ok, #{500 => {stored, 510}, 700 => unstored}},
            scope(viewer(#{200 => true}), Request, State)
        ),
        ?assertEqual(denied, scope(undefined, Request, State)),
        ?assertEqual(
            denied, scope((viewer(#{200 => true}))#{thread_viewer => false}, Request, State)
        ),
        ?assertEqual(
            denied,
            scope(viewer(#{300 => true}), Request#{channel_id => 300}, State)
        )
    end).

resolve_asks_the_api_for_all_explicitly_requested_visible_posts_test() ->
    Self = self(),
    ok = meck:new(rpc_client, [passthrough, no_link]),
    try
        ok = meck:expect(rpc_client, call, fun(Request) ->
            Self ! {rpc, Request},
            {ok, #{
                <<"threads">> => [
                    #{<<"thread_id">> => <<"500">>, <<"count">> => 3},
                    #{<<"thread_id">> => <<"501">>, <<"count">> => 0},
                    #{<<"thread_id">> => <<"502">>, <<"missing">> => true},
                    #{<<"thread_id">> => <<"700">>, <<"missing">> => true}
                ]
            }}
        end),
        Entries = resolve(
            #{guild_id => 1, channel_id => 200, user_id => 9},
            [{500, 505}, {501, 520}, {502, undefined}, {700, undefined}, {800, 1}],
            #{500 => {stored, 510}, 501 => {stored, 510}, 502 => {stored, 1}, 700 => unstored}
        ),
        ?assertEqual(
            [
                #{<<"thread_id">> => <<"500">>, <<"count">> => 3},
                #{<<"thread_id">> => <<"501">>, <<"count">> => 0},
                #{<<"thread_id">> => <<"502">>, <<"missing">> => true},
                #{<<"thread_id">> => <<"700">>, <<"missing">> => true}
            ],
            Entries
        ),
        receive
            {rpc, #{<<"type">> := <<"forum_unreads">>, <<"threads">> := Threads}} ->
                ?assertEqual(
                    [
                        #{<<"thread_id">> => <<"500">>, <<"ack_message_id">> => <<"505">>},
                        #{<<"thread_id">> => <<"501">>, <<"ack_message_id">> => <<"520">>},
                        #{<<"thread_id">> => <<"502">>},
                        #{<<"thread_id">> => <<"700">>}
                    ],
                    Threads
                )
        after 100 -> ?assert(false)
        end
    after
        meck:unload(rpc_client)
    end.

-endif.
