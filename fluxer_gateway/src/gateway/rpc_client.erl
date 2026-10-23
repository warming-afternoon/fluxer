%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(rpc_client).
-behaviour(gen_server).
-export([start_link/0, init/1, handle_call/3, handle_cast/2, handle_info/2]).
-typing([eqwalizer]).

-export([
    call/1, call/2,
    call_with_retry/2,
    handle_http_response/2,
    rpc_headers/1,
    rpc_url/0,
    rpc_url_meta/0,
    is_retryable/1,
    backoff_delay/2
]).

-export_type([rpc_request/0, rpc_response/0, retry_config/0]).

-define(DEFAULT_RPC_PATH, <<"/internal/rpc">>).
-define(RPC_AUTH_HEADER, <<"x-fluxer-rpc-auth">>).
-define(URL_META_TERM_KEY, {?MODULE, rpc_url_meta}).

-type rpc_request() :: map().
-type rpc_response() :: {ok, map()} | {error, term()}.
-type retry_config() :: {
    MaxAttempts :: pos_integer(),
    BaseMs :: pos_integer(),
    MaxMs :: pos_integer(),
    JitterMs :: non_neg_integer()
}.
-type request_trace() :: #{
    request_id := integer(),
    is_voice := boolean(),
    type := binary() | undefined,
    guild_id := binary() | undefined,
    channel_id := binary() | undefined,
    user_id := binary() | undefined,
    connection_id := binary() | undefined,
    token_nonce := binary() | undefined,
    rtc_region := binary() | undefined
}.

-spec call(rpc_request()) -> rpc_response().
call(Request) ->
    call(Request, request_timeout_ms()).

-spec call(rpc_request(), pos_integer()) -> rpc_response().
call(Request0, Timeout) ->
    Request = ensure_routing_id(Request0),
    Trace = build_request_trace(Request),
    maybe_log_voice_request_start(Trace),
    Result = do_request(Request, Timeout),
    maybe_log_voice_request_response(Trace, Result),
    Result.

-spec call_with_retry(rpc_request(), retry_config()) -> rpc_response().
call_with_retry(Request, {MaxAttempts, _BaseMs, _MaxMs, _JitterMs} = RetryConfig) ->
    Limit =
        case readonly_type(request_type(Request)) of
            true -> min(MaxAttempts, 3);
            false -> 1
        end,
    do_request_with_retry(
        ensure_routing_id(Request#{'$rpc_deadline' => erlang:monotonic_time(millisecond) + 5000}),
        RetryConfig,
        1,
        Limit
    ).

-spec do_request_with_retry(
    rpc_request(), retry_config(), pos_integer(), pos_integer()
) -> rpc_response().
do_request_with_retry(Request, RetryConfig, Attempt, MaxAttempts) ->
    case
        maps:get('$rpc_deadline', Request, erlang:monotonic_time(millisecond) + 5000) =<
            erlang:monotonic_time(millisecond)
    of
        true ->
            {error, timeout};
        false ->
            case call(Request) of
                {ok, _Data} = Success ->
                    Success;
                {error, Reason} = Error ->
                    handle_retry(Error, Reason, Request, RetryConfig, Attempt, MaxAttempts)
            end
    end.

-spec handle_retry(
    rpc_response(),
    term(),
    rpc_request(),
    retry_config(),
    pos_integer(),
    pos_integer()
) -> rpc_response().
handle_retry(Error, Reason, Request, RetryConfig, Attempt, MaxAttempts) ->
    case
        {
            readonly_type(request_type(Request)) andalso is_retryable(Reason),
            Attempt >= MaxAttempts
        }
    of
        {false, _} ->
            Error;
        {true, true} ->
            log_retries_exhausted(MaxAttempts, Reason, Request),
            {error, {retries_exhausted, Reason}};
        {true, false} ->
            Delay = max(
                1,
                min(
                    backoff_delay(Attempt, RetryConfig),
                    maps:get(
                        '$rpc_deadline', Request, erlang:monotonic_time(millisecond) + 5000
                    ) - erlang:monotonic_time(millisecond)
                )
            ),
            log_retry_attempt(Attempt, MaxAttempts, Delay, Reason, Request),
            ok = gateway_retry_timer:wait(Delay),
            do_request_with_retry(
                ensure_routing_id(
                    maps:without(['$rpc_route_url', '$rpc_route_unavailable'], Request)
                ),
                RetryConfig,
                Attempt + 1,
                MaxAttempts
            )
    end.

-spec log_retries_exhausted(pos_integer(), term(), rpc_request()) -> ok.
log_retries_exhausted(MaxAttempts, Reason, Request) ->
    ReqType = request_type(Request),
    logger:error(
        "API RPC retries exhausted:"
        " attempts=~p reason=~p request_type=~ts",
        [MaxAttempts, Reason, ReqType]
    ),
    ok.

-spec log_retry_attempt(
    pos_integer(), pos_integer(), pos_integer(), term(), rpc_request()
) -> ok.
log_retry_attempt(Attempt, MaxAttempts, Delay, Reason, Request) ->
    ReqType = request_type(Request),
    logger:warning(
        "API RPC retrying:"
        " attempt=~p/~p delay_ms=~p reason=~p request_type=~ts",
        [Attempt, MaxAttempts, Delay, Reason, ReqType]
    ),
    ok.

-spec request_type(rpc_request()) -> binary().
request_type(Request) ->
    maps:get(<<"type">>, Request, <<"unknown">>).

-spec is_retryable(term()) -> boolean().
is_retryable(timeout) -> true;
is_retryable(no_responders) -> true;
is_retryable({rpc_error, Status, _}) when is_integer(Status), Status >= 500 -> true;
is_retryable(_) -> false.

-spec backoff_delay(pos_integer(), retry_config()) -> pos_integer().
backoff_delay(Attempt, {_MaxAttempts, BaseMs, MaxMs, JitterMs}) ->
    ExponentialDelay = BaseMs * (1 bsl (Attempt - 1)),
    CappedDelay =
        case ExponentialDelay > MaxMs of
            true -> MaxMs;
            false -> ExponentialDelay
        end,
    Jitter =
        case JitterMs > 0 of
            true -> rand:uniform(JitterMs);
            false -> 0
        end,
    trunc(CappedDelay + Jitter).

-spec do_request(rpc_request(), pos_integer()) -> rpc_response().
do_request(#{'$rpc_route_unavailable' := true}, _Timeout) ->
    {error, no_responders};
do_request(Request, Timeout0) ->
    Timeout = max(
        1,
        min(
            Timeout0,
            maps:get('$rpc_deadline', Request, erlang:monotonic_time(millisecond) + Timeout0) -
                erlang:monotonic_time(millisecond)
        )
    ),
    {Url, HostKey, IsHttps} = request_url_meta(Request),
    Payload = iolist_to_binary(
        json:encode(
            maps:without(
                ['$rpc_route_id', '$rpc_route_url', '$rpc_deadline', '$rpc_route_unavailable'],
                Request
            )
        )
    ),
    Headers = rpc_headers(Request),
    RequestOpts = #{
        connect_timeout => min(Timeout, 5000),
        recv_timeout => Timeout,
        content_type => <<"application/json">>,
        host_key => HostKey,
        is_https => IsHttps
    },
    case gateway_http_client:request(rpc, post, Url, Headers, Payload, RequestOpts) of
        {ok, StatusCode, _ResponseHeaders, ResponseBody} ->
            handle_http_response(StatusCode, ResponseBody);
        {error, timeout} ->
            {error, timeout};
        {error, overloaded} ->
            {error, no_responders};
        {error, circuit_open} ->
            {error, no_responders};
        {error, Reason} ->
            {error, Reason}
    end.

-spec request_timeout_ms() -> pos_integer().
request_timeout_ms() ->
    case gateway_rollout_config:rpc_request_timeout_ms() of
        Timeout when is_integer(Timeout), Timeout > 0 ->
            Timeout;
        _ ->
            5000
    end.

-spec rpc_url() -> binary().
rpc_url() ->
    case normalize_optional_binary(fluxer_gateway_env:get(api_rpc_endpoint)) of
        undefined ->
            BaseUrl = trim_trailing_slash(
                ensure_binary(fluxer_gateway_env:get(api_internal_url))
            ),
            <<BaseUrl/binary, ?DEFAULT_RPC_PATH/binary>>;
        ConfiguredEndpoint ->
            trim_trailing_slash(ConfiguredEndpoint)
    end.

-spec rpc_url_meta() -> {binary(), binary(), boolean()}.
rpc_url_meta() ->
    Url = rpc_url(),
    case persistent_term:get(?URL_META_TERM_KEY, undefined) of
        {Url, _HostKey, _IsHttps} = Meta -> Meta;
        _ -> store_rpc_url_meta(Url)
    end.

-spec store_rpc_url_meta(binary()) -> {binary(), binary(), boolean()}.
store_rpc_url_meta(Url) ->
    {HostKey, IsHttps} = gateway_http_client_request:url_metadata(Url),
    Meta = {Url, HostKey, IsHttps},
    persistent_term:put(?URL_META_TERM_KEY, Meta),
    Meta.

-spec trim_trailing_slash(binary()) -> binary().
trim_trailing_slash(<<>>) ->
    <<>>;
trim_trailing_slash(Url) ->
    case binary:last(Url) of
        $/ ->
            trim_trailing_slash(binary:part(Url, 0, byte_size(Url) - 1));
        _ ->
            Url
    end.

-spec rpc_headers(rpc_request()) -> [{binary(), binary()}].
rpc_headers(Request0) ->
    Request = ensure_routing_id(Request0),
    ClientIpHeader = normalize_client_ip_header(fluxer_gateway_env:get(client_ip_header)),
    AuthToken = ensure_binary(fluxer_gateway_env:get(rpc_auth_token)),
    [
        {<<"content-type">>, <<"application/json">>},
        {ClientIpHeader, rpc_client_ip_header_value(Request)},
        {?RPC_AUTH_HEADER, AuthToken},
        {<<"x-fluxer-rpc-type">>, ensure_binary(maps:get(<<"type">>, Request, <<"unknown">>))},
        {<<"x-fluxer-rpc-request-id">>, maps:get('$rpc_route_id', Request)}
    ].

%% 每个逻辑调用只生成一次不含用户信息的标识。
-spec ensure_routing_id(rpc_request()) -> rpc_request().
ensure_routing_id(Request) ->
    case maps:find('$rpc_route_id', Request) of
        {ok, Id} when is_binary(Id), byte_size(Id) =:= 32 ->
            pin_route(Request);
        _ ->
            Random = crypto:strong_rand_bytes(16),
            Id = binary:encode_hex(Random, lowercase),
            pin_route(Request#{'$rpc_route_id' => Id})
    end.

%% 新请求只选择健康实例；已发出的写请求不自动重放。
pin_route(#{'$rpc_route_url' := _} = Request) ->
    Request;
pin_route(Request) ->
    case fluxer_gateway_env:get_optional(internal_api_rpc_urls) of
        [_ | _] = Urls ->
            case healthy_urls(Urls) of
                [] ->
                    Request#{'$rpc_route_unavailable' => true};
                Healthy ->
                    Pick =
                        case readonly_type(request_type(Request)) of
                            true ->
                                lists:nth(
                                    1 +
                                        (fnv1a(maps:get('$rpc_route_id', Request)) rem
                                            length(Healthy)),
                                    Healthy
                                );
                            false ->
                                hd(Healthy)
                        end,
                    Request#{'$rpc_route_url' => Pick}
            end;
        _ ->
            Request
    end.
readonly_type(Type) ->
    lists:member(Type, [
        <<"get_read_state">>,
        <<"get_user_guild_settings">>,
        <<"get_user_blocked_ids">>,
        <<"get_push_subscriptions">>,
        <<"get_badge_counts">>,
        <<"list_thread_members">>,
        <<"thread_watch_contexts">>,
        <<"forum_unreads">>,
        <<"guild_member_bounds">>,
        <<"guild_member_range">>
    ]).
%% FNV-1a 32 位，与 Rust 共享固定测试向量。
fnv1a(Bin) ->
    lists:foldl(
        fun(C, H) -> ((H bxor C) * 16777619) band 16#ffffffff end,
        2166136261,
        binary_to_list(Bin)
    ).
request_url_meta(#{'$rpc_route_url' := Url}) ->
    Key = {?MODULE, rpc_url_meta, Url},
    case persistent_term:get(Key, undefined) of
        undefined ->
            {HostKey, IsHttps} = gateway_http_client_request:url_metadata(Url),
            Meta = {Url, HostKey, IsHttps},
            persistent_term:put(Key, Meta),
            Meta;
        Meta ->
            Meta
    end;
request_url_meta(_) ->
    rpc_url_meta().

-spec rpc_client_ip_header_value(rpc_request()) -> binary().
rpc_client_ip_header_value(Request) ->
    case normalize_optional_binary(maps:get(<<"ip">>, Request, undefined)) of
        undefined -> <<"127.0.0.1">>;
        <<>> -> <<"127.0.0.1">>;
        IP -> IP
    end.

-spec normalize_client_ip_header(term()) -> binary().
normalize_client_ip_header(Value) when is_binary(Value), byte_size(Value) > 0 ->
    Value;
normalize_client_ip_header(Value) when is_list(Value), Value =/= [] ->
    unicode_binary_or_default(Value, <<"x-forwarded-for">>);
normalize_client_ip_header(_) ->
    <<"x-forwarded-for">>.

-spec handle_http_response(non_neg_integer(), iodata()) -> rpc_response().
handle_http_response(StatusCode, ResponseBody) when StatusCode >= 200, StatusCode < 300 ->
    try
        Response = ensure_response_map(json:decode(iolist_to_binary(ResponseBody))),
        Data = maps:get(<<"data">>, Response, #{}),
        {ok, Data}
    catch
        _:_ ->
            {error, {rpc_error, StatusCode, <<"Invalid JSON response">>}}
    end;
handle_http_response(StatusCode, ResponseBody) ->
    Message = decode_error_message(ResponseBody),
    {error, {rpc_error, StatusCode, Message}}.

-spec decode_error_message(iodata()) -> binary().
decode_error_message(ResponseBody) ->
    Body = iolist_to_binary(ResponseBody),
    try
        Decoded = ensure_response_map(json:decode(Body)),
        case maps:get(<<"message">>, Decoded, undefined) of
            Message when is_binary(Message) ->
                Message;
            Message when is_list(Message) ->
                unicode_binary_or_default(Message, Body);
            _ ->
                Body
        end
    catch
        _:_ ->
            Body
    end.

-spec build_request_trace(rpc_request()) -> request_trace().
build_request_trace(Request) ->
    Type = opt_bin(Request, <<"type">>),
    #{
        request_id => erlang:unique_integer([positive, monotonic]),
        is_voice => is_voice_type(Type),
        type => Type,
        guild_id => opt_bin(Request, <<"guild_id">>),
        channel_id => opt_bin(Request, <<"channel_id">>),
        user_id => opt_bin(Request, <<"user_id">>),
        connection_id => opt_bin(Request, <<"connection_id">>),
        token_nonce => opt_bin(Request, <<"token_nonce">>),
        rtc_region => opt_bin(Request, <<"rtc_region">>)
    }.

-spec opt_bin(rpc_request(), binary()) -> binary() | undefined.
opt_bin(Request, Key) ->
    normalize_optional_binary(maps:get(Key, Request, undefined)).

-spec is_voice_type(binary() | undefined) -> boolean().
is_voice_type(<<"voice_", _/binary>>) ->
    true;
is_voice_type(_) ->
    false.

-spec maybe_log_voice_request_start(request_trace()) -> ok.
maybe_log_voice_request_start(#{is_voice := true} = Trace) ->
    logger:debug(
        "voice_rpc_request_start:"
        " request_id=~p type=~p guild_id=~p"
        " channel_id=~p user_id=~p connection_id=~p"
        " token_nonce=~p rtc_region=~p",
        [
            maps:get(request_id, Trace),
            maps:get(type, Trace),
            maps:get(guild_id, Trace),
            maps:get(channel_id, Trace),
            maps:get(user_id, Trace),
            maps:get(connection_id, Trace),
            maps:get(token_nonce, Trace),
            maps:get(rtc_region, Trace)
        ]
    ),
    ok;
maybe_log_voice_request_start(_Trace) ->
    ok.

-spec maybe_log_voice_request_response(request_trace(), rpc_response()) -> ok.
maybe_log_voice_request_response(#{is_voice := true} = Trace, {ok, Data}) ->
    logger:debug(
        "voice_rpc_request_ok: request_id=~p type=~p response_keys=~p",
        [maps:get(request_id, Trace), maps:get(type, Trace), maps:keys(Data)]
    ),
    ok;
maybe_log_voice_request_response(
    #{is_voice := true} = Trace,
    {error, {rpc_error, Status, Message}}
) ->
    logger:warning(
        "voice_rpc_request_api_error: request_id=~p type=~p status=~p message=~p",
        [maps:get(request_id, Trace), maps:get(type, Trace), Status, Message]
    ),
    ok;
maybe_log_voice_request_response(#{is_voice := true} = Trace, {error, Reason}) ->
    logger:warning(
        "voice_rpc_request_error: request_id=~p type=~p reason=~p",
        [maps:get(request_id, Trace), maps:get(type, Trace), Reason]
    ),
    ok;
maybe_log_voice_request_response(_Trace, _Response) ->
    ok.

-spec normalize_optional_binary(term()) -> binary() | undefined.
normalize_optional_binary(undefined) ->
    undefined;
normalize_optional_binary(null) ->
    undefined;
normalize_optional_binary(Value) when is_binary(Value) ->
    Value;
normalize_optional_binary(Value) when is_integer(Value) ->
    integer_to_binary(Value);
normalize_optional_binary(Value) when is_list(Value) ->
    type_conv:unicode_to_binary(Value);
normalize_optional_binary(_) ->
    undefined.

-spec ensure_binary(term()) -> binary().
ensure_binary(Value) when is_binary(Value) ->
    Value;
ensure_binary(Value) when is_list(Value) ->
    unicode_binary_or_default(Value, <<>>);
ensure_binary(Value) when is_atom(Value) ->
    atom_to_binary(Value, utf8);
ensure_binary(_) ->
    <<>>.

-spec ensure_response_map(term()) -> map().
ensure_response_map(Response) when is_map(Response) ->
    Response;
ensure_response_map(_) ->
    erlang:error(badarg).

-spec unicode_binary_or_default(term(), binary()) -> binary().
unicode_binary_or_default(Value, Default) ->
    case type_conv:unicode_to_binary(Value) of
        Binary when is_binary(Binary) -> Binary;
        undefined -> Default
    end.

start_link() -> gen_server:start_link({local, rpc_api_pool}, ?MODULE, [], []).
init([]) ->
    _ = ets:new(rpc_api_health, [named_table, protected, set, {read_concurrency, true}]),
    Urls =
        case fluxer_gateway_env:get_optional(internal_api_rpc_urls) of
            L when is_list(L) -> L;
            _ -> []
        end,
    lists:foreach(fun(U) -> ets:insert(rpc_api_health, {U, true, 0, 0}) end, Urls),
    self() ! health_tick,
    {ok, #{}}.
healthy_urls(Urls) ->
    try
        [
            U
         || U <- Urls,
            case ets:lookup(rpc_api_health, U) of
                [{_, true, _, _}] -> true;
                _ -> false
            end
        ]
    catch
        error:badarg -> Urls
    end.
handle_call(_Request, _From, State) -> {reply, ok, State}.
handle_cast(_Request, State) -> {noreply, State}.
handle_info(health_tick, State) ->
    Urls =
        case fluxer_gateway_env:get_optional(internal_api_rpc_urls) of
            L when is_list(L) -> L;
            _ -> []
        end,
    Owner = self(),
    lists:foreach(
        fun(U) -> spawn(fun() -> Owner ! {api_health, U, probe_api(U)} end) end, Urls
    ),
    erlang:send_after(2000, self(), health_tick),
    {noreply, State};
handle_info({api_health, U, Good}, State) ->
    {Healthy, Fails, Passes} =
        case ets:lookup(rpc_api_health, U) of
            [{_, H, F, P}] -> {H, F, P};
            _ -> {false, 0, 0}
        end,
    Entry =
        case Good of
            true -> {U, Healthy orelse Passes + 1 >= 2, 0, Passes + 1};
            false -> {U, Healthy andalso Fails + 1 < 2, Fails + 1, 0}
        end,
    ets:insert(rpc_api_health, Entry),
    {noreply, State};
handle_info(_, State) ->
    {noreply, State}.
probe_api(Url) ->
    try
        Root = binary:part(Url, 0, byte_size(Url) - byte_size(<<"/internal/rpc">>)),
        Ready = <<Root/binary, "/_ready">>,
        {HostKey, IsHttps} = gateway_http_client_request:url_metadata(Ready),
        case
            gateway_http_client:request(rpc, get, Ready, [], undefined, #{
                connect_timeout => 1000,
                recv_timeout => 1000,
                host_key => HostKey,
                is_https => IsHttps
            })
        of
            {ok, 200, _, _} -> true;
            _ -> false
        end
    catch
        _:_ -> false
    end.
