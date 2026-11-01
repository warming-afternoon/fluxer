%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_thread_lifecycle).
-typing([eqwalizer]).
-include_lib("kernel/include/logger.hrl").
-export([handle_prepare/2, maybe_defer/3, restore_members/2, delete_state/3,
    after_delivery/3, handoff_safe/1, start_snapshot/3, cleanup/1, dispatch_delete/2, timeout/2]).
-define(MAX_PENDING, 4).
-define(PREPARE_MS, 4000).
-define(KEEP_MS, 600000).
-define(PAGE_SIZE, 1000).
-define(MAX_PAGES, 200).
-define(QUEUE_CAP, 1024).
-define(QUEUE_BYTES, 4194304).

%% 只有RPC包装器产生内部phase，公开参数绝不能直接透传到这里。
-spec handle_prepare(map(), map()) -> {reply, term(), map()}.
handle_prepare(#{phase := reserve, thread_id := ThreadId, version := Version,
    operation := Operation} = Request, State0) ->
    State = prune(State0),
    Entries = maps:get(thread_lifecycle, State, #{}),
    Existing = [{Ticket, Entry} || {Ticket, Entry} <- maps:to_list(Entries),
        maps:get(thread_id, Entry) =:= ThreadId,
        maps:get(version, Entry) =:= Version,
        maps:get(operation, Entry) =:= Operation],
    case Existing of
        [{Ticket, #{status := ready}} | _] ->
            {reply, #{<<"ticket">> => Ticket, <<"ready">> => true}, State};
        [_ | _] ->
            {reply, {error, thread_lifecycle_busy}, State};
        [] when map_size(Entries) >= ?MAX_PENDING ->
            {reply, {error, thread_lifecycle_limit}, State};
        [] ->
            Ticket = maps:get(ticket, Request, base64:encode(crypto:strong_rand_bytes(24))),
            case Operation of
                reload -> erlang:send_after(?PREPARE_MS, self(), {thread_lifecycle_timeout, Ticket});
                delete -> ok
            end,
            Entry = Request#{status => pending, expires => now_ms() + ?PREPARE_MS,
                events => [], queued => 0, queued_bytes => 0},
            {reply, #{<<"ticket">> => Ticket, <<"ready">> => false},
                State#{thread_lifecycle => Entries#{Ticket => Entry}}}
    end;
handle_prepare(#{phase := reuse, ticket := Ticket, thread_id := ThreadId,
    version := Version, operation := delete} = Request, State0) ->
    %% 清理在 owner 确认之后才开始；keeper 丢失时可以从冻结且完整的 DB 关系恢复同一票据。
    State = prune(State0),
    case maps:get(Ticket, maps:get(thread_lifecycle, State, #{}), undefined) of
        #{thread_id := ThreadId, version := Version, operation := delete,
            status := ready} = Entry ->
            case valid_snapshot(ThreadId, Version, Entry) of
                true -> {reply, #{<<"ticket">> => Ticket, <<"ready">> => true}, State};
                false -> {reply, {error, thread_lifecycle_ticket_expired}, State}
            end;
        _ -> handle_prepare(Request#{phase => reserve}, State)
    end;
handle_prepare(#{phase := install, ticket := Ticket, snapshot := Snapshot}, State0) ->
    State = prune(State0),
    Entries = maps:get(thread_lifecycle, State, #{}),
    case maps:get(Ticket, Entries, undefined) of
        #{thread_id := ThreadId, version := Version, status := pending} = Entry ->
            case valid_snapshot(ThreadId, Version, Snapshot) of
                true ->
                    Keeper = maps:get(keeper, Snapshot),
                    Keeper ! {retain, Ticket},
                    Ready = maps:merge(Entry#{status => ready, expires => now_ms() + ?KEEP_MS}, Snapshot),
                    State1 = State#{thread_lifecycle => Entries#{Ticket => Ready}},
                    case maps:get(operation, Entry) of
                        delete -> {reply, #{<<"ticket">> => Ticket}, State1};
                        reload -> finish_reload(Ticket, Ready, State1)
                    end;
                false -> {reply, {error, invalid_thread_lifecycle_snapshot}, State}
            end;
        _ -> {reply, {error, stale_thread_lifecycle_ticket}, State}
    end;
handle_prepare(#{phase := cancel, ticket := Ticket}, State) ->
    case maps:get(Ticket, maps:get(thread_lifecycle, State, #{}), undefined) of
        #{operation := reload, events := Events, event_data := Data} ->
            {reply, ok, restart_load(Events ++ [{thread_update, Data}], drop_ticket(Ticket, State))};
        _ -> {reply, ok, drop_ticket(Ticket, State)}
    end;
handle_prepare(_Request, State) ->
    {reply, {error, invalid_thread_lifecycle_request}, State}.

%% 删除调用只有完成 owner 分发才回复；失败保留持久票据供 API 重试，不承诺设备收件确认。
-spec dispatch_delete(map(), map()) -> {reply, term(), map()}.
dispatch_delete(Data, State) ->
    Ticket = maps:get(<<"_fluxer_lifecycle_ticket">>, Data),
    try
        true = maps:is_key(Ticket, maps:get(thread_lifecycle, State, #{})),
        {noreply, Next} = guild_dispatch:handle_dispatch(thread_delete, Data, State),
        case maps:is_key(Ticket, maps:get(thread_lifecycle, Next, #{})) of
            false -> {reply, true, Next};
            true -> {reply, {error, thread_delete_dispatch_not_completed}, Next}
        end
    catch Class:Reason ->
        ?LOG_WARNING("thread_delete_dispatch_failed: ~p:~p", [Class, Reason]),
        {reply, {error, thread_delete_dispatch_failed}, State}
    end.

%% 没有后续事件时也恢复超时的取消归档队列；迟到的旧票据不能影响新状态。
-spec timeout(binary(), map()) -> map().
timeout(Ticket, State) ->
    case maps:get(Ticket, maps:get(thread_lifecycle, State, #{}), undefined) of
        #{operation := reload, events := Events, event_data := Data} ->
            restart_load(Events ++ [{thread_update, Data}], drop_ticket(Ticket, State));
        _ -> State
    end.

%% 快照拥有者与元数据必须相互吻合，避免安装迟到或伪造的临时表。
-spec valid_snapshot(integer(), term(), map()) -> boolean().
valid_snapshot(ThreadId, Version, #{thread_id := ThreadId, version := Version,
    tab := Tab, keeper := Keeper, count := Count}) when is_pid(Keeper), is_integer(Count) ->
    try ets:info(Tab, owner) =:= Keeper andalso is_process_alive(Keeper) andalso
        guild_thread_store:member_count(Tab, ThreadId) =:= Count
    catch error:badarg -> false end;
valid_snapshot(_, _, _) -> false.

%% 取消归档先在owner外读取，期间只暂存该帖事件，其他频道照常分发。
-spec maybe_defer(atom(), map(), map()) -> pass | {deferred, map()}.
maybe_defer(Event, _Data, #{thread_lifecycle := Entries}) when
    map_size(Entries) =:= 0, Event =/= thread_update -> pass;
maybe_defer(Event, _Data, State) when
    not is_map_key(thread_lifecycle, State), Event =/= thread_update -> pass;
maybe_defer(Event, Data, State) ->
    ThreadId = event_thread_id(Event, Data),
    Entries = maps:get(thread_lifecycle, State, #{}),
    Pending = [{Ticket, Entry} || {Ticket, #{operation := reload, thread_id := Id} = Entry}
        <- maps:to_list(Entries), Id =:= ThreadId],
    case Pending of
        [{Ticket, Entry} | _] ->
            Bytes = erlang:external_size(Data),
            Queued = maps:get(queued, Entry),
            Total = maps:get(queued_bytes, Entry) + Bytes,
            case maps:get(expires, Entry) > now_ms() andalso
                Queued < ?QUEUE_CAP andalso Total =< ?QUEUE_BYTES of
                true ->
                    Next = Entry#{events => [{Event, Data} | maps:get(events, Entry)],
                        queued => Queued + 1, queued_bytes => Total},
                    {deferred, State#{thread_lifecycle => Entries#{Ticket => Next}}};
                false ->
                    %% 超限进入既有全量恢复流程，不能把半份成员存储发布为ready。
                    ?LOG_WARNING("thread_lifecycle_queue_overflow: guild_id=~p thread_id=~p queued=~p bytes=~p",
                        [maps:get(id, State), ThreadId, Queued, Total]),
                    {deferred, restart_load([{Event, Data} | maps:get(events, Entry)] ++
                        [{thread_update, maps:get(event_data, Entry)}],
                        drop_ticket(Ticket, State))}
            end;
        [] ->
            maybe_start_reload(Event, Data, ThreadId, State)
    end.

%% 首次恢复事件建立固定容量占位，后台工作进程不会复制整个guild状态。
-spec maybe_start_reload(atom(), map(), term(), map()) -> pass | {deferred, map()}.
maybe_start_reload(thread_update, #{<<"_fluxer_reload_members">> := true} = Data,
    ThreadId, State) when is_integer(ThreadId) ->
    Request = #{phase => reserve, thread_id => ThreadId,
        guild_id => maps:get(id, State), version => undefined, operation => reload,
        event_data => maps:remove(<<"_fluxer_reload_members">>, Data)},
    case handle_prepare(Request, State) of
        {reply, #{<<"ticket">> := Ticket}, Reserved} ->
            GuildPid = self(),
            _ = spawn(fun() -> gateway_rpc_thread_lifecycle:load_reserved(GuildPid, Request, Ticket) end),
            {deferred, Reserved};
        {reply, {error, _}, Unchanged} ->
            {deferred, restart_load([{thread_update, Data}], Unchanged)}
    end;
maybe_start_reload(_, _, _, _) -> pass.

%% 消息以channel_id寻址，帖子与成员事件以id寻址。
-spec event_thread_id(atom(), map()) -> integer() | undefined.
event_thread_id(Event, Data) ->
    Key = case Event of
        message_create -> <<"channel_id">>;
        message_update -> <<"channel_id">>;
        message_delete -> <<"channel_id">>;
        message_delete_bulk -> <<"channel_id">>;
        _ -> <<"id">>
    end,
    snowflake_id:parse_optional(maps:get(Key, Data, undefined)).

%% 恢复标记只存在本地State，不能把ETS引用塞进可发送的事件payload。
-spec finish_reload(binary(), map(), map()) -> {reply, term(), map()}.
finish_reload(Ticket, #{event_data := Data, tab := Tab, events := Events}, State) ->
    State1 = drop_ticket_without_cleanup(Ticket, State),
    {noreply, Restored} = guild_thread_dispatch:handle(thread_update, Data,
        State1#{thread_lifecycle_restore => Tab}),
    cleanup_entry(Ticket, maps:get(Ticket, maps:get(thread_lifecycle, State))),
    case maps:is_key(thread_lifecycle_restore, Restored) of
        true ->
            {reply, {error, thread_lifecycle_restore_failed},
                restart_load(Events ++ [{thread_update, Data}],
                    maps:remove(thread_lifecycle_restore, Restored))};
        false ->
            Replay = lists:foldl(fun({Event, EventData}, Acc) ->
                {noreply, Next} = guild_dispatch:handle_dispatch(Event, EventData, Acc), Next
            end, Restored, lists:reverse(Events)),
            {reply, #{<<"ticket">> => Ticket}, Replay}
    end.

%% 复制时只构造512人的中间页，最后一人的关系也必须恢复。
-spec restore_members(integer(), map()) -> map().
restore_members(ThreadId, #{thread_lifecycle_restore := Source} = State) ->
    Target = guild_thread_gate:store(State),
    ok = copy_members(Source, Target, ThreadId, undefined),
    maps:remove(thread_lifecycle_restore, State);
restore_members(_, State) -> State.

%% 页游标只向前推进，复制保留每个成员原有通知与静音设置。
-spec copy_members(ets:table(), ets:table(), integer(), integer() | undefined) -> ok.
copy_members(Source, Target, ThreadId, After) ->
    case guild_thread_store:member_ids_page(Source, ThreadId, After, 512) of
        [] -> ok;
        Ids ->
            lists:foreach(fun(UserId) ->
                Member = guild_thread_store:get_member(Source, ThreadId, UserId),
                ok = guild_thread_store:put_member(Target, ThreadId, UserId, Member)
            end, Ids),
            copy_members(Source, Target, ThreadId, lists:last(Ids))
    end.

%% 删除始终用准备时的完整存储检查私有成员与当前父权限，不传递成员数组。
-spec delete_state(integer(), map(), map()) -> map().
delete_state(ThreadId, #{<<"_fluxer_lifecycle_ticket">> := Ticket} = Data, State) ->
    case maps:get(Ticket, maps:get(thread_lifecycle, State, #{}), undefined) of
        #{thread_id := ThreadId, operation := delete, status := ready, version := Version,
            tab := Tab, keeper := Keeper, expires := Expires} ->
            Version = maps:get(<<"_fluxer_state_version">>, Data),
            true = Expires > now_ms() andalso is_process_alive(Keeper),
            State#{data => (maps:get(data, State))#{thread_store => Tab}};
        _ -> error(stale_thread_lifecycle_ticket)
    end;
delete_state(_, _, State) -> State.

%% 只有WS实际分发返回后才释放snapshot，同帖旧重试票据一并清理。
-spec after_delivery(atom(), map(), map()) -> map().
after_delivery(thread_delete, #{<<"_fluxer_lifecycle_ticket">> := Ticket}, State) ->
    Entries = maps:get(thread_lifecycle, State, #{}),
    case maps:get(Ticket, Entries, undefined) of
        #{thread_id := ThreadId} ->
            lists:foldl(fun({Key, #{thread_id := Id}}, Acc) ->
                case Id =:= ThreadId of true -> drop_ticket(Key, Acc); false -> Acc end
            end, State, maps:to_list(Entries));
        _ -> State
    end;
after_delivery(_, _, State) -> State.

%% 未广播的删除不能跨节点丢失内存快照；handoff必须明确返回busy。
-spec handoff_safe(map()) -> boolean().
handoff_safe(State) ->
    Now = now_ms(),
    not lists:any(fun(Entry) -> entry_live(Entry, Now) end,
        maps:values(maps:get(thread_lifecycle, State, #{}))).

%% 功能关闭时精确释放本guild全部临时资源，不影响其他guild。
-spec cleanup(map()) -> map().
cleanup(State) ->
    maps:fold(fun(Ticket, Entry, ok) -> cleanup_entry(Ticket, Entry) end,
        ok, maps:get(thread_lifecycle, State, #{})),
    maps:remove(thread_lifecycle, State).

%% 过期或拥有者已退出的票据不占用后续准备额度。
-spec prune(map()) -> map().
prune(State) ->
    Now = now_ms(),
    lists:foldl(fun({Ticket, Entry}, Acc) ->
        case entry_live(Entry, Now) of
            false ->
                case maps:get(operation, Entry) of
                    reload -> timeout(Ticket, Acc);
                    delete -> drop_ticket(Ticket, Acc)
                end;
            true -> Acc
        end
    end, State, maps:to_list(maps:get(thread_lifecycle, State, #{}))).

%% 就绪票据还要求拥有者存活，过期边界不能复用已失效资源。
-spec entry_live(map(), integer()) -> boolean().
entry_live(#{expires := Expires, status := ready, keeper := Keeper}, Now) ->
    Expires > Now andalso is_process_alive(Keeper);
entry_live(#{expires := Expires}, Now) -> Expires > Now.

%% 秘密票据精确定位资源，不能按无关帖子批量删除快照。
-spec drop_ticket(binary(), map()) -> map().
drop_ticket(Ticket, State) ->
    case maps:get(Ticket, maps:get(thread_lifecycle, State, #{}), undefined) of
        undefined -> State;
        Entry -> cleanup_entry(Ticket, Entry), drop_ticket_without_cleanup(Ticket, State)
    end.

%% 安装恢复期间暂时移除占位，原事件回放不能再次进入自己的队列。
-spec drop_ticket_without_cleanup(binary(), map()) -> map().
drop_ticket_without_cleanup(Ticket, State) ->
    State#{thread_lifecycle => maps:remove(Ticket, maps:get(thread_lifecycle, State, #{}))}.

%% 清理信号带秘密票据，只有对应keeper会响应。
-spec cleanup_entry(binary(), map()) -> ok.
cleanup_entry(Ticket, #{keeper := Keeper}) -> Keeper ! {cleanup, Ticket}, ok;
cleanup_entry(_, _) -> ok.

%% 所有分页调用都发生在keeper，guild owner只接收小型安装元数据。
-spec start_snapshot(pid(), map(), binary()) -> {ok, map()} | {error, term()}.
start_snapshot(GuildPid, Request, Ticket) ->
    Caller = self(),
    {Keeper, Monitor} = spawn_monitor(fun() ->
        GuildMonitor = erlang:monitor(process, GuildPid),
        CallerMonitor = erlang:monitor(process, Caller),
        Tab = ets:new(thread_lifecycle_snapshot, [ordered_set, protected, {read_concurrency, true}]),
        try
            ThreadId = maps:get(thread_id, Request),
            Context = maps:get(event_data, Request, undefined),
            case Context of
                undefined -> ok;
                _ -> guild_thread_store:put_thread(Tab, guild_data_normalize:thread(Context))
            end,
            Version = maps:get(version, Request),
            Deadline = now_ms() + ?PREPARE_MS,
            Hash = crypto:hash_init(sha256),
            {Count, FinalHash} = fetch_pages(Tab, Request, undefined, ?MAX_PAGES,
                Deadline, undefined, 0, Hash),
            Caller ! {thread_snapshot_ready, self(), #{thread_id => ThreadId, version => Version,
                tab => Tab, keeper => self(), count => Count, hash => binary:encode_hex(FinalHash)}},
            keep_snapshot(Ticket, GuildMonitor, CallerMonitor, now_ms() + ?KEEP_MS)
        catch Class:Reason -> Caller ! {thread_snapshot_error, self(), {Class, Reason}}
        after guild_thread_store:destroy(Tab) end
    end),
    receive
        {thread_snapshot_ready, Keeper, Snapshot} ->
            erlang:demonitor(Monitor, [flush]), {ok, Snapshot};
        {thread_snapshot_error, Keeper, Reason} ->
            erlang:demonitor(Monitor, [flush]), {error, Reason};
        {'DOWN', Monitor, process, Keeper, Reason} -> {error, Reason}
    after ?PREPARE_MS ->
        exit(Keeper, kill), erlang:demonitor(Monitor, [flush]),
        {error, thread_lifecycle_prepare_timeout}
    end.

%% 严格检查页版本、人数、顺序与游标，任何失败都不返回部分成功快照。
-spec fetch_pages(ets:table(), map(), binary() | undefined, non_neg_integer(), integer(),
    non_neg_integer() | undefined, non_neg_integer(), term()) -> {non_neg_integer(), binary()}.
fetch_pages(_Tab, _Request, _After, 0, _Deadline, _Expected, _Count, _Hash) ->
    error(thread_lifecycle_page_budget_exhausted);
fetch_pages(Tab, Request, After, Left, Deadline, Expected0, Count0, Hash0) ->
    Remaining = Deadline - now_ms(),
    true = Remaining > 0,
    ThreadId = maps:get(thread_id, Request),
    ThreadBin = integer_to_binary(ThreadId),
    Version = maps:get(version, Request),
    Rpc0 = #{<<"type">> => <<"list_thread_members">>,
        <<"guild_id">> => integer_to_binary(maps:get(guild_id, Request)),
        <<"thread_ids">> => [ThreadBin], <<"limit">> => ?PAGE_SIZE},
    Rpc1 = case After of undefined -> Rpc0; _ -> Rpc0#{<<"after_user_id">> => After} end,
    Rpc = case Version of undefined -> Rpc1; _ -> Rpc1#{<<"expected_state_version">> => Version} end,
    {ok, Page} = rpc_client:call(Rpc, min(2000, Remaining)),
    Expected = case Version of
        undefined -> Expected0;
        _ ->
            Version = maps:get(<<"state_version">>, Page),
            Size = maps:get(<<"member_count">>, Page),
            true = is_integer(Size) andalso Size >= 0 andalso Size =< ?MAX_PAGES * ?PAGE_SIZE,
            case Expected0 of undefined -> ok; Size -> ok; _ -> error(thread_lifecycle_count_changed) end,
            Context = maps:get(<<"thread_context">>, Page),
            ThreadId = snowflake_id:parse(maps:get(<<"id">>, Context)),
            ok = guild_thread_store:put_thread(Tab, guild_data_normalize:thread(Context)),
            Size
    end,
    Members = maps:get(<<"members">>, Page),
    true = is_list(Members) andalso length(Members) =< ?PAGE_SIZE,
    Last0 = case After of undefined -> 0; _ -> snowflake_id:parse(After) end,
    {Last, Count, Hash} = lists:foldl(fun(Raw, {Previous, N, Digest}) ->
        Member = guild_data_normalize:thread_member(Raw),
        ThreadId = maps:get(<<"id">>, Member),
        UserId = maps:get(<<"user_id">>, Member),
        true = is_integer(UserId) andalso UserId > Previous,
        ok = guild_thread_store:put_member(Tab, ThreadId, UserId, Member),
        {UserId, N + 1, crypto:hash_update(Digest, [integer_to_binary(UserId), <<"\n">>])}
    end, {Last0, Count0, Hash0}, Members),
    case maps:get(<<"has_more">>, Page) of
        false ->
            case Expected of undefined -> ok; Count -> ok; _ -> error(thread_lifecycle_incomplete_snapshot) end,
            {Count, crypto:hash_final(Hash)};
        true ->
            true = Last > Last0,
            ThreadBin = maps:get(<<"next_thread_id">>, Page),
            Next = maps:get(<<"next_after_user_id">>, Page),
            Last = snowflake_id:parse(Next),
            fetch_pages(Tab, Request, Next, Left - 1, Deadline, Expected, Count, Hash)
    end.

%% 拥有者、调用者和固定截止时间共同约束临时存储寿命。
-spec keep_snapshot(binary(), reference(), reference() | undefined, integer()) -> ok.
keep_snapshot(Ticket, GuildMonitor, CallerMonitor, Expires) ->
    receive
        {retain, Ticket} ->
            case CallerMonitor of undefined -> ok; _ -> erlang:demonitor(CallerMonitor, [flush]) end,
            keep_snapshot(Ticket, GuildMonitor, undefined, Expires);
        {cleanup, Ticket} -> ok;
        {'DOWN', GuildMonitor, process, _, _} -> ok;
        {'DOWN', CallerMonitor, process, _, _} when is_reference(CallerMonitor) ->
            %% 安装回复与retain来自不同进程，给已提交的保留信号一个有界到达窗口。
            receive
                {retain, Ticket} -> keep_snapshot(Ticket, GuildMonitor, undefined, Expires);
                {cleanup, Ticket} -> ok;
                {'DOWN', GuildMonitor, process, _, _} -> ok
            after 1000 -> ok end
    after max(0, Expires - now_ms()) -> ok end.

%% 有界队列失败沿用全量冷恢复，所有失败保留日志而非伪装恢复完成。
-spec restart_load([{atom(), map()}], map()) -> map().
restart_load(Events, State) ->
    guild_thread_load:handle_retry(State#{thread_load => #{status => loading,
        queue => Events, queued => length(Events), attempt => 0}}).

%% 生命周期截止时间只使用单调时钟。
-spec now_ms() -> integer().
now_ms() -> erlang:monotonic_time(millisecond).

