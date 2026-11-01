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

%% 分别加载完整集合，成员分页结束才发布完整性证明。
-spec fetch_guild_collection(guild_id(), binary()) ->
    {ok, term()} | {ok, term(), map()} | {error, term()}.
fetch_guild_collection(GuildId, <<"members">>) ->
    Result = case fluxer_gateway_env:get_optional(guild_member_load_concurrency) of
        N when N =:= 2; N =:= 4; N =:= 8 -> fetch_members_parallel(GuildId, N);
        _ -> fetch_members_stream(GuildId, undefined, [])
    end,
    %% 只有完整分页成功才发布角色计数可用证明，不能把部分缓存当作完整人数。
    case Result of
        {ok, Members} -> {ok, Members, #{members_complete => true, members_loaded_count => length(Members)}};
        Error -> Error
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

%% 从开放根区间开始，完成页之后才用有界端点探针拆分未提交的后缀。
-spec fetch_members_parallel(guild_id(), pos_integer()) -> {ok, [map()]} | {error, term()}.
fetch_members_parallel(GuildId, N) ->
    Page = fun({After, Through}) -> adaptive_member_page(GuildId, After, Through) end,
    Probe = fun({After, Through}) -> adaptive_member_bounds(GuildId, After, Through) end,
    Deadline = erlang:monotonic_time(millisecond) + ?GUILD_COLLECTION_FETCH_TIMEOUT_MS,
    case guild_member_range_loader:run(GuildId, min(N, 4), Page, Probe, Deadline) of
        {error, {member_page_failed, {error, legacy_member_page}}} ->
            %% 旧API不返回coverage时丢弃已收集分片，从开放根重新串行加载。
            %% 外层集合截止时间不变，旧响应从不被当作现代覆盖证明。
            fetch_members_stream(GuildId, undefined, []);
        Result -> Result
    end.

%% 保留十进制精确ID，不经浮点数转换。
-spec member_id(term()) -> {ok, pos_integer()} | error.
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

%% 同一页RPC失败可重试，覆盖验证失败必须使完整fetch失败。
-spec adaptive_member_page(guild_id(), integer() | undefined, integer() | undefined) -> term().
adaptive_member_page(GuildId, After, Through) ->
    Request = member_range_request(GuildId, <<"guild_member_range">>, After, Through),
    case rpc_client:call(Request) of
        {ok, Data} ->
            case validated_range_page(Data, bound_binary(After), bound_binary(Through)) of
                {ok, Members, Next} ->
                    Cursor = case Next of null -> null; _ -> binary_to_integer(Next) end,
                    {ok, Members, Cursor};
                Error -> Error
            end;
        {error, Reason} ->
            case rpc_client:is_retryable(Reason) of
                true -> {error, {retryable, Reason}};
                false -> {error, Reason}
            end;
        _ -> {error, invalid_members_range_response}
    end.

%% 探针只读取原区间内的索引首尾，错误由协调器显式回退同一区间分页。
-spec adaptive_member_bounds(guild_id(), integer() | undefined, integer() | undefined) -> term().
adaptive_member_bounds(GuildId, After, Through) ->
    Request = member_range_request(GuildId, <<"guild_member_bounds">>, After, Through),
    case rpc_client:call(Request) of
        {ok, #{<<"min_user_id">> := Min, <<"max_user_id">> := Max}} ->
            case {member_id(Min), member_id(Max)} of
                {{ok, A}, {ok, B}} -> {ok, A, B};
                _ -> {error, empty_or_invalid_member_bounds}
            end;
        Error -> Error
    end.

%% 页与探针共享完全相同的排他下界和包含上界，开放根端点保持不传。
-spec member_range_request(guild_id(), binary(), integer() | undefined, integer() | undefined) -> map().
member_range_request(GuildId, Type, After, Through) ->
    Request0 = maybe_put_after(bound_binary(After), #{
        <<"type">> => Type,
        <<"guild_id">> => type_conv:to_binary(GuildId),
        <<"limit">> => 1000
    }),
    Request =
        case Through of
            undefined -> Request0;
            _ -> Request0#{<<"through_user_id">> => integer_to_binary(Through)}
        end,
    case Type of <<"guild_member_bounds">> -> maps:remove(<<"limit">>, Request); _ -> Request end.

%% 仅RPC线格式使用十进制binary，协调器保持任意精度整数。
-spec bound_binary(integer() | undefined) -> binary() | undefined.
bound_binary(undefined) -> undefined;
bound_binary(Value) -> integer_to_binary(Value).

%% 验证原数据库页覆盖证明，允许未知用户映射被过滤但禁止cursor跳过未覆盖区间。
-spec validated_range_page(term(), binary() | undefined, binary() | undefined) ->
    {ok, [map()], binary() | null} | {error, term()}.
validated_range_page(
    #{
        <<"members">> := Members,
        <<"has_more">> := More,
        <<"next_after_user_id">> := Next,
        <<"page_first_user_id">> := First0,
        <<"page_last_user_id">> := Last0,
        <<"page_row_count">> := Count
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
        true = is_integer(Count) andalso Count >= 0 andalso Count =< 1000,
        true = length(Members) =< Count,
        Coverage = case Count of
            0 -> true = First0 =:= null andalso Last0 =:= null, {Lower, Lower};
            _ ->
                {ok, First} = member_id(First0), {ok, Last} = member_id(Last0),
                true = First > Lower andalso Last >= First,
                true = Last - First + 1 >= Count,
                true = Upper =:= infinity orelse Last =< Upper,
                {First, Last}
        end,
        {CoverageFirst, CoverageLast} = Coverage,
        _ = lists:foldl(
            fun(#{<<"user">> := #{<<"id">> := Id}}, Prev) ->
                {ok, I} = member_id(Id),
                true = I > Prev,
                true = I >= CoverageFirst andalso I =< CoverageLast,
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
                true = Count > 0 andalso C =:= CoverageLast andalso C > Lower,
                {ok, Members, Cursor}
        end
    catch
        _:_ -> {error, invalid_members_range_page}
    end;
validated_range_page(#{<<"members">> := Members, <<"has_more">> := More,
    <<"next_after_user_id">> := _Next} = Data, _After, _Through)
    when is_list(Members), is_boolean(More) ->
    case not maps:is_key(<<"page_first_user_id">>, Data) andalso
        not maps:is_key(<<"page_last_user_id">>, Data) andalso
        not maps:is_key(<<"page_row_count">>, Data) of
        true -> {error, legacy_member_page};
        false -> {error, invalid_members_range_page}
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
