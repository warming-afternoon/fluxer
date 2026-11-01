// SPDX-License-Identifier: AGPL-3.0-or-later

package settings

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// Raw fork controls still participate in rexctl's known-variable and forwarding
// checks; validate their values before persisting an unusable rollout setting.
func forkSettingValidator(name string) func(string) error {
	switch name {
	case "FLUXER_PUSH_SUBSCRIPTION_BATCHING_ENABLED", "FLUXER_READ_STATE_BATCHING_ENABLED",
		"FLUXER_CHANNEL_METADATA_CACHE_ENABLED", "FLUXER_GUILD_AVAILABILITY_CACHE_ENABLED",
		"FLUXER_COMBINED_CHANNEL_AUTH_ENABLED", "FLUXER_COMBINED_RATE_LIMIT_ENABLED",
		"FLUXER_READ_STATE_COMBINED_GATEWAY_RPC_ENABLED", "FLUXER_READ_STATE_NARROW_AUTH_ENABLED",
		"FLUXER_GATEWAY_CLEAR_BATCH_ENABLED", "FLUXER_PUSH_CLEAR_BATCH_ENABLED":
		return func(v string) error {
			if v == "" || v == "true" || v == "false" {
				return nil
			}
			return fmt.Errorf("Use true or false, or unset the setting.")
		}
	case "FLUXER_API_INSTANCES":
		return forkInteger(1, 512)
	case "FLUXER_GATEWAY_GUILD_MEMBER_LOAD_CONCURRENCY":
		return oneOf("", "1", "2", "4", "8")
	case "FLUXER_GATEWAY_THREAD_MEMBER_LOAD_CONCURRENCY":
		return oneOf("", "1", "2")
	case "FLUXER_GATEWAY_PUSH_OUTBOX_MAX_INFLIGHT", "FLUXER_GATEWAY_THREAD_SYNC_RATE", "FLUXER_GATEWAY_THREAD_SYNC_JITTER_MS":
		return forkInteger(1, 1000000)
	case "FLUXER_INTERNAL_API_RPC_URLS":
		return func(v string) error {
			if v == "" {
				return nil
			}
			targets := strings.Split(v, ",")
			if len(targets) > 512 {
				return fmt.Errorf("Use at most 512 RPC URLs.")
			}
			seen := map[string]bool{}
			for _, target := range targets {
				target = strings.TrimSpace(target)
				if seen[target] {
					return fmt.Errorf("RPC URLs must be unique.")
				}
				seen[target] = true
				u, err := url.Parse(strings.TrimSpace(target))
				if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Fragment != "" || u.RawQuery != "" || u.ForceQuery || u.Path != "/internal/rpc" {
					return fmt.Errorf("Use comma-separated http(s) RPC URLs ending in /internal/rpc without credentials, queries or fragments.")
				}
			}
			return nil
		}
	}
	return nil
}

func forkInteger(min, max int) func(string) error {
	return func(v string) error {
		if v == "" {
			return nil
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < min || n > max {
			return fmt.Errorf("Use an integer from %d to %d.", min, max)
		}
		return nil
	}
}
