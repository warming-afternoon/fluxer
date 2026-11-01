%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(guild_thread_member_loader).
-export([run/3]).

%% 独立协调进程限制批次数，绑定调用者生命周期并按输入顺序收集完整结果。
-spec run([term()], pos_integer(), fun((term()) -> {ok, term()} | {error, term()})) ->
    {ok, [term()]} | {error, term()}.
run(Items, Limit, Fetch) when Limit >= 1, Limit =< 8 ->
    Parent = self(),
    Tag = make_ref(),
    {Pid, Monitor} = spawn_monitor(fun() ->
        process_flag(trap_exit, true),
        ParentMonitor = monitor(process, Parent),
        Result = collect(lists:enumerate(Items), #{}, #{}, Limit, Fetch, ParentMonitor),
        Parent ! {Tag, Result}
    end),
    receive
        {Tag, Result} ->
            demonitor(Monitor, [flush]),
            Result;
        {'DOWN', Monitor, process, Pid, Reason} ->
            {error, {member_coordinator_down, Reason}}
    end.

%% 每个空闲槽只启动一个子任务，worker异常不会留下部分成功结果。
-spec collect(list(), map(), map(), pos_integer(), function(), reference()) -> term().
collect([{Index, Item} | Rest], Active, Done, Limit, Fetch, ParentMonitor) when
    map_size(Active) < Limit
->
    Owner = self(),
    Pid = spawn_link(fun() ->
        Result =
            try
                Fetch(Item)
            catch
                C:R -> {error, {C, R}}
            end,
        Owner ! {member_batch_result, self(), Index, Result}
    end),
    collect(Rest, Active#{Pid => Index}, Done, Limit, Fetch, ParentMonitor);
collect([], Active, Done, _Limit, _Fetch, _ParentMonitor) when map_size(Active) =:= 0 ->
    {ok, [maps:get(Index, Done) || Index <- lists:seq(1, map_size(Done))]};
collect(Pending, Active, Done, Limit, Fetch, ParentMonitor) ->
    receive
        {member_batch_result, Pid, Index, {ok, Value}} when is_map_key(Pid, Active) ->
            case maps:get(Pid, Active) of
                Index ->
                    unlink(Pid),
                    collect(
                        Pending,
                        maps:remove(Pid, Active),
                        Done#{Index => Value},
                        Limit,
                        Fetch,
                        ParentMonitor
                    );
                _ ->
                    stop_workers(Active),
                    {error, invalid_member_batch_index}
            end;
        {member_batch_result, Pid, _Index, Error} when is_map_key(Pid, Active) ->
            stop_workers(Active),
            case Error of
                {error, _} -> Error;
                _ -> {error, invalid_member_batch_result}
            end;
        {'EXIT', Pid, Reason} when is_map_key(Pid, Active) ->
            stop_workers(Active),
            {error, {member_worker_down, Reason}};
        {'DOWN', ParentMonitor, process, _Parent, _Reason} ->
            stop_workers(Active),
            {error, member_load_parent_down};
        _Other ->
            collect(Pending, Active, Done, Limit, Fetch, ParentMonitor)
    end.

%% 协调进程结束前终止所有未完成任务，调用者不接收失效结果。
-spec stop_workers(map()) -> ok.
stop_workers(Active) ->
    maps:foreach(fun(Pid, _Index) -> exit(Pid, kill) end, Active),
    ok.
