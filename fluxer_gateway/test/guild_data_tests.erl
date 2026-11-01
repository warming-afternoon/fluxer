%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_data_tests).
-typing([eqwalizer]).

-include_lib("eunit/include/eunit.hrl").

test_state() ->
    GuildId = 100,
    ViewPerm = constants:view_channel_permission(),
    #{
        id => GuildId,
        member_presence => ets:new(test_member_presence, [set, public]),
        data => #{
            <<"guild">> => #{<<"name">> => <<"Fluxer">>},
            <<"roles">> => [
                #{
                    <<"id">> => integer_to_binary(GuildId),
                    <<"permissions">> => integer_to_binary(ViewPerm)
                }
            ],
            <<"channels">> => [
                #{<<"id">> => <<"500">>, <<"type">> => 0, <<"permission_overwrites">> => []},
                #{<<"id">> => <<"501">>, <<"type">> => 2, <<"permission_overwrites">> => []}
            ],
            <<"members">> => [
                #{
                    <<"user">> => #{<<"id">> => <<"200">>},
                    <<"roles">> => [integer_to_binary(GuildId)],
                    <<"joined_at">> => <<"2024-01-01T00:00:00Z">>
                }
            ],
            <<"emojis">> => [],
            <<"stickers">> => []
        }
    }.

%% 验证联合鉴权拒绝非服务器成员。
-spec combined_channel_authorization_membership_test() -> term().
combined_channel_authorization_membership_test() ->
    State = test_state(),
    {reply, Reply, _} = guild_data:get_channel_authorization(
        #{
            user_id => 999,
            channel_id => 500,
            permission_target_channel_id => 500,
            mode => <<"channel">>
        },
        State
    ),
    ?assertEqual(null, maps:get(auth_context, Reply)).

%% 验证联合鉴权保留上下文和目标频道权限。
-spec combined_channel_authorization_equivalent_permissions_test() -> term().
combined_channel_authorization_equivalent_permissions_test() ->
    State = test_state(),
    {reply, #{auth_context := Result}, _} = guild_data:get_channel_authorization(
        #{
            user_id => 200,
            channel_id => 500,
            permission_target_channel_id => 501,
            mode => <<"thread">>
        },
        State
    ),
    ?assertEqual(1, maps:get(<<"response_version">>, Result)),
    ?assertEqual(<<"500">>, maps:get(<<"context_channel_id">>, Result)),
    ?assertEqual(<<"501">>, maps:get(<<"permission_target_channel_id">>, Result)),
    ?assertEqual(
        integer_to_binary(guild_permissions:get_member_permissions(200, 501, State)),
        maps:get(<<"permissions">>, Result)
    ),
    ?assertEqual(true, maps:get(<<"success">>, maps:get(<<"member">>, Result))).

%% 验证只读模型和传输结果与原权限快照一致。
-spec combined_channel_authorization_read_model_and_wire_test() -> term().
combined_channel_authorization_read_model_and_wire_test() ->
    State = test_state(),
    GuildId = maps:get(id, State),
    ok = guild_read_model:put_state(State),
    Request = #{
        user_id => 200,
        channel_id => 500,
        permission_target_channel_id => 500,
        mode => <<"channel">>
    },
    try
        %% 比较快照查询与直接查询，防止传输路径扩大权限。
        {ok, #{auth_context := Result}} = guild_read_model:query(
            GuildId, {get_guild_channel_authorization, Request}
        ),
        {reply, #{auth_context := Original}, _} = guild_data:get_channel_authorization(
            Request, State
        ),
        ?assertEqual(Original, Result),
        Wire = gateway_rpc_guild_lifecycle:handle(
            <<"guild.get_channel_authorization">>,
            #{
                <<"guild_id">> => integer_to_binary(GuildId),
                <<"user_id">> => <<"200">>,
                <<"context_channel_id">> => <<"500">>,
                <<"permission_target_channel_id">> => <<"500">>,
                <<"mode">> => <<"channel">>
            }
        ),
        ?assertEqual(<<"500">>, maps:get(<<"id">>, maps:get(<<"parent_channel">>, Wire)))
    after
        guild_read_model:delete(GuildId)
    end.
