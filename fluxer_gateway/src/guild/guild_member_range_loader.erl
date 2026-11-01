%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(guild_member_range_loader).
-typing([eqwalizer]).
-export([run/5]).

-define(RETRIES, 1).

%% 每个任务独占一个不相交区间，只在已完成页之后拆分尚未读取的后缀。
-spec run(integer(), pos_integer(), function(), function(), integer()) ->
    {ok, [map()]} | {error, term()}.
run(GuildId, Limit, Page, Probe, Deadline) when is_integer(Limit), Limit >= 1, Limit =< 8 ->
    Parent = self(), Tag = make_ref(),
    {Pid, Ref} = spawn_monitor(fun() ->
        ParentRef = monitor(process, Parent),
        State = #{guild => GuildId, limit => Limit, page => Page, probe => Probe,
            deadline => Deadline, parent_ref => ParentRef, active => #{},
            pending => [#{id => 1, lower => undefined, upper => undefined, probe => false, attempt => 0}],
            chunks => [], next_id => 2, probes_left => Limit * 64},
        Parent ! {Tag, collect(State)}
    end),
    receive
        {Tag, Result} -> demonitor(Ref, [flush]), Result;
        {'DOWN', Ref, process, Pid, Reason} -> {error, {member_load_coordinator_down, Reason}}
    end.

%% 页任务与探针共用原有并发槽，探针不超过一个，不复制活动cursor链。
-spec fill(map()) -> map().
fill(#{pending := []} = State) -> State;
fill(#{active := Active, limit := Limit} = State) when map_size(Active) >= Limit -> State;
fill(#{pending := [Job | Rest], active := Active, limit := Limit} = State) ->
    Probing = lists:any(fun(#{kind := Kind}) -> Kind =:= probe end, maps:values(Active)),
    Free = Limit - map_size(Active),
    Kind = case maps:get(probe, Job) andalso maps:get(probes_left, State) > 0 andalso
        not Probing andalso Free >= 2 andalso length(Rest) + 1 < Free of
        true -> probe;
        false -> page
    end,
    Tag = make_ref(), Owner = self(), Fetch = maps:get(Kind, State),
    {Pid, Ref} = spawn_monitor(fun() ->
        Result = try Fetch({maps:get(lower, Job), maps:get(upper, Job)})
            catch C:R -> {error, {callback_exception, C, R}} end,
        Owner ! {member_result, Tag, self(), Result}
    end),
    Left = maps:get(probes_left, State) - case Kind of probe -> 1; page -> 0 end,
    fill(State#{pending => Rest, probes_left => Left,
        active => Active#{Tag => #{pid => Pid, ref => Ref, kind => Kind, job => Job}}}).

%% 只有完整成功才发布列表；超时、调用者退出或任一永久页错误均终止全组。
-spec collect(map()) -> {ok, [map()]} | {error, term()}.
collect(State0) ->
    case maps:get(deadline, State0) > erlang:monotonic_time(millisecond) of
        false -> stop(State0, member_load_deadline);
        true -> collect_ready(State0)
    end.

%% 截止时间通过之后才派发新任务或发布完整结果。
-spec collect_ready(map()) -> {ok, [map()]} | {error, term()}.
collect_ready(State0) ->
    State = fill(State0), Active = maps:get(active, State),
    case {maps:get(pending, State), map_size(Active)} of
        {[], 0} ->
            Chunks = lists:keysort(1, maps:get(chunks, State)),
            {ok, lists:append([Rows || {_Lower, Rows} <- Chunks])};
        _ ->
            Remaining = maps:get(deadline, State) - erlang:monotonic_time(millisecond),
            case Remaining > 0 of
                false -> stop(State, member_load_deadline);
                true -> await(State, Remaining)
            end
    end.

%% 每个结果携带独立任务引用，迟到结果不会被归入重试或新拆分任务。
-spec await(map(), integer()) -> {ok, [map()]} | {error, term()}.
await(#{active := Active, parent_ref := ParentRef} = State, Remaining) ->
    receive
        {member_result, Tag, Pid, Result} ->
            case maps:take(Tag, Active) of
                {#{pid := Pid, ref := Ref} = Task, Rest} ->
                    demonitor(Ref, [flush]),
                    handle_result(Task, Result, State#{active => Rest});
                _ -> collect(State)
            end;
        {'DOWN', ParentRef, process, _Pid, _Reason} -> stop(State, member_load_parent_down);
        {'DOWN', Ref, process, _Pid, Reason} ->
            Found = [{Tag, T} || {Tag, #{ref := R} = T} <- maps:to_list(Active), R =:= Ref],
            case Found of
                [{Tag, Task}] -> handle_result(Task, {error, {worker_down, Reason}},
                    State#{active => maps:remove(Tag, Active)});
                [] -> collect(State)
            end
    after Remaining -> stop(State, member_load_deadline)
    end.

%% 页提交只追加一次；重试保持相同区间与cursor，未提交的页最多重试一次。
-spec handle_result(map(), term(), map()) -> {ok, [map()]} | {error, term()}.
handle_result(#{kind := page, job := Job}, {ok, Rows, Next}, State) when is_list(Rows) ->
    Lower = case maps:get(lower, Job) of undefined -> 0; Value -> Value end,
    Upper = maps:get(upper, Job),
    ValidNext = Next =:= null orelse (is_integer(Next) andalso Next > Lower andalso
        (Upper =:= undefined orelse Next =< Upper)),
    case ValidNext of
        false -> stop(State, invalid_member_page_cursor);
        true -> commit_page(Job, Rows, Next, Lower, State)
    end;
handle_result(#{kind := page, job := Job}, {error, {retryable, Reason}}, State) ->
    Attempt = maps:get(attempt, Job),
    case Attempt < ?RETRIES of
        true ->
            collect(State#{pending => [Job#{attempt => Attempt + 1, probe => false} | maps:get(pending, State)]});
        false -> stop(State, {member_page_retries_exhausted, Reason})
    end;
handle_result(#{kind := probe, job := Job}, Result, State) ->
    case split(Job, Result, maps:get(next_id, State)) of
        {ok, Left, Right} ->
            collect(State#{pending => maps:get(pending, State) ++ [Left, Right],
                next_id => maps:get(next_id, State) + 2});
        none ->
            collect(State#{pending => maps:get(pending, State) ++ [Job#{probe => false}]})
    end;
handle_result(_Task, Error, State) -> stop(State, {member_page_failed, Error}).

%% 数据页只在完整验证和单次任务结果之后提交，不复制或重新排序完整成员map。
-spec commit_page(map(), [map()], term(), integer(), map()) -> {ok, [map()]} | {error, term()}.
commit_page(Job, Rows, Next, Lower, State) ->
    Chunks = case Rows of [] -> maps:get(chunks, State); _ -> [{Lower, Rows} | maps:get(chunks, State)] end,
    Pending = maps:get(pending, State),
    NextPending = case Next of
        null -> Pending;
        Cursor when is_integer(Cursor), Cursor > Lower ->
            Pending ++ [Job#{lower => Cursor, probe => true, attempt => 0}]
    end,
    collect(State#{chunks => Chunks, pending => NextPending}).

%% 端点只选择pivot，不作为覆盖边界；空、失效和错误探针都回退原区间分页。
-spec split(map(), term(), pos_integer()) -> {ok, map(), map()} | none.
split(#{lower := Lower, upper := Upper} = Job, {ok, Min, Max}, Id) when
    is_integer(Min), is_integer(Max), Min > 0, Min < Max
->
    Pivot = Min + ((Max - Min) div 2),
    LowerOk = Lower =:= undefined orelse Min > Lower,
    UpperOk = Upper =:= undefined orelse Max =< Upper,
    case LowerOk andalso UpperOk andalso
        (Lower =:= undefined orelse Pivot > Lower) andalso
        (Upper =:= undefined orelse Pivot < Upper) of
        true -> {ok, Job#{id => Id, upper => Pivot, probe => false, attempt => 0},
            Job#{id => Id + 1, lower => Pivot, probe => false, attempt => 0}};
        false -> none
    end;
split(_Job, _Result, _Id) -> none.

%% 失败路径不返回已提交chunk，停止全部未完成的只读worker并清理monitor。
-spec stop(map(), term()) -> {error, term()}.
stop(State, Reason) ->
    maps:foreach(fun(_Tag, #{pid := Pid, ref := Ref}) ->
        exit(Pid, kill), demonitor(Ref, [flush])
    end, maps:get(active, State)),
    {error, Reason}.
