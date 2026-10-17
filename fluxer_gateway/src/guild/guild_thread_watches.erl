%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_thread_watches).
-typing([eqwalizer]).

-export([
    update/2,
    fetch/1,
    fetched/3,
    resolve/4,
    sweep/2,
    clear/1,
    remove_session/2,
    remove_thread/2,
    watching/3,
    sessions/2,
    context/2,
    event/3,
    export/1,
    restore/1
]).

%% 初始化独立浏览状态，清理定时器由服务器进程统一持有
-spec ensure(map()) -> map().
ensure(#{thread_watch_store := _} = State) ->
    State;
ensure(State) ->
    Token = make_ref(),
    erlang:send_after(10000, self(), {thread_watch_sweep, Token}),
    State#{
        thread_watch_store => guild_thread_watch_store:new(), thread_watch_sweep_token => Token
    }.

%% 在服务器进程内处理订阅，元数据缺失时异步批量读取
-spec update(map(), map()) -> map().
update(#{session_id := Sid, session_pid := Pid, user_id := UserId} = Request, State0) ->
    Started = erlang:monotonic_time(microsecond),
    State = ensure(State0),
    Tab = maps:get(thread_watch_store, State),
    cancel_pending(Tab, Sid),
    Next =
        case maps:get(Sid, maps:get(sessions, State, #{}), undefined) of
            #{pid := Pid, user_id := UserId} = Session ->
                case guild_thread_gate:session_viewer(Session) of
                    true ->
                        prepare(Request, State);
                    false ->
                        reject(Request, State),
                        State
                end;
            _ ->
                reject(Request, State),
                State
        end,
    guild_thread_watch_metrics:record(updates, 1),
    guild_thread_watch_metrics:record(
        processing_microseconds,
        erlang:monotonic_time(microsecond) - Started
    ),
    Next.

%% 已有上下文直接复用，多个会话的同帖缺失合并成一个查询
-spec prepare(map(), map()) -> map().
prepare(#{session_id := Sid, ids := Ids} = Request, State) ->
    Tab = maps:get(thread_watch_store, State),
    Missing = [Id || Id <- Ids, context(Id, State) =:= undefined],
    guild_thread_watch_metrics:record(metadata_hits, length(Ids) - length(Missing)),
    guild_thread_watch_metrics:record(metadata_misses, length(Missing)),
    case Missing of
        [] ->
            commit(Request, State),
            State;
        _ ->
            ets:insert(Tab, {{r, Sid, 0}, Request#{missing => Missing}}),
            lists:foreach(
                fun(Id) ->
                    ets:insert(Tab, {{w, Id, Sid}, true}),
                    ets:insert_new(Tab, {{f, Id, 0}, queued})
                end,
                Missing
            ),
            schedule_fetch(State)
    end.

%% 每个服务器最多一个批量元数据请求，常规续期不走此路径
-spec schedule_fetch(map()) -> map().
schedule_fetch(#{thread_watch_fetch := _} = State) ->
    State;
schedule_fetch(State) ->
    self() ! thread_watch_fetch,
    State#{thread_watch_fetch => scheduled}.

%% 从帖子前缀索引取有界批次，快速切换不会留下历史队列节点
-spec fetch(map()) -> map().
fetch(#{thread_watch_fetch := scheduled, thread_watch_store := Tab} = State) ->
    Ids =
        case ets:select(Tab, [{{{f, '$1', 0}, queued}, [], ['$1']}], 100) of
            '$end_of_table' -> [];
            {Batch, _Continuation} -> Batch
        end,
    case Ids of
        [] ->
            maps:remove(thread_watch_fetch, State);
        _ ->
            Ref = make_ref(),
            guild_thread_watch_metrics:record(metadata_fetches, 1),
            lists:foreach(fun(Id) -> ets:insert(Tab, {{f, Id, 0}, Ref}) end, Ids),
            Owner = self(),
            GuildId = maps:get(id, State),
            spawn(fun() ->
                Result =
                    try
                        rpc_client:call(#{
                            <<"type">> => <<"thread_watch_contexts">>,
                            <<"guild_id">> => integer_to_binary(GuildId),
                            <<"thread_ids">> => [integer_to_binary(Id) || Id <- Ids]
                        })
                    catch
                        Class:Reason -> {error, {Class, Reason}}
                    end,
                Owner ! {thread_watch_fetched, Ref, {Ids, Result}}
            end),
            State#{thread_watch_fetch => Ref}
    end;
fetch(State) ->
    State.

%% 合并查询结果，只唤醒等待本批帖子的请求
-spec fetched(reference(), tuple(), map()) -> map().
fetched(
    Ref,
    {Ids, {error, _Reason}},
    #{thread_watch_fetch := Ref, thread_watch_store := Tab} = State
) ->
    guild_thread_watch_metrics:record(metadata_failures, 1),
    %% 暂时查询失败保留旧租约，不能把网络故障解释成帖子不存在
    resolve_batch(Ref, Ids, error, Tab, State, 256);
fetched(Ref, {Ids, Result}, #{thread_watch_fetch := Ref, thread_watch_store := Tab} = State) ->
    Threads =
        case Result of
            {ok, #{<<"threads">> := Rows}} when is_list(Rows) ->
                maps:from_list([{snowflake_id:parse(maps:get(<<"id">>, T)), T} || T <- Rows]);
            _ ->
                #{}
        end,
    lists:foreach(
        fun(Id) ->
            case ets:lookup(Tab, {f, Id, 0}) of
                [{_, Ref}] ->
                    Thread = maps:get(Id, Threads, #{invalid => true}),
                    guild_thread_watch_store:put_context(Tab, Id, Thread),
                    ok;
                _ ->
                    ok
            end
        end,
        Ids
    ),
    resolve_batch(Ref, Ids, ok, Tab, State, 256);
fetched(_Ref, _Result, State) ->
    State.

%% 分批唤醒大量同帖请求，在批次之间让出服务器消息处理机会
-spec resolve(reference(), [integer()], ok | error, map()) -> map().
resolve(Ref, Ids, Outcome, #{thread_watch_fetch := Ref, thread_watch_store := Tab} = State) ->
    resolve_batch(Ref, Ids, Outcome, Tab, State, 256);
resolve(_Ref, _Ids, _Outcome, State) ->
    State.

%% 每个回调最多处理固定数量等待会话，使用索引继续读取剩余请求
-spec resolve_batch(
    reference(), [integer()], ok | error, ets:table(), map(), non_neg_integer()
) -> map().
resolve_batch(_Ref, [], _Outcome, _Tab, State, _Budget) ->
    schedule_fetch(maps:remove(thread_watch_fetch, State));
resolve_batch(Ref, Ids, Outcome, _Tab, State, 0) ->
    self() ! {thread_watch_resolve, Ref, Ids, Outcome},
    State;
resolve_batch(Ref, [Id | Rest] = Ids, Outcome, Tab, State, Budget) ->
    Match = [{{{w, Id, '$1'}, true}, [], ['$1']}],
    case ets:select(Tab, Match, Budget) of
        '$end_of_table' ->
            ets:delete(Tab, {f, Id, 0}),
            release_unused(Tab, Id),
            resolve_batch(Ref, Rest, Outcome, Tab, State, Budget);
        {Sids, _Continuation} ->
            lists:foreach(
                fun(Sid) ->
                    case Outcome of
                        ok -> resolved(Tab, Sid, Id, State);
                        error -> fail_pending(Tab, Sid, State)
                    end
                end,
                Sids
            ),
            resolve_batch(Ref, Ids, Outcome, Tab, State, Budget - length(Sids))
    end.

%% 失败只取消等待状态，已有租约及其期限保持不变
-spec fail_pending(ets:table(), binary(), map()) -> ok.
fail_pending(Tab, Sid, State) ->
    case ets:lookup(Tab, {r, Sid, 0}) of
        [{_, Request}] ->
            cancel_pending(Tab, Sid),
            Previous = guild_thread_watch_store:ids(Tab, Sid, erlang:system_time(millisecond)),
            send_failure(Request, Previous, State);
        [] ->
            ok
    end.

%% 最后一个缺失帖子返回后才提交该会话的集合
-spec resolved(ets:table(), binary(), integer(), map()) -> ok.
resolved(Tab, Sid, Id, State) ->
    ets:delete(Tab, {w, Id, Sid}),
    case ets:lookup(Tab, {r, Sid, 0}) of
        [{_, #{missing := Missing} = Request}] ->
            case lists:delete(Id, Missing) of
                [] ->
                    ets:delete(Tab, {r, Sid, 0}),
                    AllIds = maps:get(ids, Request),
                    lists:foreach(
                        fun(Tid) ->
                            ets:delete(Tab, {w, Tid, Sid}),
                            ets:delete(Tab, {h, Tid, Sid})
                        end,
                        AllIds
                    ),
                    commit(Request, State),
                    lists:foreach(fun(Tid) -> release_unused(Tab, Tid) end, AllIds);
                Rest ->
                    ets:insert(Tab, {{h, Id, Sid}, true}),
                    ets:insert(Tab, {{r, Sid, 0}, Request#{missing => Rest}}),
                    ok
            end;
        [] ->
            ok
    end.

%% 权限检查和安装关系在同一进程内完成，确认后才允许前端补拉
-spec commit(map(), map()) -> ok.
commit(
    #{session_id := Sid, session_pid := Pid, ids := Ids, expires := Expires} = Request, State
) ->
    Tab = maps:get(thread_watch_store, State),
    Session = maps:get(Sid, maps:get(sessions, State, #{}), undefined),
    ValidSession =
        is_map(Session) andalso maps:get(pid, Session, undefined) =:= Pid andalso
            maps:get(pending_connect, Session, false) =/= true andalso
            guild_thread_gate:session_viewer(Session) andalso guild_thread_gate:active(State),
    case ValidSession andalso Expires > erlang:system_time(millisecond) of
        false ->
            reject(Request, State);
        true ->
            Accepted = [Id || Id <- Ids, allowed(Session, context(Id, State), State)],
            %% 保存活动缓存中的上下文，以支持后续归档和缓存淘汰
            lists:foreach(
                fun(Id) ->
                    guild_thread_watch_store:put_context(Tab, Id, context(Id, State))
                end,
                Accepted
            ),
            Resync = guild_thread_watch_store:replace(Tab, Sid, Accepted, Expires),
            acknowledge(Request, Accepted, Resync, State)
    end.

%% 浏览只允许真实论坛或媒体帖子，不能把临时关系当作访问权限
-spec allowed(map(), map() | undefined, map()) -> boolean().
allowed(_Session, undefined, _State) ->
    false;
allowed(Session, #{<<"type">> := 11} = Thread, State) ->
    ParentId = guild_thread_permissions:parent_id(Thread),
    Parent = guild_permissions_check:find_channel_by_id(ParentId, State),
    case Parent of
        #{<<"type">> := Type} when Type =:= 15; Type =:= 16 ->
            {CanView, _} = guild_thread_gate:thread_view_access(Session, Thread, State, #{}),
            CanView;
        _ ->
            false
    end;
allowed(_Session, _Thread, _State) ->
    false.

%% 返回最终接受集合和租约，拒绝的帖子不泄露额外信息
-spec acknowledge(map(), [integer()], [integer()], map()) -> ok.
acknowledge(Request, Ids, Resync, State) ->
    gen_server:cast(
        maps:get(session_pid, Request),
        {thread_watch_ack, #{
            generation => maps:get(generation, Request),
            <<"nonce">> => maps:get(nonce, Request),
            <<"ok">> => true,
            <<"guild_id">> => integer_to_binary(maps:get(id, State)),
            <<"thread_ids">> => [integer_to_binary(Id) || Id <- Ids],
            <<"resync_thread_ids">> => [integer_to_binary(Id) || Id <- Resync],
            <<"expires_at">> => maps:get(expires, Request)
        }}
    ),
    ok.

%% 会话不可用时清空确认集合，客户端不得误认为订阅成功
-spec reject(map(), map()) -> ok.
reject(Request, State) ->
    acknowledge(Request, [], [], State).

%% 向客户端报告可重试失败，旧订阅仍按原期限有效
-spec send_failure(map(), [integer()], map()) -> ok.
send_failure(Request, Previous, State) ->
    gen_server:cast(
        maps:get(session_pid, Request),
        {thread_watch_ack, #{
            generation => maps:get(generation, Request),
            <<"nonce">> => maps:get(nonce, Request),
            <<"ok">> => false,
            <<"code">> => <<"THREAD_WATCH_UNAVAILABLE">>,
            <<"guild_id">> => integer_to_binary(maps:get(id, State)),
            <<"thread_ids">> => [integer_to_binary(Id) || Id <- Previous]
        }}
    ),
    ok.

%% 取消被较新请求替代的异步等待
-spec cancel_pending(ets:table(), binary()) -> ok.
cancel_pending(Tab, Sid) ->
    case ets:take(Tab, {r, Sid, 0}) of
        [{_, #{ids := Missing}}] ->
            lists:foreach(
                fun(Id) ->
                    ets:delete(Tab, {w, Id, Sid}),
                    ets:delete(Tab, {h, Id, Sid}),
                    release_unused(Tab, Id)
                end,
                Missing
            );
        [] ->
            ok
    end,
    ok.

%% 同时没有浏览者和待处理请求时释放缓存
-spec release_unused(ets:table(), integer()) -> ok.
release_unused(Tab, Id) ->
    case
        {
            ets:next(Tab, {t, Id, <<>>}),
            ets:next(Tab, {w, Id, <<>>}),
            ets:next(Tab, {h, Id, <<>>})
        }
    of
        {{t, Id, _}, _, _} ->
            ok;
        {_, {w, Id, _}, _} ->
            ok;
        {_, _, {h, Id, _}} ->
            ok;
        _ ->
            ets:delete(Tab, {c, Id, 0}),
            %% 仅删除尚未发出的查询，已在途批次继续供其他会话复用
            ets:select_delete(Tab, [{{{f, Id, 0}, queued}, [], [true]}]),
            ok
    end.

%% 每次处理有界批次，到期关系不依赖清理及时性停止投递
-spec sweep(reference(), map()) -> map().
sweep(Token, #{thread_watch_store := Tab, thread_watch_sweep_token := Token} = State) ->
    More = guild_thread_watch_store:sweep(Tab, erlang:system_time(millisecond), 1000),
    Delay =
        case More of
            true -> 1;
            false -> 10000
        end,
    erlang:send_after(Delay, self(), {thread_watch_sweep, Token}),
    State;
sweep(_Token, State) ->
    State.

%% 功能关闭时释放所有浏览数据，迟到的异步结果无法恢复旧关系
-spec clear(map()) -> map().
clear(#{thread_watch_store := Tab} = State) ->
    ets:delete(Tab),
    maps:without(
        [thread_watch_store, thread_watch_fetch, thread_watch_sweep_token],
        State
    );
clear(State) ->
    State.

%% 连接结束时移除该会话的少量关系及异步请求
-spec remove_session(binary(), map()) -> map().
remove_session(Sid, #{thread_watch_store := Tab} = State) ->
    cancel_pending(Tab, Sid),
    guild_thread_watch_store:remove_session(Tab, Sid),
    State;
remove_session(_Sid, State) ->
    State.

%% 帖子删除后使正在读取的上下文失效
-spec remove_thread(integer(), map()) -> map().
remove_thread(Id, #{thread_watch_store := Tab} = State) ->
    ets:delete(Tab, {f, Id, 0}),
    guild_thread_watch_store:put_context(Tab, Id, #{invalid => true}),
    Waiting = ets:select(Tab, [{{{w, Id, '$1'}, '_'}, [], ['$1']}]),
    lists:foreach(fun(Sid) -> resolved(Tab, Sid, Id, State) end, Waiting),
    guild_thread_watch_store:remove_thread(Tab, Id),
    State;
remove_thread(_Id, State) ->
    State.

%% 精确判断浏览资格，功能关闭时立即失效
-spec watching(binary(), integer(), map()) -> boolean().
watching(Sid, Id, State) ->
    guild_thread_gate:active(State) andalso
        guild_thread_watch_store:watching(
            maps:get(thread_watch_store, State, undefined),
            Sid,
            Id,
            erlang:system_time(millisecond)
        ).

%% 获取当前帖子的浏览会话标识
-spec sessions(integer(), map()) -> [binary()].
sessions(Id, State) ->
    guild_thread_watch_store:sessions(
        maps:get(thread_watch_store, State, undefined),
        Id,
        erlang:system_time(millisecond)
    ).

%% 优先使用活动缓存，否则读取浏览上下文
-spec context(integer(), map()) -> map() | undefined.
context(Id, State) ->
    case guild_thread_gate:thread(Id, State) of
        undefined ->
            guild_thread_watch_store:context(
                maps:get(thread_watch_store, State, undefined), Id
            );
        Thread ->
            Thread
    end.

%% 更新被浏览帖子的缓存，不把它插入活动目录
-spec event(atom(), map(), map()) -> map().
event(Event, Data, #{thread_watch_store := Tab} = State) when Event =:= thread_update ->
    Id = snowflake_id:parse(maps:get(<<"id">>, Data)),
    case guild_thread_watch_store:context(Tab, Id) of
        Thread when is_map(Thread) ->
            guild_thread_watch_store:put_context(Tab, Id, maps:merge(Thread, Data));
        _ ->
            ok
    end,
    State;
event(_Event, _Data, State) ->
    State.

%% 仅在受控迁移路径导出未过期租约
-spec export(map()) -> [tuple()].
export(State) ->
    guild_thread_watch_store:export(
        maps:get(thread_watch_store, State, undefined),
        erlang:system_time(millisecond)
    ).

%% 迁移恢复保留原租约期限，不重放续租请求
-spec restore(map()) -> map().
restore(#{thread_watch_handoff := Rows} = State0) ->
    State = ensure(maps:remove(thread_watch_handoff, State0)),
    guild_thread_watch_store:restore(
        maps:get(thread_watch_store, State),
        Rows,
        maps:get(sessions, State, #{})
    ),
    State;
restore(State) ->
    State.
