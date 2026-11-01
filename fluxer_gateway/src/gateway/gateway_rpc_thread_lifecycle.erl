%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(gateway_rpc_thread_lifecycle).
-typing([eqwalizer]).
-export([handle/2, load_reserved/3]).

%% 外部调用只允许删除准备，所有内部phase和ETS字段均重新构造。
-spec handle(binary(), map()) -> map().
handle(<<"guild.prepare_thread_lifecycle">>, P) ->
    GuildId = validation:snowflake_or_throw(<<"guild_id">>, maps:get(<<"guild_id">>, P)),
    ThreadId = validation:snowflake_or_throw(<<"thread_id">>, maps:get(<<"thread_id">>, P)),
    Version = maps:get(<<"state_version">>, P),
    case maps:get(<<"operation">>, P) =:= <<"delete">> andalso
        is_integer(Version) andalso Version >= 0 of
        false -> gateway_rpc_error:raise(<<"invalid_thread_lifecycle_request">>);
        true ->
            Base = #{guild_id => GuildId, thread_id => ThreadId,
                version => Version, operation => delete},
            Request = case maps:get(<<"ticket">>, P, undefined) of
                undefined -> Base#{phase => reserve};
                Ticket0 when is_binary(Ticket0), byte_size(Ticket0) >= 24, byte_size(Ticket0) =< 128 ->
                    Base#{phase => reuse, ticket => Ticket0};
                _ -> gateway_rpc_error:raise(<<"invalid_thread_lifecycle_ticket">>)
            end,
            gateway_rpc_guild_infra:with_guild(GuildId, fun(Pid) ->
                case guild_query_handler:call(Pid, {prepare_thread_lifecycle, Request}, 250) of
                    #{<<"ticket">> := Ticket, <<"ready">> := true} -> #{<<"ticket">> => Ticket};
                    #{<<"ticket">> := Ticket} ->
                        load_reserved(Pid, Request, Ticket);
                    {error, thread_lifecycle_ticket_expired} ->
                        gateway_rpc_error:raise(<<"thread_lifecycle_ticket_expired">>);
                    _ -> gateway_rpc_error:raise(<<"thread_lifecycle_busy">>)
                end
            end)
    end.

%% RPC工作进程或取消归档工作进程负责等待，不能在guild owner调用此函数。
-spec load_reserved(pid(), map(), binary()) -> map().
load_reserved(GuildPid, Request, Ticket) ->
    case guild_thread_lifecycle:start_snapshot(GuildPid, Request, Ticket) of
        {ok, Snapshot} ->
            try guild_query_handler:call(GuildPid,
                {prepare_thread_lifecycle, #{phase => install, ticket => Ticket, snapshot => Snapshot}}, 500) of
                #{<<"ticket">> := Ticket} = Result -> Result;
                _ ->
                    maps:get(keeper, Snapshot) ! {cleanup, Ticket},
                    cancel(GuildPid, Request, Ticket),
                    gateway_rpc_error:raise(<<"thread_lifecycle_snapshot_rejected">>)
            catch Class:Reason:Stack ->
                maps:get(keeper, Snapshot) ! {cleanup, Ticket},
                cancel(GuildPid, Request, Ticket),
                erlang:raise(Class, Reason, Stack)
            end;
        {error, _Reason} ->
            cancel(GuildPid, Request, Ticket),
            gateway_rpc_error:raise(<<"thread_lifecycle_prepare_failed">>)
    end.

%% 失败取消只引用已有秘密票据；恢复失败必须触发全量读取而非发布空成员。
-spec cancel(pid(), map(), binary()) -> ok.
cancel(GuildPid, Request, Ticket) ->
    _ = catch guild_query_handler:call(GuildPid,
        {prepare_thread_lifecycle, #{phase => cancel, ticket => Ticket,
            operation => maps:get(operation, Request)}}, 1000),
    ok.
