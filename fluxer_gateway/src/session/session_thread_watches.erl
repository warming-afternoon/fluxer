%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(session_thread_watches).
-typing([eqwalizer]).

-export([update/3, acknowledge/2]).

-define(LIMIT, 10).
-define(LEASE_MS, 600000).

%% 在会话进程串行校验跨服务器总额度，旧连接不得续租
-spec update(map(), pid(), map()) -> {noreply, map()}.
update(Data, SocketPid, #{socket_pid := SocketPid} = State) ->
    Nonce = maps:get(<<"thread_watch_nonce">>, Data, undefined),
    Capable =
        maps:get(thread_channels_capable, State, false) orelse maps:get(bot, State, false),
    case {Capable, is_binary(Nonce), parse(Data, maps:get(guilds, State, #{}))} of
        {true, true, {ok, Updates}} when byte_size(Nonce) =< 128 ->
            apply_update(Updates, Nonce, State);
        _ ->
            session_dispatch:handle_dispatch(
                thread_watch_ack,
                #{
                    <<"nonce">> => Nonce,
                    <<"ok">> => false,
                    <<"code">> => <<"INVALID_THREAD_WATCH_REQUEST">>
                },
                State
            )
    end;
update(_Data, _SocketPid, State) ->
    {noreply, State}.

%% 解析有界帖子集合，重复标识只计一次
-spec parse(map(), map()) -> {ok, map()} | error.
parse(Data, Guilds) ->
    try
        Subscriptions = maps:get(<<"subscriptions">>, Data),
        true = is_map(Subscriptions),
        Updates = maps:fold(
            fun(GuildBin, Options, Acc) ->
                case maps:find(<<"thread_watches">>, Options) of
                    error ->
                        Acc;
                    {ok, RawIds} ->
                        true = is_list(RawIds) andalso length(RawIds) =< 100,
                        GuildId = snowflake_id:parse(GuildBin),
                        {Pid, _Ref} = maps:get(GuildId, Guilds),
                        true = is_pid(Pid),
                        Ids = lists:usort([snowflake_id:parse(Id) || Id <- RawIds]),
                        Acc#{GuildId => Ids}
                end
            end,
            #{},
            Subscriptions
        ),
        {ok, Updates}
    catch
        _:_ -> error
    end.

%% 以更新后的最终集合计数，超限拒绝整个浏览更新且不续租
-spec apply_update(map(), binary(), map()) -> {noreply, map()}.
apply_update(Updates, Nonce, State) ->
    Now = erlang:system_time(millisecond),
    Leases = maps:filter(
        fun(G, Lease) ->
            maps:get(expires, Lease) > Now andalso
                maps:is_key(G, maps:get(guilds, State, #{}))
        end,
        maps:get(thread_watch_leases, State, #{})
    ),
    Generation = maps:get(thread_watch_generation, State, 0) + 1,
    Expires = Now + ?LEASE_MS,
    Next = maps:fold(
        fun(G, Ids, Acc) ->
            case Ids of
                [] -> maps:remove(G, Acc);
                _ -> Acc#{G => #{ids => Ids, expires => Expires, generation => Generation}}
            end
        end,
        Leases,
        Updates
    ),
    Count = lists:sum([length(maps:get(ids, Lease)) || Lease <- maps:values(Next)]),
    case Count > ?LIMIT of
        true ->
            guild_thread_watch_metrics:record(limit_rejected, 1),
            session_dispatch:handle_dispatch(
                thread_watch_ack,
                #{
                    <<"nonce">> => Nonce,
                    <<"ok">> => false,
                    <<"code">> => <<"THREAD_WATCH_LIMIT_EXCEEDED">>,
                    <<"limit">> => ?LIMIT,
                    <<"requested_count">> => Count
                },
                State
            );
        false ->
            Guilds = maps:get(guilds, State),
            maps:foreach(
                fun(G, Ids) ->
                    {GuildPid, _} = maps:get(G, Guilds),
                    gen_server:cast(
                        GuildPid,
                        {thread_watch_update, #{
                            session_id => maps:get(id, State),
                            session_pid => self(),
                            user_id => maps:get(user_id, State),
                            ids => Ids,
                            expires => Expires,
                            generation => Generation,
                            nonce => Nonce
                        }}
                    )
                end,
                Updates
            ),
            {noreply, State#{
                thread_watch_leases => Next, thread_watch_generation => Generation
            }}
    end.

%% 仅接纳当前请求的确认，验证失败的帖子释放预留额度
-spec acknowledge(map(), map()) -> {noreply, map()}.
acknowledge(#{generation := Generation, <<"guild_id">> := GuildBin} = Data, State) ->
    GuildId = snowflake_id:parse(GuildBin),
    Leases = maps:get(thread_watch_leases, State, #{}),
    case maps:get(GuildId, Leases, undefined) of
        #{generation := Other} when Other =/= Generation ->
            {noreply, State};
        Lease ->
            Ids = snowflake_id:parse_list(maps:get(<<"thread_ids">>, Data, [])),
            Next =
                case {Lease, Ids} of
                    {L, [_ | _]} when is_map(L) -> Leases#{GuildId => L#{ids => Ids}};
                    _ -> maps:remove(GuildId, Leases)
                end,
            session_dispatch:handle_dispatch(
                thread_watch_ack,
                maps:remove(generation, Data),
                State#{thread_watch_leases => Next}
            )
    end.
