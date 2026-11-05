%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_viewable_channels_cache).
-typing([eqwalizer]).

-export([get/3, invalidate/1]).

-define(MAX_SCOPED_CACHE_ENTRIES, 1024).

-type guild_state() :: #{viewable_channels_cache => ets:tid(), term() => term()}.
-type user_id() :: integer().

-spec get(
    integer(), [integer()], #{viewable_channels_cache => ets:tid(), term() => term()}
) -> map().
get(UserId, UserRoles, State) ->
    CacheKey = {UserId, list_to_tuple(lists:sort(UserRoles)),
        gateway_nsfw_preferences:cache_key(UserId, State)},
    CacheTab = viewable_channels_cache_table(State),
    lookup_or_compute_viewable(UserId, CacheKey, CacheTab, State).

-spec lookup_or_compute_viewable(
    user_id(), tuple(), ets:tid() | undefined, guild_state()
) -> map().
lookup_or_compute_viewable(UserId, _CacheKey, undefined, State) ->
    compute_viewable_channel_map(UserId, State);
lookup_or_compute_viewable(UserId, CacheKey, CacheTab, State) ->
    case ets:lookup(CacheTab, CacheKey) of
        [{_, Map}] ->
            Map;
        [] ->
            Map = compute_viewable_channel_map(UserId, State),
            ok = trim_scoped_cache(CacheTab, State),
            ets:insert(CacheTab, {CacheKey, Map}),
            Map
    end.

%% Keep the full generation key: an old asynchronous computation must never
%% populate the same cache key after a false/true/false preference transition.
%% This is a cache-size trigger, not a strict quota under concurrent writers.
-spec trim_scoped_cache(ets:tid(), guild_state()) -> ok.
trim_scoped_cache(CacheTab, State) ->
    GuildId = maps:get(id, State, undefined),
    case is_integer(GuildId) andalso GuildId =:= gateway_nsfw_preferences:scope()
        andalso ets:info(CacheTab, size) >= ?MAX_SCOPED_CACHE_ENTRIES of
        true -> ets:delete_all_objects(CacheTab), ok;
        false -> ok
    end.

-spec compute_viewable_channel_map(user_id(), guild_state()) -> map().
compute_viewable_channel_map(UserId, State) ->
    guild_sessions:build_viewable_channel_map(
        guild_visibility_channels:get_user_viewable_channels(UserId, State)
    ).

-spec invalidate(#{
    viewable_channels_cache => ets:tid(), term() => term()
}) -> ok.
invalidate(State) ->
    case viewable_channels_cache_table(State) of
        CacheTab when is_reference(CacheTab) ->
            ets:delete_all_objects(CacheTab),
            ok;
        undefined ->
            ok
    end.

-spec viewable_channels_cache_table(guild_state()) -> ets:tid() | undefined.
viewable_channels_cache_table(#{viewable_channels_cache := CacheTab}) ->
    CacheTab;
viewable_channels_cache_table(_) ->
    undefined.
