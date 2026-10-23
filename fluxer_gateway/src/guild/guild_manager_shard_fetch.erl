%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_manager_shard_fetch).
-typing([eqwalizer]).

-export([fetch_guild_data/1]).

-export_type([guild_id/0, fetch_result/0]).

-type guild_id() :: integer().
-type fetch_result() :: {ok, map()} | {error, term()}.

-define(GUILD_COLLECTION_FETCH_TIMEOUT_MS, 120000).
-define(GUILD_MEMBER_COLLECTION_LIMIT, 1000).
-define(GUILD_COLLECTIONS, [
    <<"guild">>,
    <<"roles">>,
    <<"channels">>,
    <<"emojis">>,
    <<"stickers">>,
    <<"members">>,
    <<"voice_states">>
]).

-spec fetch_guild_data(guild_id()) -> fetch_result().
fetch_guild_data(GuildId) ->
    Parent = self(),
    Ref = make_ref(),
    _ = [
        spawn_monitor(fun() ->
            erlang:process_flag(fullsweep_after, 0),
            Parent ! {Ref, Collection, fetch_guild_collection(GuildId, Collection)}
        end)
     || Collection <- ?GUILD_COLLECTIONS
    ],
    DeadlineMs = erlang:monotonic_time(millisecond) + ?GUILD_COLLECTION_FETCH_TIMEOUT_MS,
    collect_results(Ref, ?GUILD_COLLECTIONS, #{}, DeadlineMs).

-spec collect_results(reference(), [binary()], map(), integer()) -> fetch_result().
collect_results(_Ref, [], Acc, _DeadlineMs) ->
    {ok, Acc};
collect_results(Ref, PendingCollections, Acc, DeadlineMs) ->
    RemainingMs = DeadlineMs - erlang:monotonic_time(millisecond),
    case RemainingMs > 0 of
        false ->
            {error, {guild_collection_fetch_timeout, PendingCollections}};
        true ->
            await_collection(Ref, PendingCollections, Acc, DeadlineMs, RemainingMs)
    end.

-spec await_collection(reference(), [binary()], map(), integer(), integer()) ->
    fetch_result().
await_collection(Ref, PendingCollections, Acc, DeadlineMs, RemainingMs) ->
    receive
        {Ref, Collection, {ok, Data}} ->
            NewPending = lists:delete(Collection, PendingCollections),
            collect_results(Ref, NewPending, Acc#{Collection => Data}, DeadlineMs);
        {Ref, Collection, {ok, Data, Extras}} when is_map(Extras) ->
            NewPending = lists:delete(Collection, PendingCollections),
            collect_results(
                Ref, NewPending, maps:merge(Acc#{Collection => Data}, Extras), DeadlineMs
            );
        {Ref, Collection, {error, Reason}} ->
            {error, {guild_collection_fetch_failed, Collection, Reason}};
        {'DOWN', _, process, _, _} ->
            collect_results(Ref, PendingCollections, Acc, DeadlineMs)
    after RemainingMs ->
        {error, {guild_collection_fetch_timeout, PendingCollections}}
    end.

-spec fetch_guild_collection(guild_id(), binary()) ->
    {ok, term()} | {ok, term(), map()} | {error, term()}.
fetch_guild_collection(GuildId, <<"members">>) ->
    case fluxer_gateway_env:get_optional(guild_member_load_concurrency) of
        N when N =:= 2; N =:= 4; N =:= 8 -> fetch_members_parallel(GuildId, N);
        _ -> fetch_members_stream(GuildId, undefined, [])
    end;
fetch_guild_collection(GuildId, <<"channels">>) ->
    RpcRequest = #{
        <<"type">> => <<"guild_collection">>,
        <<"guild_id">> => type_conv:to_binary(GuildId),
        <<"collection">> => <<"channels">>
    },
    parse_channels_response(rpc_client:call(RpcRequest));
fetch_guild_collection(GuildId, Collection) ->
    RpcRequest = #{
        <<"type">> => <<"guild_collection">>,
        <<"guild_id">> => type_conv:to_binary(GuildId),
        <<"collection">> => Collection
    },
    parse_collection_response(Collection, rpc_client:call(RpcRequest)).

-spec parse_collection_response(binary(), term()) -> {ok, term()} | {error, term()}.
parse_collection_response(Collection, {ok, Data}) when is_map(Data) ->
    case maps:get(Collection, Data, undefined) of
        undefined -> {error, {invalid_collection_response, Collection}};
        Value -> {ok, Value}
    end;
parse_collection_response(_Collection, {error, Reason}) ->
    {error, Reason}.

-spec parse_channels_response(term()) ->
    {ok, term()} | {ok, [map()], map()} | {error, term()}.
parse_channels_response({ok, #{<<"channels">> := Channels} = Data}) when
    is_list(Channels)
->
    case maps:is_key(<<"thread_gate">>, Data) orelse maps:is_key(<<"thread_tainted">>, Data) of
        true ->
            {Merged, Extras} = guild_thread_load:channels_collection(Data),
            {ok, Merged, Extras};
        false ->
            {ok, Channels}
    end;
parse_channels_response(Result) ->
    parse_collection_response(<<"channels">>, Result).

-spec fetch_members_stream(guild_id(), binary() | undefined, [[map()]]) ->
    {ok, [map()]} | {error, term()}.
fetch_members_stream(GuildId, AfterUserId, ChunksAcc) ->
    RpcRequest0 = #{
        <<"type">> => <<"guild_collection">>,
        <<"guild_id">> => type_conv:to_binary(GuildId),
        <<"collection">> => <<"members">>,
        <<"limit">> => ?GUILD_MEMBER_COLLECTION_LIMIT
    },
    RpcRequest = maybe_put_after(AfterUserId, RpcRequest0),
    case rpc_client:call(RpcRequest) of
        {ok, Data} -> parse_members_page(GuildId, Data, ChunksAcc);
        {error, Reason} -> {error, Reason}
    end.

-spec parse_members_page(guild_id(), map(), [[map()]]) -> {ok, [map()]} | {error, term()}.
parse_members_page(GuildId, Data, ChunksAcc) ->
    Members = maps:get(<<"members">>, Data, undefined),
    HasMore = maps:get(<<"has_more">>, Data, false),
    NextAfter = maps:get(<<"next_after_user_id">>, Data, null),
    case Members of
        MemberList when is_list(MemberList) ->
            parse_members_result(GuildId, MemberList, HasMore, NextAfter, ChunksAcc);
        _ ->
            {error, invalid_members_collection_payload}
    end.

-spec parse_members_result(guild_id(), [map()], term(), term(), [[map()]]) ->
    {ok, [map()]} | {error, term()}.
parse_members_result(GuildId, MemberList, true, NextAfter, ChunksAcc) when
    is_binary(NextAfter), MemberList =/= []
->
    fetch_members_stream(GuildId, NextAfter, [MemberList | ChunksAcc]);
parse_members_result(_GuildId, [], true, _NextAfter, _ChunksAcc) ->
    {error, invalid_members_collection_empty_page};
parse_members_result(_GuildId, _MemberList, true, _NextAfter, _ChunksAcc) ->
    {error, invalid_members_collection_cursor};
parse_members_result(_GuildId, MemberList, false, _NextAfter, ChunksAcc) ->
    {ok, lists:append(lists:reverse([MemberList | ChunksAcc]))};
parse_members_result(_GuildId, _MemberList, _HasMore, _NextAfter, _ChunksAcc) ->
    {error, invalid_members_collection_has_more}.

-spec maybe_put_after(binary() | undefined, map()) -> map().
maybe_put_after(undefined, RpcRequest) ->
    RpcRequest;
maybe_put_after(AfterUserId, RpcRequest) when is_binary(AfterUserId) ->
    RpcRequest#{<<"after_user_id">> => AfterUserId}.

%% The outer ranges remain open: bounds are scheduling hints, not a snapshot.
fetch_members_parallel(GuildId, N) ->
    case
        rpc_client:call(#{
            <<"type">> => <<"guild_member_bounds">>,
            <<"guild_id">> => type_conv:to_binary(GuildId)
        })
    of
        {ok, #{<<"min_user_id">> := Min, <<"max_user_id">> := Max}} ->
            case member_ranges(Min, Max, N) of
                {ok, Ranges} ->
                    Fetch = fun({Index, {After, Through}}) ->
                        fetch_member_range(GuildId, Index, After, Through, [], N)
                    end,
                    case guild_thread_member_loader:run(lists:enumerate(Ranges), N, Fetch) of
                        {ok, Chunks} -> {ok, lists:append(Chunks)};
                        Error -> Error
                    end;
                Error ->
                    Error
            end;
        {error, Reason} ->
            {error, Reason};
        _ ->
            {error, invalid_member_bounds}
    end.

member_ranges(null, null, _N) ->
    {ok, [{undefined, undefined}]};
member_ranges(Min0, Max0, N) ->
    case {member_id(Min0), member_id(Max0)} of
        {{ok, Min}, {ok, Max}} when Min =< Max ->
            Bounds = lists:usort([
                B
             || I <- lists:seq(1, N - 1),
                B <- [Min + ((Max - Min + 1) * I div N) - 1],
                B >= Min,
                B < Max
            ]),
            Bins = [integer_to_binary(B) || B <- Bounds],
            {ok, lists:zip([undefined | Bins], Bins ++ [undefined])};
        _ ->
            {error, invalid_member_bounds}
    end.

member_id(B) when is_binary(B) ->
    try binary_to_integer(B) of
        I when I > 0 ->
            case integer_to_binary(I) =:= B of
                true -> {ok, I};
                false -> error
            end;
        _ ->
            error
    catch
        _:_ -> error
    end;
member_id(_) ->
    error.

fetch_member_range(GuildId, Index, After, Through, Acc, N) ->
    Request0 = maybe_put_after(After, #{
        <<"type">> => <<"guild_member_range">>,
        <<"guild_id">> => type_conv:to_binary(GuildId),
        <<"limit">> => 1000
    }),
    Request =
        case Through of
            undefined -> Request0;
            _ -> Request0#{<<"through_user_id">> => Through}
        end,
    case rpc_client:call(Request) of
        {ok, Data} ->
            case validated_range_page(Data, After, Through) of
                {ok, Members, Next} ->
                    case Next of
                        null ->
                            {ok, lists:append(lists:reverse([Members | Acc]))};
                        _ ->
                            fetch_member_range(
                                GuildId, Index, Next, Through, [Members | Acc], N
                            )
                    end;
                Error ->
                    Error
            end;
        {error, Reason} ->
            {error, Reason};
        _ ->
            {error, invalid_members_range_response}
    end.

validated_range_page(
    #{
        <<"members">> := Members,
        <<"has_more">> := More,
        <<"next_after_user_id">> := Next
    },
    After,
    Through
) when is_list(Members) ->
    try
        Lower =
            case After of
                undefined ->
                    0;
                _ ->
                    {ok, L} = member_id(After),
                    L
            end,
        Upper =
            case Through of
                undefined ->
                    infinity;
                _ ->
                    {ok, U} = member_id(Through),
                    U
            end,
        Last = lists:foldl(
            fun(#{<<"user">> := #{<<"id">> := Id}}, Prev) ->
                {ok, I} = member_id(Id),
                true = I > Prev,
                true = (Upper =:= infinity orelse I =< Upper),
                I
            end,
            Lower,
            Members
        ),
        case {More, Next} of
            {false, null} ->
                {ok, Members, null};
            {true, Cursor} ->
                {ok, C} = member_id(Cursor),
                true = C > Lower,
                true = C >= Last,
                true = (Upper =:= infinity orelse C =< Upper),
                {ok, Members, Cursor}
        end
    catch
        _:_ -> {error, invalid_members_range_page}
    end;
validated_range_page(_, _, _) ->
    {error, invalid_members_range_page}.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

parse_members_result_final_page_test() ->
    Members = [
        #{<<"user">> => #{<<"id">> => <<"1">>}}
    ],
    ?assertEqual(
        {ok, Members},
        parse_members_result(42, Members, false, null, [])
    ).

parse_members_result_invalid_cursor_test() ->
    Members = [
        #{<<"user">> => #{<<"id">> => <<"1">>}}
    ],
    ?assertEqual(
        {error, invalid_members_collection_cursor},
        parse_members_result(42, Members, true, null, [])
    ).

parse_channels_response_control_is_unchanged_test() ->
    Channels = [#{<<"id">> => <<"1">>}],
    ?assertEqual(
        {ok, Channels}, parse_channels_response({ok, #{<<"channels">> => Channels}})
    ),
    ?assertEqual(
        {error, {invalid_collection_response, <<"channels">>}},
        parse_channels_response({ok, #{}})
    ).

parse_channels_response_carries_the_thread_gate_test() ->
    Response = #{
        <<"channels">> => [],
        <<"thread_gate">> => #{<<"active">> => false, <<"config_version">> => 2},
        <<"thread_tainted">> => true
    },
    ?assertEqual(
        {ok, [], #{thread_gate => #{active => false, version => 2}, thread_tainted => true}},
        parse_channels_response({ok, Response})
    ).

-endif.
