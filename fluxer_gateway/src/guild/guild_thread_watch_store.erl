%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_thread_watch_store).
-typing([eqwalizer]).

-export([
    new/0,
    replace/4,
    ids/3,
    watching/4,
    sessions/3,
    remove_session/2,
    remove_thread/2,
    context/2,
    put_context/3,
    sweep/3,
    export/2,
    restore/3
]).

%% 创建独立索引，续期不会改动在线会话映射
-spec new() -> ets:table().
new() ->
    Tab = ets:new(?MODULE, [ordered_set, protected]),
    ets:insert(Tab, {{z, leases, 0}, 0}),
    guild_thread_watch_metrics:register(Tab),
    Tab.

%% 按会话替换浏览集合，并返回需要重新同步的帖子
-spec replace(ets:table(), binary(), [integer()], integer()) -> [integer()].
replace(Tab, Sid, ThreadIds, Expires) ->
    Now = erlang:system_time(millisecond),
    Previous = ids(Tab, Sid, Now),
    Contexts = [{Id, context(Tab, Id)} || Id <- ThreadIds],
    remove_session(Tab, Sid),
    lists:foreach(
        fun(Id) ->
            ets:insert(Tab, [
                {{s, Sid, Id}, Expires},
                {{t, Id, Sid}, Expires},
                {{e, Expires, {Sid, Id}}, true}
            ])
        end,
        ThreadIds
    ),
    lists:foreach(
        fun
            ({Id, Thread}) when is_map(Thread) -> put_context(Tab, Id, Thread);
            (_) -> ok
        end,
        Contexts
    ),
    ets:update_counter(Tab, {z, leases, 0}, length(ThreadIds)),
    [Id || Id <- ThreadIds, not lists:member(Id, Previous)].

%% 只遍历当前会话的小集合
-spec ids(ets:table(), binary(), integer()) -> [integer()].
ids(Tab, Sid, Now) ->
    ets:select(Tab, [{{{s, Sid, '$1'}, '$2'}, [{'>', '$2', Now}], ['$1']}]).

%% 查询精确关系时仍校验有效期
-spec watching(ets:table() | undefined, binary(), integer(), integer()) -> boolean().
watching(undefined, _Sid, _Id, _Now) ->
    false;
watching(Tab, Sid, Id, Now) ->
    case ets:lookup(Tab, {s, Sid, Id}) of
        [{_, Expires}] -> Expires > Now;
        [] -> false
    end.

%% 通过帖子前缀索引查找浏览会话
-spec sessions(ets:table() | undefined, integer(), integer()) -> [binary()].
sessions(undefined, _Id, _Now) ->
    [];
sessions(Tab, Id, Now) ->
    ets:select(Tab, [{{{t, Id, '$1'}, '$2'}, [{'>', '$2', Now}], ['$1']}]).

%% 断开时按会话索引清理，避免扫描全服租约
-spec remove_session(ets:table(), binary()) -> ok.
remove_session(Tab, Sid) ->
    Rows = ets:select(Tab, [{{{s, Sid, '$1'}, '$2'}, [], [{{'$1', '$2'}}]}]),
    lists:foreach(
        fun({Id, Expires}) ->
            ets:delete(Tab, {s, Sid, Id}),
            ets:delete(Tab, {t, Id, Sid}),
            ets:delete(Tab, {e, Expires, {Sid, Id}}),
            release_context(Tab, Id)
        end,
        Rows
    ),
    ets:update_counter(Tab, {z, leases, 0}, -length(Rows)),
    ok.

%% 删除帖子时只清理关联会话
-spec remove_thread(ets:table(), integer()) -> ok.
remove_thread(Tab, Id) ->
    Rows = ets:select(Tab, [{{{t, Id, '$1'}, '$2'}, [], [{{'$1', '$2'}}]}]),
    lists:foreach(
        fun({Sid, Expires}) ->
            ets:delete(Tab, {s, Sid, Id}),
            ets:delete(Tab, {t, Id, Sid}),
            ets:delete(Tab, {e, Expires, {Sid, Id}})
        end,
        Rows
    ),
    ets:update_counter(Tab, {z, leases, 0}, -length(Rows)),
    ets:delete(Tab, {c, Id, 0}),
    ok.

%% 获取独立缓存中的可信帖子上下文
-spec context(ets:table() | undefined, integer()) -> map() | undefined.
context(undefined, _Id) ->
    undefined;
context(Tab, Id) ->
    case ets:lookup(Tab, {c, Id, 0}) of
        [{_, Thread}] -> Thread;
        [] -> undefined
    end.

%% 缓存服务端查询或事件携带的帖子上下文
-spec put_context(ets:table(), integer(), map()) -> true.
put_context(Tab, Id, Thread) ->
    ets:insert(Tab, {{c, Id, 0}, Thread}).

%% 最后一个浏览关系释放后清除上下文
-spec release_context(ets:table(), integer()) -> ok.
release_context(Tab, Id) ->
    case
        {
            ets:next(Tab, {t, Id, <<>>}),
            ets:next(Tab, {w, Id, <<>>}),
            ets:next(Tab, {h, Id, <<>>})
        }
    of
        {{t, Id, _Sid}, _, _} ->
            ok;
        {_, {w, Id, _Sid}, _} ->
            ok;
        {_, _, {h, Id, _Sid}} ->
            ok;
        _ ->
            ets:delete(Tab, {c, Id, 0}),
            ok
    end.

%% 有界清理到期索引，返回是否还需要继续处理
-spec sweep(ets:table(), integer(), non_neg_integer()) -> boolean().
sweep(_Tab, _Now, 0) ->
    true;
sweep(Tab, Now, Budget) ->
    case ets:next(Tab, {e, 0, 0}) of
        {e, Expires, {Sid, Id}} when Expires =< Now ->
            ets:delete(Tab, {e, Expires, {Sid, Id}}),
            ets:delete(Tab, {s, Sid, Id}),
            ets:delete(Tab, {t, Id, Sid}),
            ets:update_counter(Tab, {z, leases, 0}, -1),
            guild_thread_watch_metrics:record(expired, 1),
            release_context(Tab, Id),
            sweep(Tab, Now, Budget - 1);
        _ ->
            false
    end.

%% 导出未到期关系和上下文，绝不在迁移时续期
-spec export(ets:table() | undefined, integer()) -> [tuple()].
export(undefined, _Now) ->
    [];
export(Tab, Now) ->
    Leases = ets:select(Tab, [{{{s, '$1', '$2'}, '$3'}, [{'>', '$3', Now}], ['$_']}]),
    Contexts = ets:select(Tab, [{{{c, '$1', 0}, '$2'}, [], ['$_']}]),
    Leases ++ Contexts.

%% 先恢复有效租约，再仅恢复这些租约引用的上下文，避免迁移留下孤立缓存
-spec restore(ets:table(), [tuple()], map()) -> ok.
restore(Tab, Rows, Sessions) ->
    Now = erlang:system_time(millisecond),
    RestoredThreads = lists:foldl(
        fun
            ({{s, Sid, Id}, Expires}, Acc) when Expires > Now ->
                case maps:is_key(Sid, Sessions) of
                    true ->
                        ets:insert(Tab, [
                            {{s, Sid, Id}, Expires},
                            {{t, Id, Sid}, Expires},
                            {{e, Expires, {Sid, Id}}, true}
                        ]),
                        ets:update_counter(Tab, {z, leases, 0}, 1),
                        Acc#{Id => true};
                    false ->
                        Acc
                end;
            (_, Acc) ->
                Acc
        end,
        #{},
        Rows
    ),
    %% 独立遍历上下文，不依赖迁移数据中租约与上下文的排列顺序
    lists:foreach(
        fun
            ({{c, Id, 0}, Thread}) when is_map_key(Id, RestoredThreads) ->
                ets:insert(Tab, {{c, Id, 0}, Thread});
            (_) ->
                ok
        end,
        Rows
    ),
    ok.
