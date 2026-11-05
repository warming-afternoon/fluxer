#!/usr/bin/env bash
# Compile current Gateway source and run offline NSFW boundary regressions.
set -euo pipefail
cd "$(dirname "$0")/../.."
EBIN="${NSFW_TEST_EBIN:-$(mktemp -d /tmp/fluxer-nsfw-tests.XXXXXX)}"
mkdir -p "$EBIN"
export NSFW_TEST_EBIN="$EBIN"
erl -noshell -eval 'io:format("Erlang/OTP ~s~n", [erlang:system_info(otp_release)]), halt().'
mapfile -t SOURCES < <(find fluxer_gateway/src -name '*.erl' -type f | sort)
printf 'Compiling %s Gateway modules into %s\n' "${#SOURCES[@]}" "$EBIN"
erlc -o "$EBIN" "${SOURCES[@]}"
erlc -o "$EBIN" fluxer_gateway/test/gateway_nsfw_preferences_tests.erl \
    fluxer_gateway/test/guild_directory_permissions_tests.erl \
    fluxer_gateway/test/guild_data_tests.erl fluxer_gateway/test/guild_thread_move_tests.erl
erl -pa "$EBIN" -noshell -eval '
    case eunit:test([gateway_nsfw_preferences_tests, guild_directory_permissions_tests,
        guild_data_tests, guild_thread_move_tests], [verbose]) of
        ok -> halt(0);
        _ -> halt(1)
    end.'
