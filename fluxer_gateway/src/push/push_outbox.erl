%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(push_outbox).
-typing([eqwalizer]).
-behaviour(gen_server).

-export([
    start_link/0,
    enqueue/1,
    truncate_read/3,
    note_session_active/1,
    record_dropped/2,
    stats/0,
    request_timeout_ms/0,
    max_age_ms/0
]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).
-export_type([job/0, kind/0]).

-define(DEFAULT_MAX_QUEUE, 10000).
-define(DEFAULT_MAX_INFLIGHT, 96).
-define(DEFAULT_REQUEST_TIMEOUT_MS, 100000).
-define(DEFAULT_MAX_AGE_MS, 300000).
-define(DEFAULT_RETRY_BASE_MS, 1000).
-define(RETRY_MAX_MS, 30000).
-define(ENQUEUE_TIMEOUT_MS, 1000).
-define(STATS_TIMEOUT_MS, 1000).
-define(PRUNE_INTERVAL_MS, 30000).

-type kind() :: message | clear | ring.
-type job() :: #{
    kind := kind(),
    subject := binary(),
    job := map(),
    body := binary(),
    user_ids := [integer()],
    channel_id := integer(),
    message_id := integer()
}.
-type entry() :: #{
    kind := kind(),
    subject := binary(),
    job := map(),
    body := binary(),
    user_ids := [integer()],
    channel_id := integer(),
    message_id := integer(),
    seq := non_neg_integer(),
    enqueued_at := integer(),
    attempts := non_neg_integer(),

    %% 跨重试保留的逻辑任务身份。
    item_id => binary(),

    %% 批传输内的原始逻辑任务。
    batch_entries => [entry()]
}.
-type counter() ::
    delivered
    | retries
    | sheds
    | truncations
    | skipped_active
    | followup_clears
    | enqueued.
-type state() :: #{
    jobs := gb_trees:tree(non_neg_integer(), entry()),
    message_index => #{integer() => gb_sets:set(non_neg_integer())},
    ready := queue:queue(non_neg_integer()),
    inflight := #{pid() => {reference(), reference(), entry()}},
    followups => #{pid() => #{integer() => integer()}},
    next_seq := non_neg_integer(),
    reads := #{{integer(), integer()} => {integer(), integer()}},
    active := #{integer() => {non_neg_integer(), integer()}},
    counters := #{counter() => non_neg_integer()},
    dropped := #{{kind(), atom()} => pos_integer()},
    max_queue := pos_integer(),
    max_inflight := pos_integer(),
    request_timeout_ms := pos_integer(),
    max_age_ms := pos_integer(),
    retry_base_ms := pos_integer(),

    %% 进程启动时确定的清理批传输开关。
    clear_batch_enabled => boolean(),

    %% 等待连续清理前缀的刷新定时器。
    clear_batch_timer => reference() | undefined
}.

-spec start_link() -> {ok, pid()} | {error, term()} | ignore.
start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

-spec enqueue(job()) -> ok | {error, term()}.
enqueue(Job) ->
    try gen_server:call(?MODULE, {enqueue, Job}, ?ENQUEUE_TIMEOUT_MS) of
        ok -> ok
    catch
        exit:{noproc, _} -> {error, outbox_unavailable};
        exit:{Reason, _} -> {error, {outbox_unavailable, Reason}}
    end.

-spec truncate_read(integer(), integer(), integer()) -> ok.
truncate_read(UserId, ChannelId, MessageId) ->
    broadcast({truncate_read, UserId, ChannelId, MessageId}).

-spec note_session_active(integer()) -> ok.
note_session_active(UserId) ->
    broadcast({session_active, UserId}).

-spec record_dropped(kind(), atom()) -> ok.
record_dropped(Kind, Reason) ->
    gen_server:cast(?MODULE, {dropped, Kind, Reason}).

-spec stats() -> map().
stats() ->
    try gen_server:call(?MODULE, stats, ?STATS_TIMEOUT_MS) of
        Stats when is_map(Stats) -> Stats
    catch
        exit:_ -> #{}
    end.

-spec request_timeout_ms() -> pos_integer().
request_timeout_ms() ->
    env_pos_integer(push_outbox_request_timeout_ms, ?DEFAULT_REQUEST_TIMEOUT_MS).

-spec max_age_ms() -> pos_integer().
max_age_ms() ->
    env_pos_integer(push_outbox_max_age_ms, ?DEFAULT_MAX_AGE_MS).

%% 初始化推送队列及进程启动时确定的批传输状态。
-spec init([]) -> {ok, state()}.
init([]) ->
    erlang:process_flag(fullsweep_after, 10),
    schedule_prune(),
    {ok, #{
        jobs => gb_trees:empty(),
        %% 启动后固定本进程采用的清理传输协议。
        clear_batch_enabled => fluxer_gateway_env:get_optional(push_clear_batch_enabled) =:=
            true,

        %% 仅在等待连续清理前缀时保存刷新定时器。
        clear_batch_timer => undefined,

        message_index => #{},
        ready => queue:new(),
        inflight => #{},
        followups => #{},
        next_seq => 0,
        reads => #{},
        active => #{},
        counters => #{},
        dropped => #{},
        max_queue => env_pos_integer(push_outbox_max_queue, ?DEFAULT_MAX_QUEUE),
        max_inflight => env_pos_integer(push_outbox_max_inflight, ?DEFAULT_MAX_INFLIGHT),
        request_timeout_ms => request_timeout_ms(),
        max_age_ms => max_age_ms(),
        retry_base_ms => app_pos_integer(push_outbox_retry_base_ms, ?DEFAULT_RETRY_BASE_MS)
    }}.

-spec handle_call(term(), gen_server:from(), state()) -> {reply, term(), state()}.
handle_call({enqueue, Job}, _From, State) when
    is_map_key(kind, Job),
    is_map_key(subject, Job),
    is_map_key(body, Job),
    is_map_key(user_ids, Job),
    is_map_key(channel_id, Job),
    is_map_key(message_id, Job)
->
    {reply, ok, pump(admit(Job, State))};
handle_call(stats, _From, State) ->
    {reply, build_stats(State), State};
handle_call(_Request, _From, State) ->
    {reply, {error, unknown_request}, State}.

-spec handle_cast(term(), state()) -> {noreply, state()}.
handle_cast({truncate_read, UserId, ChannelId, MessageId}, State) when
    is_integer(UserId), is_integer(ChannelId), is_integer(MessageId)
->
    {noreply, apply_read(UserId, ChannelId, MessageId, State)};
handle_cast({session_active, UserId}, State) when is_integer(UserId) ->
    {noreply, record_active(UserId, State)};
handle_cast({dropped, Kind, Reason}, State) when is_atom(Kind), is_atom(Reason) ->
    {noreply, count_dropped(Kind, Reason, State)};
handle_cast(_Msg, State) ->
    {noreply, State}.

%% 处理推送结果、重试和批清理刷新消息。
-spec handle_info(term(), state()) -> {noreply, state()}.
handle_info({push_outbox_reply, Pid, Result}, State) when is_pid(Pid) ->
    {noreply, pump(finish_worker(Pid, reply_result(Result), State))};
handle_info({'DOWN', _MRef, process, Pid, Reason}, State) when is_pid(Pid) ->
    {noreply, pump(finish_worker(Pid, down_result(Reason), State))};
handle_info({request_deadline, Pid}, State) when is_pid(Pid) ->
    kill_expired_worker(Pid, State),
    {noreply, State};
handle_info({retry, Seq}, State) when is_integer(Seq), Seq >= 0 ->
    {noreply, pump(make_ready(Seq, State))};
handle_info(clear_batch_flush, State) ->
    {noreply, pump(State#{clear_batch_timer => undefined})};
handle_info(prune, State) ->
    schedule_prune(),
    {noreply, prune(State)};
handle_info(_Info, State) ->
    {noreply, State}.

-spec terminate(term(), state()) -> ok.
terminate(_Reason, _State) ->
    ok.

-spec code_change(term(), state(), term()) -> {ok, state()}.
code_change(_OldVsn, State, _Extra) ->
    {ok, State}.

%% 为入队任务分配稳定身份并执行容量限制。
-spec admit(job(), state()) -> state().
admit(Job, #{next_seq := Seq} = State) ->
    %% 稳定身份随逻辑任务保留，重试不会生成新的逐项标识。
    Entry = maps:merge(Job, #{
        seq => Seq,
        enqueued_at => now_ms(),
        attempts => 0,

        %% 使用节点、队列进程和序号区分逻辑任务。
        item_id => base64:encode(term_to_binary({node(), self(), Seq}))
    }),
    State1 = bump(enqueued, 1, State#{next_seq := Seq + 1}),
    shed_to_capacity(insert(Entry, State1)).

-spec insert(entry(), state()) -> state().
insert(#{seq := Seq} = Entry, #{ready := Ready} = State) ->
    queued_put(Entry, State#{ready := queue:in(Seq, Ready)}).

%% The primary queue owns jobs and order; this optional index only locates queued messages.
%% Backoff jobs remain indexed. Inflight jobs leave the index before dispatch.
queued_put(#{seq := Seq} = Entry, #{jobs := Jobs} = State) ->
    State1 =
        case gb_trees:lookup(Seq, Jobs) of
            {value, Previous} -> index_remove(Previous, State);
            none -> State
        end,
    index_add(Entry, State1#{jobs := gb_trees:enter(Seq, Entry, Jobs)}).

queued_remove(Seq, #{jobs := Jobs} = State) ->
    case gb_trees:lookup(Seq, Jobs) of
        none -> State;
        {value, Entry} -> index_remove(Entry, State#{jobs := gb_trees:delete(Seq, Jobs)})
    end.

index_add(
    #{kind := message, channel_id := ChannelId, seq := Seq},
    #{message_index := Index} = State
) ->
    Seqs = gb_sets:add(Seq, maps:get(ChannelId, Index, gb_sets:empty())),
    State#{message_index := Index#{ChannelId => Seqs}};
index_add(_Entry, State) ->
    State.

index_remove(
    #{kind := message, channel_id := ChannelId, seq := Seq},
    #{message_index := Index} = State
) ->
    case maps:find(ChannelId, Index) of
        error ->
            State;
        {ok, Seqs} ->
            Rest = gb_sets:delete_any(Seq, Seqs),
            Next =
                case gb_sets:is_empty(Rest) of
                    true -> maps:remove(ChannelId, Index);
                    false -> Index#{ChannelId := Rest}
                end,
            State#{message_index := Next}
    end;
index_remove(_Entry, State) ->
    State.

-spec shed_to_capacity(state()) -> state().
shed_to_capacity(#{jobs := Jobs, max_queue := MaxQueue} = State) ->
    case gb_trees:size(Jobs) > MaxQueue of
        true ->
            {Seq, Shed} = gb_trees:smallest(Jobs),
            shed_to_capacity(shed(Shed, queued_remove(Seq, State)));
        false ->
            State
    end.

-spec shed(entry(), state()) -> state().
shed(Entry, State) ->
    log_shed(Entry),
    bump(sheds, 1, State).

-spec log_shed(entry()) -> ok.
log_shed(#{kind := Kind, channel_id := ChannelId, message_id := MessageId}) ->
    logger:warning(
        "Push outbox at capacity, dropping the earliest queued job",
        #{kind => Kind, channel_id => ChannelId, message_id => MessageId}
    ).

%% 按逻辑任务数量限制在途工作。
-spec pump(state()) -> state().
pump(#{max_inflight := MaxInflight} = State) ->
    case inflight_items(State) >= MaxInflight of
        true -> State;
        false -> pump_ready(State)
    end.

%% 按队列顺序选择单项派发或连续清理批次。
-spec pump_ready(state()) -> state().
pump_ready(#{ready := Ready, jobs := Jobs} = State) ->
    %% 仅清理任务允许形成批次，其他任务仍沿原单项路径派发。
    case queue:out(Ready) of
        {empty, _} ->
            State;
        {{value, Seq}, Rest} ->
            case gb_trees:lookup(Seq, Jobs) of
                {value, #{kind := clear} = Entry} ->
                    case maps:get(clear_batch_enabled, State, false) of
                        true -> pump_clear_batch(Entry, State);
                        false -> pump(take_ready({value, Entry}, Seq, State#{ready := Rest}))
                    end;
                Found ->
                    pump(take_ready(Found, Seq, State#{ready := Rest}))
            end
    end.

%% 在有限等待后仅合并连续清理前缀派发。
-spec pump_clear_batch(entry(), state()) -> state().
pump_clear_batch(#{enqueued_at := At}, State) ->
    %% 等待上界由最早任务决定，不因后续任务持续推迟发送。
    Wait = 5 - (now_ms() - At),
    case Wait > 0 of
        true ->
            case maps:get(clear_batch_timer, State, undefined) of
                undefined ->
                    State#{
                        clear_batch_timer => erlang:send_after(Wait, self(), clear_batch_flush)
                    };
                _ ->
                    State
            end;
        false ->
            Slots = min(32, maps:get(max_inflight, State) - inflight_items(State)),
            {Entries, State1} = take_clear_prefix(Slots, [], State),
            case Entries of
                [] ->
                    pump(State1);
                [First | _] ->
                    %% 传输封装只聚合发送，各项清理边界保持独立。
                    Items = [
                        #{
                            %% 与逐项回复匹配的稳定任务身份。
                            <<"item_id">> => maps:get(item_id, E),

                            %% 包含原始清理边界的任务载荷。
                            <<"job">> => maps:get(job, E)
                        }
                     || E <- Entries
                    ],
                    Batch = First#{
                        %% 保留各逻辑任务用于容量计算和逐项重试。
                        batch_entries => Entries,

                        %% 编码带版本与逐项清理载荷的传输封装。
                        body := iolist_to_binary(
                            json:encode(#{
                                %% 批清理传输协议版本。
                                <<"v">> => 2,

                                %% 不合并各任务原始清理边界。
                                <<"items">> => Items
                            })
                        )
                    },
                    pump(start_worker(Batch, State1))
            end
    end.

%% 提取连续清理任务并保留消息与响铃屏障。
-spec take_clear_prefix(non_neg_integer(), [entry()], state()) -> {[entry()], state()}.
take_clear_prefix(0, Acc, State) ->
    {lists:reverse(Acc), State};
take_clear_prefix(N, Acc, #{ready := Ready, jobs := Jobs} = State) ->
    case queue:out(Ready) of
        {empty, _} ->
            {lists:reverse(Acc), State};
        {{value, Seq}, Rest} ->
            case gb_trees:lookup(Seq, Jobs) of
                none ->
                    take_clear_prefix(N, Acc, State#{ready := Rest});
                {value, #{kind := clear} = E} ->
                    State1 = queued_remove(Seq, State#{ready := Rest}),
                    case is_expired(E, State1) of
                        true -> take_clear_prefix(N, Acc, drop_expired(E, State1));
                        false -> take_clear_prefix(N - 1, [E | Acc], State1)
                    end;
                _ ->
                    %% 消息或响铃是顺序屏障，不越过它们寻找清理任务。
                    {lists:reverse(Acc), State}
            end
    end.

%% 取得传输封装包含的原始逻辑任务。
-spec logical_entries(entry()) -> [entry()].
logical_entries(#{batch_entries := Entries}) ->
    Entries;
logical_entries(Entry) ->
    [Entry].

%% 按原始逻辑任务计算在途数量。
-spec inflight_items(state()) -> non_neg_integer().
inflight_items(#{inflight := Inflight}) ->
    lists:sum([length(logical_entries(E)) || {_, _, E} <- maps:values(Inflight)]).

-spec take_ready(none | {value, entry()}, non_neg_integer(), state()) -> state().
take_ready(none, _Seq, State) ->
    State;
take_ready({value, Entry}, Seq, State) ->
    dispatch(Entry, queued_remove(Seq, State)).

-spec dispatch(entry(), state()) -> state().
dispatch(Entry, State) ->
    case prepare(Entry, State) of
        {skip, State1} -> State1;
        {send, Prepared, State1} -> send_or_drop(Prepared, State1)
    end.

-spec send_or_drop(entry(), state()) -> state().
send_or_drop(Entry, State) ->
    case is_expired(Entry, State) of
        true -> drop_expired(Entry, State);
        false -> start_worker(Entry, State)
    end.

-spec prepare(entry(), state()) -> {skip, state()} | {send, entry(), state()}.
prepare(#{kind := Kind} = Entry, State) when Kind =:= clear; Kind =:= ring ->
    {send, Entry, State};
prepare(#{user_ids := UserIds} = Entry, #{reads := Reads, active := Active} = State) ->
    #{channel_id := ChannelId, message_id := MessageId, seq := Seq} = Entry,
    {Read, Unread} = lists:partition(
        fun(UserId) -> is_read(UserId, ChannelId, MessageId, Reads) end, UserIds
    ),
    {Activated, Kept} = lists:partition(
        fun(UserId) -> became_active(UserId, Seq, Active) end, Unread
    ),
    State1 = bump(skipped_active, length(Activated), bump(truncations, length(Read), State)),
    case Kept of
        [] -> {skip, State1};
        UserIds -> {send, Entry, State1};
        _ -> {send, with_user_ids(Kept, Entry), State1}
    end.

-spec is_read(integer(), integer(), integer(), #{
    {integer(), integer()} => {integer(), integer()}
}) ->
    boolean().
is_read(UserId, ChannelId, MessageId, Reads) ->
    case maps:find({UserId, ChannelId}, Reads) of
        {ok, {ReadMessageId, _At}} -> MessageId =< ReadMessageId;
        error -> false
    end.

-spec became_active(integer(), non_neg_integer(), #{integer() => {non_neg_integer(), integer()}}) ->
    boolean().
became_active(UserId, Seq, Active) ->
    case maps:find(UserId, Active) of
        {ok, {ActiveSeq, _At}} -> ActiveSeq > Seq;
        error -> false
    end.

-spec with_user_ids([integer()], entry()) -> entry().
with_user_ids(UserIds, #{job := Job} = Entry) ->
    Rewritten = Job#{<<"user_ids">> => [integer_to_binary(UserId) || UserId <- UserIds]},
    Entry#{
        user_ids := UserIds,
        job := Rewritten,
        body := iolist_to_binary(json:encode(Rewritten))
    }.

-spec apply_read(integer(), integer(), integer(), state()) -> state().
apply_read(UserId, ChannelId, MessageId, #{reads := Reads} = State) ->
    Key = {UserId, ChannelId},
    Watermark =
        case maps:find(Key, Reads) of
            {ok, {Previous, _At}} -> max(Previous, MessageId);
            error -> MessageId
        end,
    State1 = State#{reads := Reads#{Key => {Watermark, now_ms()}}},
    Seqs = gb_sets:to_list(
        maps:get(ChannelId, maps:get(message_index, State1), gb_sets:empty())
    ),
    State2 = lists:foldl(
        fun(Seq, Acc) ->
            case gb_trees:lookup(Seq, maps:get(jobs, Acc)) of
                {value, Entry} -> truncate_entry(Seq, Entry, UserId, ChannelId, MessageId, Acc);
                none -> Acc
            end
        end,
        State1,
        Seqs
    ),
    note_inflight_read(UserId, ChannelId, MessageId, State2).

-spec note_inflight_read(integer(), integer(), integer(), state()) -> state().
note_inflight_read(UserId, ChannelId, MessageId, #{inflight := Inflight} = State) ->
    maps:fold(
        fun(Pid, {_MRef, _TRef, Entry}, Acc) ->
            note_followup(Pid, Entry, UserId, ChannelId, MessageId, Acc)
        end,
        State,
        Inflight
    ).

-spec note_followup(pid(), entry(), integer(), integer(), integer(), state()) -> state().
note_followup(
    Pid,
    #{
        kind := message,
        channel_id := ChannelId,
        message_id := JobMessageId,
        user_ids := UserIds
    },
    UserId,
    ChannelId,
    MessageId,
    State
) when JobMessageId =< MessageId ->
    case lists:member(UserId, UserIds) of
        false -> State;
        true -> record_followup(Pid, UserId, MessageId, State)
    end;
note_followup(_Pid, _Entry, _UserId, _ChannelId, _MessageId, State) ->
    State.

-spec record_followup(pid(), integer(), integer(), state()) -> state().
record_followup(Pid, UserId, MessageId, State) ->
    Followups = maps:get(followups, State, #{}),
    Reads = maps:get(Pid, Followups, #{}),
    Watermark = max(MessageId, maps:get(UserId, Reads, MessageId)),
    State#{followups => Followups#{Pid => Reads#{UserId => Watermark}}}.

-spec truncate_entry(non_neg_integer(), entry(), integer(), integer(), integer(), state()) ->
    state().
truncate_entry(
    Seq,
    #{kind := message, channel_id := ChannelId, message_id := JobMessageId} = Entry,
    UserId,
    ChannelId,
    MessageId,
    State
) when JobMessageId =< MessageId ->
    remove_reader(Seq, Entry, UserId, State);
truncate_entry(_Seq, _Entry, _UserId, _ChannelId, _MessageId, State) ->
    State.

-spec remove_reader(non_neg_integer(), entry(), integer(), state()) -> state().
remove_reader(Seq, #{user_ids := UserIds} = Entry, UserId, State) ->
    case lists:member(UserId, UserIds) of
        false ->
            State;
        true ->
            State1 = bump(truncations, 1, State),
            case lists:delete(UserId, UserIds) of
                [] ->
                    queued_remove(Seq, State1);
                Remaining ->
                    queued_put(with_user_ids(Remaining, Entry), State1)
            end
    end.

-spec record_active(integer(), state()) -> state().
record_active(UserId, #{active := Active, next_seq := Seq} = State) ->
    State#{active := Active#{UserId => {Seq, now_ms()}}, next_seq := Seq + 1}.

%% 启动受监控请求并选择单项或批传输协议。
-spec start_worker(entry(), state()) -> state().
start_worker(Entry, #{inflight := Inflight, request_timeout_ms := Timeout} = State) ->
    #{subject := Subject, body := Body} = Entry,
    Outbox = self(),
    %% 批封装使用逐项回复协议，单项路径保持原来的请求方式。
    {Pid, MRef} = spawn_monitor(
        fun() ->
            Result =
                case maps:is_key(batch_entries, Entry) of
                    true -> push_job_publisher:request_batch(Subject, Body, Timeout);
                    false -> send(Subject, Body, Timeout)
                end,
            Outbox ! {push_outbox_reply, self(), Result}
        end
    ),
    TRef = erlang:send_after(Timeout, Outbox, {request_deadline, Pid}),
    State#{inflight := Inflight#{Pid => {MRef, TRef, Entry}}}.

-spec send(binary(), binary(), pos_integer()) -> ok | {error, term()}.
send(Subject, Body, Timeout) ->
    try push_job_publisher:request(Subject, Body, Timeout) of
        ok -> ok;
        {error, Reason} -> {error, Reason}
    catch
        Class:Reason -> {error, {Class, Reason}}
    end.

-spec kill_expired_worker(pid(), state()) -> ok.
kill_expired_worker(Pid, #{inflight := Inflight}) ->
    case maps:is_key(Pid, Inflight) of
        true ->
            exit(Pid, kill),
            ok;
        false ->
            ok
    end.

%% 释放请求监控并处理逐项结果和后续清理。
-spec finish_worker(pid(), ok | {error, term()} | {batch_results, [map()]}, state()) -> state().
finish_worker(Pid, Result, #{inflight := Inflight} = State) ->
    case maps:take(Pid, Inflight) of
        {{MRef, TRef, Entry}, Rest} ->
            erlang:demonitor(MRef, [flush]),
            _ = erlang:cancel_timer(TRef, [{async, true}, {info, false}]),
            Followups = maps:get(followups, State, #{}),
            Reads = maps:get(Pid, Followups, #{}),
            State1 = State#{inflight := Rest, followups => maps:remove(Pid, Followups)},
            follow_up_clears(Entry, Reads, finish_entries(Result, Entry, State1));
        error ->
            State
    end.

%% 逐项匹配唯一回复并仅重试未确认任务。
-spec finish_entries(term(), entry(), state()) -> state().
finish_entries({batch_results, Results}, #{batch_entries := Entries}, State) ->
    %% 每个原始身份必须恰好匹配一次，成功兄弟不会随失败项重试。
    lists:foldl(
        fun(E, Acc) ->
            Id = maps:get(item_id, E),
            Matches = [R || #{<<"item_id">> := Key} = R <- Results, Key =:= Id],
            Result =
                case Matches of
                    [#{<<"ok">> := true}] ->
                        ok;
                    [#{<<"ok">> := false} = R] ->
                        {error, maps:get(<<"error">>, R, batch_item_failed)};
                    _ ->
                        {error, missing_or_duplicate_batch_result}
                end,
            handle_result(Result, E, Acc)
        end,
        State,
        Entries
    );
finish_entries(Result, #{batch_entries := Entries}, State) ->
    Failure =
        case Result of
            {error, _} -> Result;
            _ -> {error, invalid_batch_reply}
        end,
    lists:foldl(fun(E, Acc) -> handle_result(Failure, E, Acc) end, State, Entries);
finish_entries(Result, Entry, State) ->
    handle_result(Result, Entry, State).

-spec follow_up_clears(entry(), #{integer() => integer()}, state()) -> state().
follow_up_clears(_Entry, Reads, State) when map_size(Reads) =:= 0 ->
    State;
follow_up_clears(#{channel_id := ChannelId, message_id := AfterMessageId}, Reads, State) ->
    case push:clear_notifications_enabled() of
        true ->
            maps:fold(
                fun(UserId, MessageId, Acc) ->
                    follow_up_clear(UserId, ChannelId, MessageId, AfterMessageId, Acc)
                end,
                State,
                Reads
            );
        false ->
            State
    end.

-spec follow_up_clear(integer(), integer(), integer(), integer(), state()) -> state().
follow_up_clear(UserId, ChannelId, MessageId, AfterMessageId, State) ->
    case pending_followup(UserId, ChannelId, State) of
        {ok, Pid} ->
            record_followup(Pid, UserId, MessageId, State);
        none ->
            Job = push_job_publisher:clear_job(UserId, ChannelId, MessageId, AfterMessageId),
            bump(followup_clears, 1, admit(Job, State))
    end.

-spec pending_followup(integer(), integer(), state()) -> {ok, pid()} | none.
pending_followup(UserId, ChannelId, #{inflight := Inflight} = State) ->
    Pending = maps:filter(
        fun(Pid, Reads) ->
            is_map_key(UserId, Reads) andalso
                inflight_channel(Pid, Inflight) =:= {ok, ChannelId}
        end,
        maps:get(followups, State, #{})
    ),
    case maps:keys(Pending) of
        [Pid | _] -> {ok, Pid};
        [] -> none
    end.

-spec inflight_channel(pid(), #{pid() => {reference(), reference(), entry()}}) ->
    {ok, integer()} | error.
inflight_channel(Pid, Inflight) ->
    case maps:find(Pid, Inflight) of
        {ok, {_MRef, _TRef, #{channel_id := ChannelId}}} -> {ok, ChannelId};
        error -> error
    end.

%% 规范化请求结果并保留批次逐项结果。
-spec reply_result(term()) -> ok | {error, term()} | {batch_results, [map()]}.
reply_result({batch_results, Results}) when is_list(Results) -> {batch_results, Results};
reply_result(ok) -> ok;
reply_result({error, Reason}) -> {error, Reason};
reply_result(Other) -> {error, {invalid_worker_reply, Other}}.

-spec down_result(term()) -> {error, term()}.
down_result(killed) -> {error, timeout};
down_result(Reason) -> {error, {worker_down, Reason}}.

-spec handle_result(ok | {error, term()}, entry(), state()) -> state().
handle_result(ok, _Entry, State) ->
    bump(delivered, 1, State);
handle_result({error, Reason}, Entry, State) ->
    logger:debug("Push outbox request not delivered", #{
        reason => Reason,
        kind => maps:get(kind, Entry),
        message_id => maps:get(message_id, Entry),
        attempts => maps:get(attempts, Entry)
    }),
    case is_expired(Entry, State) of
        true -> drop_prepared(Entry, State);
        false -> schedule_retry(Entry, State)
    end.

-spec drop_prepared(entry(), state()) -> state().
drop_prepared(Entry, State) ->
    case prepare(Entry, State) of
        {skip, State1} -> State1;
        {send, Prepared, State1} -> drop_expired(Prepared, State1)
    end.

-spec schedule_retry(entry(), state()) -> state().
schedule_retry(#{seq := Seq, attempts := Attempts} = Entry, State) ->
    NextAttempts = Attempts + 1,
    _ = erlang:send_after(retry_delay(NextAttempts, State), self(), {retry, Seq}),
    State1 = queued_put(Entry#{attempts := NextAttempts}, State),
    shed_to_capacity(bump(retries, 1, State1)).

-spec retry_delay(pos_integer(), state()) -> pos_integer().
retry_delay(Attempts, #{retry_base_ms := Base}) ->
    Delay = min(?RETRY_MAX_MS, Base bsl min(Attempts - 1, 16)),
    Delay + rand:uniform(max(1, Delay div 4)).

-spec make_ready(non_neg_integer(), state()) -> state().
make_ready(Seq, #{jobs := Jobs, ready := Ready} = State) ->
    case gb_trees:is_defined(Seq, Jobs) of
        true -> State#{ready := queue:in(Seq, Ready)};
        false -> State
    end.

-spec is_expired(entry(), state()) -> boolean().
is_expired(#{enqueued_at := EnqueuedAt}, #{max_age_ms := MaxAge}) ->
    now_ms() - EnqueuedAt >= MaxAge.

-spec drop_expired(entry(), state()) -> state().
drop_expired(#{kind := Kind, user_ids := UserIds} = Entry, State) ->
    logger:warning("Push outbox job expired undelivered, dropping it", #{
        kind => Kind,
        channel_id => maps:get(channel_id, Entry),
        message_id => maps:get(message_id, Entry),
        attempts => maps:get(attempts, Entry),
        user_count => length(UserIds)
    }),
    count_dropped(Kind, expired, State).

-spec count_dropped(kind(), atom(), state()) -> state().
count_dropped(Kind, Reason, #{dropped := Dropped} = State) ->
    Key = {Kind, Reason},
    State#{dropped := Dropped#{Key => maps:get(Key, Dropped, 0) + 1}}.

-spec prune(state()) -> state().
prune(#{reads := Reads, active := Active, max_age_ms := MaxAge} = State) ->
    Cutoff = now_ms() - MaxAge,
    State#{
        reads := maps:filter(fun(_Key, {_MessageId, At}) -> At >= Cutoff end, Reads),
        active := maps:filter(fun(_UserId, {_Seq, At}) -> At >= Cutoff end, Active)
    }.

%% 汇总队列及逻辑任务在途统计。
-spec build_stats(state()) -> map().
build_stats(#{jobs := Jobs, inflight := Inflight, counters := Counters, dropped := Dropped}) ->
    maps:merge(
        #{
            delivered => 0,
            retries => 0,
            sheds => 0,
            truncations => 0,
            skipped_active => 0,
            followup_clears => 0,
            enqueued => 0
        },
        Counters#{
            depth => gb_trees:size(Jobs),
            inflight => lists:sum([
                length(logical_entries(E))
             || {_, _, E} <- maps:values(Inflight)
            ]),
            dropped => Dropped
        }
    ).

-spec bump(counter(), non_neg_integer(), state()) -> state().
bump(_Counter, 0, State) ->
    State;
bump(Counter, Increment, #{counters := Counters} = State) ->
    State#{counters := Counters#{Counter => maps:get(Counter, Counters, 0) + Increment}}.

-spec broadcast(term()) -> ok.
broadcast(Msg) ->
    abcast = gen_server:abcast(push_nodes(), ?MODULE, Msg),
    ok.

-spec push_nodes() -> [node()].
push_nodes() ->
    try gateway_node_router:active_nodes(push) of
        Nodes -> Nodes
    catch
        _:_ -> [node()]
    end.

-spec schedule_prune() -> reference().
schedule_prune() ->
    erlang:send_after(?PRUNE_INTERVAL_MS, self(), prune).

-spec now_ms() -> integer().
now_ms() ->
    erlang:monotonic_time(millisecond).

-spec env_pos_integer(atom(), pos_integer()) -> pos_integer().
env_pos_integer(Key, Default) ->
    case fluxer_gateway_env:get_optional(Key) of
        Value when is_integer(Value), Value > 0 -> Value;
        _ -> Default
    end.

-spec app_pos_integer(atom(), pos_integer()) -> pos_integer().
app_pos_integer(Key, Default) ->
    case application:get_env(fluxer_gateway, Key, undefined) of
        Value when is_integer(Value), Value > 0 -> Value;
        _ -> Default
    end.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

count(Counter, #{counters := Counters}) ->
    maps:get(Counter, Counters, 0).

an_expired_entry_is_dropped_without_the_users_who_read_it_test() ->
    State = test_state(#{{7, 20} => {30, now_ms()}}),
    Result = handle_result({error, timeout}, test_entry([7, 8]), State),
    ?assertEqual(#{{message, expired} => 1}, maps:get(dropped, Result)),
    ?assertEqual(1, count(truncations, Result)),
    ?assertEqual(0, count(retries, Result)).

an_expired_entry_every_recipient_read_is_not_counted_as_dropped_test() ->
    State = test_state(#{{7, 20} => {30, now_ms()}, {8, 20} => {31, now_ms()}}),
    Result = handle_result({error, timeout}, test_entry([7, 8]), State),
    ?assertEqual(#{}, maps:get(dropped, Result)),
    ?assertEqual(2, count(truncations, Result)).

an_expired_clear_is_dropped_and_counted_by_kind_test() ->
    State = test_state(#{{7, 20} => {30, now_ms()}, {8, 20} => {30, now_ms()}}),
    Entry = (test_entry([7, 8]))#{kind := clear},
    Result = handle_result({error, timeout}, Entry, State),
    ?assertEqual(#{{clear, expired} => 1}, maps:get(dropped, Result)),
    ?assertEqual(0, count(truncations, Result)).

a_failed_entry_within_its_age_is_retried_test() ->
    State = test_state(#{}),
    Entry = (test_entry([7]))#{enqueued_at := now_ms()},
    Result = handle_result({error, timeout}, Entry, State),
    ?assertEqual(#{}, maps:get(dropped, Result)),
    ?assertEqual(1, count(retries, Result)),
    ?assertEqual({value, Entry#{attempts := 4}}, gb_trees:lookup(0, maps:get(jobs, Result))).

an_entry_expired_at_dispatch_is_dropped_test() ->
    Result = dispatch(test_entry([7]), test_state(#{})),
    ?assertEqual(#{{message, expired} => 1}, maps:get(dropped, Result)),
    ?assertEqual(0, map_size(maps:get(inflight, Result))).

reported_drops_are_counted_by_kind_and_reason_test() ->
    {noreply, State1} = handle_cast({dropped, message, payload_too_large}, test_state(#{})),
    {noreply, State2} = handle_cast({dropped, message, payload_too_large}, State1),
    {noreply, State3} = handle_cast({dropped, ring, outbox_unavailable}, State2),
    ?assertEqual(
        #{{message, payload_too_large} => 2, {ring, outbox_unavailable} => 1},
        maps:get(dropped, build_stats(State3))
    ).

test_state(Reads) ->
    #{
        jobs => gb_trees:empty(),
        ready => queue:new(),
        inflight => #{},
        followups => #{},
        next_seq => 1,
        reads => Reads,
        active => #{},
        counters => #{},
        dropped => #{},
        max_queue => ?DEFAULT_MAX_QUEUE,
        max_inflight => ?DEFAULT_MAX_INFLIGHT,
        request_timeout_ms => ?DEFAULT_REQUEST_TIMEOUT_MS,
        max_age_ms => ?DEFAULT_MAX_AGE_MS,
        retry_base_ms => ?DEFAULT_RETRY_BASE_MS
    }.

test_entry(UserIds) ->
    #{
        kind => message,
        subject => <<"rpc.push.message">>,
        job => #{<<"user_ids">> => [integer_to_binary(UserId) || UserId <- UserIds]},
        body => <<"{}">>,
        user_ids => UserIds,
        channel_id => 20,
        message_id => 30,
        seq => 0,
        enqueued_at => now_ms() - ?DEFAULT_MAX_AGE_MS,
        attempts => 3
    }.


%% 验证连续清理分组遵守顺序屏障与批大小限制。
-spec clear_batch_mixed_fifo_and_limit_test() -> term().
clear_batch_mixed_fifo_and_limit_test() ->
    E = (test_entry([7]))#{kind := clear, enqueued_at := now_ms(), item_id => <<"a">>},
    S0 = test_state(#{}),
    S1 = lists:foldl(
        fun({Seq, Kind}, Acc) -> insert(E#{seq := Seq, kind := Kind}, Acc) end,
        S0,
        [{0, clear}, {1, clear}, {2, message}, {3, clear}]
    ),
    {Taken, S2} = take_clear_prefix(32, [], S1),
    ?assertEqual([0, 1], [maps:get(seq, X) || X <- Taken]),
    ?assertEqual({value, 2}, queue:peek(maps:get(ready, S2))),
    S3 = lists:foldl(fun(Seq, Acc) -> insert(E#{seq := Seq}, Acc) end, S0, lists:seq(0, 39)),
    {ThirtyTwo, S4} = take_clear_prefix(32, [], S3),
    ?assertEqual(32, length(ThirtyTwo)),
    ?assertEqual(8, gb_trees:size(maps:get(jobs, S4))),
    ?assertEqual({value, 32}, queue:peek(maps:get(ready, S4))).

%% 验证批次按逻辑任务占用容量并启动有限等待。
-spec clear_batch_logical_admission_and_aggregation_test() -> term().
clear_batch_logical_admission_and_aggregation_test() ->
    E = (test_entry([7]))#{kind := clear, enqueued_at := now_ms(), item_id => <<"a">>},
    Batch = E#{batch_entries => lists:duplicate(32, E)},
    S0 = (test_state(#{}))#{max_inflight := 96, clear_batch_enabled => true},
    S1 = S0#{inflight := #{self() => {make_ref(), make_ref(), Batch}}},
    ?assertEqual(32, inflight_items(S1)),
    S2 = pump_clear_batch(E, insert(E, S0)),
    ?assertEqual(0, inflight_items(S2)),
    ?assertEqual(1, gb_trees:size(maps:get(jobs, S2))),
    ?assert(is_reference(maps:get(clear_batch_timer, S2))),
    erlang:cancel_timer(maps:get(clear_batch_timer, S2)).

%% 验证部分失败、缺失、重复及超时只重试相应任务。
-spec clear_batch_partial_missing_duplicate_and_timeout_retry_test() -> term().
clear_batch_partial_missing_duplicate_and_timeout_retry_test() ->
    E = (test_entry([7]))#{
        kind := clear,
        enqueued_at := now_ms(),
        item_id => <<"a">>,
        job := #{
            <<"v">> => 1,
            <<"user_id">> => <<"7">>,
            <<"channel_id">> => <<"20">>,
            <<"message_id">> => <<"30">>,
            <<"after_message_id">> => <<"29">>
        }
    },
    E2 = E#{seq := 1, item_id := <<"b">>},
    E3 = E#{seq := 2, item_id := <<"c">>},
    Batch = E#{batch_entries => [E, E2, E3]},
    Good = #{<<"item_id">> => <<"a">>, <<"ok">> => true},
    Failed = #{
        <<"item_id">> => <<"b">>,
        <<"ok">> => false,
        <<"error">> => <<"rpc_unavailable">>
    },
    %% 成功项结算后，只将失败和缺失项放回重试队列。
    S = finish_entries({batch_results, [Good, Failed]}, Batch, test_state(#{})),
    ?assertEqual(1, count(delivered, S)),
    ?assertEqual(2, count(retries, S)),
    ?assertEqual(false, gb_trees:is_defined(0, maps:get(jobs, S))),
    Retried = gb_trees:get(1, maps:get(jobs, S)),
    ?assertEqual(<<"b">>, maps:get(item_id, Retried)),
    ?assertEqual(<<"29">>, maps:get(<<"after_message_id">>, maps:get(job, Retried))),
    Duplicate = finish_entries(
        {batch_results, [Good, Good]}, E#{batch_entries => [E]}, test_state(#{})
    ),
    ?assertEqual(1, count(retries, Duplicate)),
    ?assertEqual(0, count(delivered, Duplicate)),
    Timeout = finish_entries({error, timeout}, Batch, test_state(#{})),
    ?assertEqual(3, count(retries, Timeout)),
    ?assertEqual(0, count(delivered, Timeout)),
    Unversioned = finish_entries(ok, Batch, test_state(#{})),
    ?assertEqual(3, count(retries, Unversioned)),
    ?assertEqual(0, count(delivered, Unversioned)).

%% 验证手动未读清理保留各项原始边界。
-spec clear_batch_manual_unread_keeps_each_original_frontier_test() -> term().
clear_batch_manual_unread_keeps_each_original_frontier_test() ->
    S0 = test_state(#{{7, 20} => {100, now_ms()}}),
    E = (test_entry([7]))#{
        kind := clear,
        enqueued_at := now_ms(),
        item_id => <<"a">>,
        job := #{<<"message_id">> => <<"30">>, <<"after_message_id">> => <<"29">>}
    },
    E2 = E#{
        seq := 1,
        item_id := <<"b">>,
        job := #{<<"message_id">> => <<"28">>, <<"after_message_id">> => <<"27">>}
    },
    {Taken, _} = take_clear_prefix(32, [], insert(E2, insert(E, S0))),
    ?assertEqual([maps:get(job, E), maps:get(job, E2)], [maps:get(job, X) || X <- Taken]).

-endif.
