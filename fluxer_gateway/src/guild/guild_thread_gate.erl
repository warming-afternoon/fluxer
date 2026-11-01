%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_thread_gate).
-typing([eqwalizer]).

-export([
    active/1,
    store/1,
    compute_viewer/4,
    session_viewer/1,
    session_fields/3,
    recompute_session_viewers/1,
    state_opts/1,
    thread/2,
    directory_allowed/3,
    delivery_member_allowed/3,
    is_thread_id/2,
    channel_visible/3,
    pre_update_filter/3,
    event_scope/3,
    viewer_sessions/1,
    thread_sessions/6,
    with_message_channel_context/3,
    thread_view_access/4,
    needs_variant/1,
    recipient_active/2
]).

-type guild_state() :: map().
-type session_pair() :: {binary(), map()}.

-type thread_ctx() :: {map(), integer() | undefined, binary() | undefined, map()}.
-type access_memo() :: #{integer() => boolean()}.

-define(MAX_ACCESS_MEMO_ENTRIES, 8192).
-spec data(map()) -> map().
data(#{data := Data}) when is_map(Data) ->
    Data;
data(Data) ->
    Data.

-spec active(map()) -> boolean().
active(State) ->
    case data(State) of
        #{thread_gate := #{active := true}} -> true;
        _ -> false
    end.

-spec tainted(map()) -> boolean().
tainted(State) ->
    case data(State) of
        #{thread_tainted := true} -> true;
        _ -> false
    end.

-spec store(map()) -> ets:table() | undefined.
store(State) ->
    case data(State) of
        #{thread_store := Tab, thread_gate := #{active := true}} when Tab =/= undefined -> Tab;
        _ -> undefined
    end.

-spec compute_viewer(boolean(), boolean(), boolean(), term()) -> boolean().
compute_viewer(true, true, _Capable, UserId) when is_integer(UserId) ->
    not channel_threads_config:user_excluded(UserId);
compute_viewer(true, false, true, UserId) when is_integer(UserId) ->
    channel_threads_config:user_active(UserId);
compute_viewer(_Active, _Bot, _Capable, _UserId) ->
    false.

-spec session_viewer(map()) -> boolean().
session_viewer(#{thread_viewer := true}) -> true;
session_viewer(_) -> false.

-spec session_fields(map(), term(), map()) -> map().
session_fields(Request, UserId, State) ->
    Capable = type_conv:is_true(maps:get(thread_channels_capable, Request, false)),
    Bot = type_conv:is_true(maps:get(bot, Request, false)),
    #{
        thread_capable => Capable,
        thread_viewer => compute_viewer(active(State), Bot, Capable, UserId)
    }.

-spec recompute_session_viewers(map()) -> map().
recompute_session_viewers(State) ->
    Active = active(State),
    Loaded = channel_threads_config:enabled() orelse channel_threads_config:version() > 0,
    Sessions = maps:get(sessions, State),
    State#{
        sessions => maps:map(
            fun(_SessionId, Session) -> recompute_session_viewer(Active, Loaded, Session) end,
            Sessions
        )
    }.

-spec recompute_session_viewer(boolean(), boolean(), term()) -> term().
recompute_session_viewer(true, false, #{thread_viewer := _} = Session) ->
    Session;
recompute_session_viewer(Active, _Loaded, Session) when is_map(Session) ->
    Viewer = compute_viewer(
        Active,
        type_conv:is_true(maps:get(bot, Session, false)),
        type_conv:is_true(maps:get(thread_capable, Session, false)),
        maps:get(user_id, Session, undefined)
    ),
    case Viewer of
        true ->
            Session#{thread_viewer => true};
        false ->
            maps:without([thread_subscribed, thread_member_lists], Session#{
                thread_viewer => false
            })
    end;
recompute_session_viewer(_Active, _Loaded, Session) ->
    Session.

-spec state_opts(map()) -> map().
state_opts(Session) ->
    #{
        bot => type_conv:is_true(maps:get(bot, Session, false)),
        thread_viewer => session_viewer(Session)
    }.

-spec is_thread_type(term()) -> boolean().
is_thread_type(10) -> true;
is_thread_type(11) -> true;
is_thread_type(12) -> true;
is_thread_type(_) -> false.

-spec is_gated_channel_type(term()) -> boolean().
is_gated_channel_type(Type) ->
    is_thread_type(Type) orelse channel_types:is_thread_only(Type).

-spec channel_type(integer(), map()) -> integer() | undefined.
channel_type(ChannelId, State) ->
    case maps:get(ChannelId, guild_data_index_channels:channel_index(data(State)), undefined) of
        #{<<"type">> := Type} when is_integer(Type) -> Type;
        _ -> undefined
    end.

-spec thread(integer(), map()) -> map() | undefined.
thread(ThreadId, State) ->
    case store(State) of
        undefined -> undefined;
        Tab -> safe_get_thread(Tab, ThreadId)
    end.

-spec safe_get_thread(ets:table(), integer()) -> map() | undefined.
safe_get_thread(Tab, ThreadId) ->
    try
        guild_thread_store:get_thread(Tab, ThreadId)
    catch
        error:badarg -> undefined
    end.

-spec is_thread_id(integer(), map()) -> boolean().
is_thread_id(ChannelId, State) ->
    thread(ChannelId, State) =/= undefined.

%% 自动同步继续只带关注帖子，不作为主动目录查询的权限判断。
-spec directory_allowed(integer() | undefined, map(), guild_state()) -> boolean().
directory_allowed(UserId, Thread, State) ->
    delivery_member_allowed(UserId, Thread, State).

%% 普通内容事件要求论坛成员，浏览和直接提及由调用者独立处理。
-spec delivery_member_allowed(integer() | undefined, map(), guild_state()) -> boolean().
delivery_member_allowed(UserId, Thread, State) ->
    ParentId = guild_thread_permissions:parent_id(Thread),
    case channel_types:is_thread_only(channel_type(ParentId, State)) of
        true ->
            ThreadId = snowflake_id:parse(maps:get(<<"id">>, Thread)),
            case thread(ThreadId, State) of
                undefined ->
                    lists:member(
                        UserId,
                        snowflake_id:parse_list(maps:get(<<"_fluxer_member_ids">>, Thread, []))
                    );
                _ ->
                    is_thread_member(UserId, ThreadId, State)
            end;
        false ->
            true
    end.

-spec is_gated_channel_id(integer(), guild_state()) -> boolean().
is_gated_channel_id(ChannelId, State) ->
    needs_variant(State) andalso
        case channel_type(ChannelId, State) of
            undefined -> true;
            Type -> is_gated_channel_type(Type)
        end.

-spec channel_visible(map(), term(), map()) -> boolean().
channel_visible(Session, ChannelId, State) when is_integer(ChannelId) ->
    session_viewer(Session) orelse non_viewer_visible(Session, ChannelId, State);
channel_visible(_Session, _ChannelId, _State) ->
    true.

-spec non_viewer_visible(map(), integer(), map()) -> boolean().
non_viewer_visible(Session, ChannelId, State) ->
    not needs_variant(State) orelse
        case channel_type(ChannelId, State) of
            4 -> category_visible(Session, ChannelId, State);
            undefined -> not is_thread_id(ChannelId, State);
            Type -> not is_gated_channel_type(Type)
        end.

-spec category_visible(map(), integer(), map()) -> boolean().
category_visible(Session, CategoryId, State) ->
    case maps:get(thread_forum_categories, data(State), #{}) of
        #{CategoryId := PlainChildren} ->
            plain_category_visible(Session, CategoryId, PlainChildren, State);
        _ ->
            true
    end.

-spec plain_category_visible(map(), integer(), [integer()], map()) -> boolean().
plain_category_visible(#{user_id := UserId}, CategoryId, PlainChildren, State) when
    is_integer(UserId)
->
    Member = guild_permissions_check:find_member_by_user_id(UserId, State),
    Member =/= undefined andalso
        (guild_permissions_check:can_view_channel_by_permissions(
            UserId, CategoryId, Member, State
        ) orelse
            lists:any(
                fun(ChildId) ->
                    guild_permissions_check:can_view_channel(UserId, ChildId, Member, State)
                end,
                PlainChildren
            ));
plain_category_visible(_Session, _CategoryId, _PlainChildren, _State) ->
    false.

-spec pre_update_filter(atom(), map(), map()) -> pass | drop | {filtered, map()}.
pre_update_filter(Event, Data, State) ->
    case active(State) of
        true -> pass;
        false -> inactive_filter(Event, Data)
    end.

-spec inactive_filter(atom(), map()) -> pass | drop | {filtered, map()}.
inactive_filter(Event, _Data) when
    Event =:= thread_create;
    Event =:= thread_update;
    Event =:= thread_delete;
    Event =:= thread_list_sync;
    Event =:= thread_member_update;
    Event =:= thread_members_update;
    Event =:= thread_member_list_update;
    Event =:= forum_unreads
->
    drop;
inactive_filter(Event, Data) when
    Event =:= channel_create; Event =:= channel_update; Event =:= channel_delete
->
    case is_gated_channel_type(maps:get(<<"type">>, Data, undefined)) of
        true -> drop;
        false -> pass
    end;
inactive_filter(channel_update_bulk, #{<<"channels">> := Channels} = Data) when
    is_list(Channels)
->
    case
        [
            C
         || C <- Channels,
            not (is_map(C) andalso is_gated_channel_type(maps:get(<<"type">>, C, undefined)))
        ]
    of
        Channels -> pass;
        [] -> drop;
        Kept -> {filtered, Data#{<<"channels">> => Kept}}
    end;
inactive_filter(message_create, #{<<"type">> := Type}) when Type =:= 18; Type =:= 21 ->
    drop;
inactive_filter(_Event, _Data) ->
    pass.

-spec event_scope(atom(), map(), map()) -> open | viewers | {thread, integer(), map()}.
event_scope(Event, Data, State) ->
    Scope = needs_variant(State) andalso viewer_only_event(Event, Data, State),
    case Scope of
        true -> viewers;
        false -> open;
        {thread, _ThreadId, _Thread} = Thread -> Thread
    end.

-spec viewer_sessions(map()) -> map().
viewer_sessions(Sessions) ->
    maps:filter(
        fun(_Sid, Session) -> is_map(Session) andalso session_viewer(Session) end, Sessions
    ).

%% 筛选线程事件的在线接收者，并保留最终的会话和权限检查
-spec thread_sessions(atom(), map(), integer(), map(), binary() | undefined, guild_state()) ->
    [session_pair()].
thread_sessions(Event, Data, ThreadId, Thread, SessionIdOpt, State) ->
    MessageId =
        case guild_dispatch_filter:is_message_access_filtered_event(Event) of
            true -> guild_dispatch_filter:extract_message_id(Data);
            false -> undefined
        end,
    Ctx = {Thread, guild_thread_permissions:parent_id(Thread), MessageId, State},
    Candidates = delivery_candidates(Event, Data, ThreadId, Thread, State),
    {Pairs, _Memo, _DeliveryCtx} = maps:fold(
        fun(Sid, Session, {Acc, Memo, DeliveryCtx0}) ->
            case
                Sid =/= SessionIdOpt andalso is_map(Session) andalso
                    session_viewer(Session) andalso
                    maps:get(pending_connect, Session, false) =/= true
            of
                true ->
                    %% 上下文延迟到首个可参与筛选的设备，保持空受众的原异常语义。
                    DeliveryCtx = message_delivery_context(DeliveryCtx0, Thread, State),
                    Interested = message_delivery_interested(
                        Event, Data, Session, ThreadId, Thread, State, DeliveryCtx
                    ),
                    case
                        Interested orelse
                            (watch_event(Event) andalso
                                guild_thread_watches:watching(Sid, ThreadId, State))
                    of
                        true ->
                            {Ok, Memo1} = thread_access(Session, Ctx, Memo),
                            {prepend(Ok, Sid, Session, Acc), Memo1, DeliveryCtx};
                        false ->
                            {Acc, Memo, DeliveryCtx}
                    end;
                false ->
                    {Acc, Memo, DeliveryCtx0}
            end
        end,
        {[], #{}, undefined},
        Candidates
    ),
    Pairs.

%% 从帖子成员与直接提及用户中查找在线设备，减少论坛事件的全会话扫描
-spec delivery_candidates(atom(), map(), integer(), map(), guild_state()) -> map().
delivery_candidates(Event, Data, ThreadId, Thread, State) ->
    Sessions = maps:get(sessions, State, #{}),
    ParentId = guild_thread_permissions:parent_id(Thread),
    case channel_types:is_thread_only(channel_type(ParentId, State)) of
        false ->
            Sessions;
        true ->
            %% 只有消息创建允许直接提及的非成员进入候选集合
            Mentions =
                case Event of
                    message_create ->
                        snowflake_id:parse_list([
                            Id
                         || #{<<"id">> := Id} <- maps:get(<<"mentions">>, Data, [])
                        ]);
                    _ ->
                        []
                end,
            MemberSessions = maps:merge(
                member_candidates(Event, ThreadId, Thread, State, Sessions),
                guild_online_session_index:for_users(Sessions, Mentions)
            ),
            case watch_event(Event) of
                true ->
                    maps:merge(
                        MemberSessions,
                        maps:with(guild_thread_watches:sessions(ThreadId, State), Sessions)
                    );
                false ->
                    MemberSessions
            end
    end.

%% 仅已加载活跃帖的消息创建使用可信计数，其他事件保留成员快照和原错误语义。
-spec member_candidates(atom(), integer(), map(), guild_state(), map()) -> map().
member_candidates(Event, ThreadId, Thread, State, Sessions) ->
    Loaded = thread(ThreadId, State),
    Tab = store(State),
    case {Event, Loaded} of
        {message_create, #{<<"thread_metadata">> := #{<<"archived">> := false}}} ->
            case guild_thread_store:member_count(Tab, ThreadId) of
                Count when is_integer(Count), Count >= 0 ->
                    {_Direction, _OnlineCount, _Scanned, Candidates} =
                        guild_online_session_index:for_thread_members(
                            Sessions, Tab, ThreadId, Count
                        ),
                    Candidates;
                unknown ->
                    guild_online_session_index:for_users(
                        Sessions, guild_thread_store:member_ids(Tab, ThreadId)
                    )
            end;
        _ ->
            Members =
                case Loaded of
                    undefined ->
                        snowflake_id:parse_list(maps:get(<<"_fluxer_member_ids">>, Thread, []));
                    _ ->
                        guild_thread_store:member_ids(Tab, ThreadId)
                end,
            guild_online_session_index:for_users(Sessions, Members)
    end.
%% 浏览订阅仅接收内容变化，不自动增加输入状态或成员列表事件
-spec watch_event(atom()) -> boolean().
watch_event(Event) ->
    lists:member(Event, [
        message_create,
        message_update,
        message_delete,
        message_delete_bulk,
        message_reaction_add,
        message_reaction_add_many,
        message_reaction_remove,
        message_reaction_remove_all,
        message_reaction_remove_emoji,
        channel_pins_update
    ]).

%% 普通论坛事件要求成员资格，消息创建允许带权限检查的直接提及例外
-spec delivery_interested(atom(), map(), map(), integer(), map(), guild_state()) -> boolean().
delivery_interested(Event, Data, Session, ThreadId, Thread, State) ->
    UserId = maps:get(user_id, Session, undefined),
    (delivery_member_allowed(UserId, Thread, State) andalso
        thread_interested(Session, ThreadId, State)) orelse
        (Event =:= message_create andalso is_integer(UserId) andalso
            lists:any(
                fun
                    (#{<<"id">> := Id}) -> snowflake_id:parse_maybe(Id) =:= UserId;
                    (_) -> false
                end,
                maps:get(<<"mentions">>, Data, [])
            )).

%% 仅当前进程拥有的受保护成员表允许消息内复用，其他表保留原逐设备读取。
-spec message_delivery_context(term(), map(), guild_state()) -> term().
message_delivery_context(undefined, Thread, State) ->
    Tab = store(State),
    Reusable =
        try
            Tab =:= undefined orelse
                (ets:info(Tab, owner) =:= self() andalso ets:info(Tab, protection) =/= public)
        catch
            error:badarg -> false
        end,
    case Reusable of
        false ->
            legacy;
        true ->
            ParentId = guild_thread_permissions:parent_id(Thread),
            case channel_types:is_thread_only(channel_type(ParentId, State)) of
                false ->
                    {public, Tab};
                true ->
                    Id = snowflake_id:parse(maps:get(<<"id">>, Thread)),
                    case thread(Id, State) of
                        undefined ->
                            Members = snowflake_id:parse_list(
                                maps:get(<<"_fluxer_member_ids">>, Thread, [])
                            ),
                            {{snapshot, Members}, Tab};
                        _ ->
                            {{stored, Id}, Tab}
                    end
            end
    end;
message_delivery_context(Context, _Thread, _State) ->
    Context.

%% 单消息仅复用帖子上下文，成员资格保持原逐设备直接读取与短路顺序。
-spec message_delivery_interested(
    atom(), map(), map(), integer(), map(), guild_state(), term()
) -> boolean().
message_delivery_interested(Event, Data, Session, ThreadId, Thread, State, legacy) ->
    delivery_interested(Event, Data, Session, ThreadId, Thread, State);
message_delivery_interested(Event, Data, Session, ThreadId, _Thread, State, {Mode, Tab}) ->
    UserId = maps:get(user_id, Session, undefined),
    Allowed =
        case Mode of
            public -> true;
            {snapshot, Members} -> lists:member(UserId, Members);
            {stored, Id} -> message_member(UserId, Id, Tab)
        end,
    (Allowed andalso
        (maps:get(bot, Session, false) =:= true orelse
            lists:member(ThreadId, maps:get(thread_member_lists, Session, [])) orelse
            message_member(UserId, ThreadId, Tab) orelse
            (maps:get(thread_subscribed, Session, false) =:= true andalso
                not session_passive:is_passive(maps:get(id, State, 0), Session)))) orelse
        (Event =:= message_create andalso is_integer(UserId) andalso
            lists:any(
                fun
                    (#{<<"id">> := Id}) -> snowflake_id:parse_maybe(Id) =:= UserId;
                    (_) -> false
                end,
                maps:get(<<"mentions">>, Data, [])
            )).

%% 上下文中的成员表仍逐次直接查询，不构造或携带成员结果缓存。
-spec message_member(term(), integer(), ets:table() | undefined) -> boolean().
message_member(UserId, ThreadId, Tab) when is_integer(UserId), Tab =/= undefined ->
    guild_thread_store:is_member(Tab, ThreadId, UserId);
message_member(_UserId, _ThreadId, _Tab) ->
    false.

%% 在接收者完成实际权限筛选后，一次构造所属帖子的公共模型，不改变订阅或成员关系
-spec with_message_channel_context(atom(), map(), guild_state()) -> map().
with_message_channel_context(message_create, Data, State) ->
    case event_scope(message_create, Data, State) of
        {thread, _ThreadId, Thread} ->
            %% 内部上下文补齐被存储容量淘汰的帖子基础字段，白名单排除用户专属及内部状态
            Base = maps:get(<<"_fluxer_thread">>, Data, #{}),
            Context = maps:with(
                [
                    <<"id">>,
                    <<"guild_id">>,
                    <<"parent_id">>,
                    <<"type">>,
                    <<"name">>,
                    <<"owner_id">>,
                    <<"last_message_id">>,
                    <<"last_pin_timestamp">>,
                    <<"rate_limit_per_user">>,
                    <<"flags">>,
                    <<"thread_metadata">>,
                    <<"applied_tags">>,
                    <<"message_count">>,
                    <<"total_message_sent">>,
                    <<"member_count">>
                ],
                (maps:merge(Thread, Base))#{<<"guild_id">> => maps:get(<<"guild_id">>, Data)}
            ),
            Data#{<<"channel_context">> => Context};
        _ ->
            maps:remove(<<"channel_context">>, Data)
    end;
with_message_channel_context(_Event, Data, _State) ->
    Data.

-spec prepend(boolean(), binary(), map(), [session_pair()]) -> [session_pair()].
prepend(true, Sid, Session, Acc) -> [{Sid, Session} | Acc];
prepend(false, _Sid, _Session, Acc) -> Acc.

-spec thread_interested(map(), integer(), guild_state()) -> boolean().
thread_interested(Session, ThreadId, State) ->
    type_conv:is_true(maps:get(bot, Session, false)) orelse
        lists:member(ThreadId, maps:get(thread_member_lists, Session, [])) orelse
        is_thread_member(maps:get(user_id, Session, undefined), ThreadId, State) orelse
        (type_conv:is_true(maps:get(thread_subscribed, Session, false)) andalso
            not session_passive:is_passive(maps:get(id, State), Session)).

-spec thread_view_access(map() | false, map(), map(), #{integer() => boolean()}) ->
    {boolean(), #{integer() => boolean()}}.
thread_view_access(false, _Thread, _State, Memo) ->
    {false, Memo};
thread_view_access(Session, Thread, State, Memo) ->
    thread_access(
        Session, {Thread, guild_thread_permissions:parent_id(Thread), undefined, State}, Memo
    ).

-spec thread_access(map() | false, thread_ctx(), access_memo()) -> {boolean(), access_memo()}.
thread_access(#{user_id := UserId} = Session, Ctx, Memo) when is_integer(UserId) ->
    case parent_viewable(Session, Ctx) of
        true -> {true, Memo};
        false -> memo_thread_access(UserId, Ctx, Memo)
    end;
thread_access(_Session, _Ctx, Memo) ->
    {false, Memo}.

-spec parent_viewable(map(), thread_ctx()) -> boolean().
parent_viewable(#{viewable_channels := Viewable}, {Thread, ParentId, undefined, _State}) when
    is_map(Viewable), is_integer(ParentId)
->
    is_map_key(ParentId, Viewable) andalso maps:get(<<"type">>, Thread, undefined) =/= 12;
parent_viewable(_Session, _Ctx) ->
    false.

-spec memo_thread_access(integer(), thread_ctx(), access_memo()) -> {boolean(), access_memo()}.
memo_thread_access(UserId, {Thread, _ParentId, MessageId, State}, Memo) ->
    case Memo of
        #{UserId := Ok} ->
            {Ok, Memo};
        _ ->
            Ok = resolve_thread_access(UserId, Thread, MessageId, State),
            {Ok, store_access_memo(UserId, Ok, Memo)}
    end.

-spec store_access_memo(integer(), boolean(), access_memo()) -> access_memo().
store_access_memo(UserId, Ok, Memo) when map_size(Memo) < ?MAX_ACCESS_MEMO_ENTRIES ->
    Memo#{UserId => Ok};
store_access_memo(_UserId, _Ok, Memo) ->
    Memo.

-spec resolve_thread_access(integer(), map(), binary() | undefined, map()) -> boolean().
resolve_thread_access(UserId, Thread, MessageId, State) ->
    case guild_permissions_check:find_member_by_user_id(UserId, State) of
        undefined ->
            false;
        Member ->
            Perms = guild_thread_permissions:resolve(UserId, Thread, Member, State),
            bitset:has(Perms, constants:view_channel_permission()) andalso
                (MessageId =:= undefined orelse
                    guild_permissions_check:can_access_message_by_permissions(
                        Perms, MessageId, State
                    ))
    end.

-spec is_thread_member(term(), integer(), map()) -> boolean().
is_thread_member(UserId, ThreadId, State) when is_integer(UserId) ->
    case store(State) of
        undefined -> false;
        Tab -> guild_thread_store:is_member(Tab, ThreadId, UserId)
    end;
is_thread_member(_UserId, _ThreadId, _State) ->
    false.

-spec viewer_only_event(atom(), map(), map()) ->
    boolean() | {thread, integer(), map()}.
viewer_only_event(Event, Data, _State) when
    Event =:= channel_create; Event =:= channel_update; Event =:= channel_delete
->
    is_gated_channel_type(maps:get(<<"type">>, Data, undefined));
viewer_only_event(message_create, #{<<"type">> := Type} = Data, State) when
    Type =:= 18; Type =:= 21
->
    case channel_scoped_gated(Data, State) of
        {thread, _ThreadId, _Thread} = Thread -> Thread;
        _ -> true
    end;
viewer_only_event(message_update, #{<<"__thread_only_update">> := true}, _State) ->
    true;
viewer_only_event(guild_audit_log_entry_create, #{<<"__thread_scoped">> := _}, _State) ->
    true;
viewer_only_event(Event, Data, State) ->
    case guild_dispatch_filter:is_channel_scoped_event(Event) of
        true -> channel_scoped_gated(Data, State);
        false -> false
    end.

-spec channel_scoped_gated(map(), map()) -> boolean() | {thread, integer(), map()}.
channel_scoped_gated(Data, State) ->
    ChannelId = snowflake_id:parse_optional(maps:get(<<"channel_id">>, Data, undefined)),
    Thread =
        case ChannelId of
            ParsedId when is_integer(ParsedId) -> thread_or_context(ParsedId, Data, State);
            _ -> undefined
        end,
    case {ChannelId, Thread} of
        {Id, undefined} when is_integer(Id) -> is_gated_channel_id(Id, State);
        {Id, Found} when is_integer(Id) -> {thread, Id, Found};
        _ -> false
    end.

-spec thread_or_context(integer(), map(), map()) -> map() | undefined.
thread_or_context(ChannelId, Data, State) ->
    case thread(ChannelId, State) of
        undefined ->
            case guild_state_threads:thread_context(ChannelId, Data) of
                undefined -> guild_thread_watches:context(ChannelId, State);
                Context -> Context
            end;
        Thread ->
            Thread
    end.

-spec needs_variant(map()) -> boolean().
needs_variant(State) ->
    active(State) orelse tainted(State).

-spec recipient_active(integer(), map()) -> fun((integer()) -> boolean()).
recipient_active(ChannelId, State) ->
    Access =
        case is_gated_channel_id(ChannelId, State) andalso active(State) of
            false -> open;
            true -> channel_threads_config:config()
        end,
    fun(UserId) ->
        Access =:= open orelse
            channel_threads_config:user_active(Access, UserId) orelse
            (is_bot_member(UserId, State) andalso
                not channel_threads_config:user_excluded(Access, UserId))
    end.

-spec is_bot_member(integer(), map()) -> boolean().
is_bot_member(UserId, State) ->
    case guild_permissions_check:find_member_by_user_id(UserId, State) of
        #{<<"user">> := #{<<"bot">> := true}} -> true;
        _ -> false
    end.
