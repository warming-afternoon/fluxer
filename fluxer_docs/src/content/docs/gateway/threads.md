---
# SPDX-License-Identifier: AGPL-3.0-or-later
title: Gateway threads
description: Thread events, thread subscriptions, forum unread counts and the thread session flag.
---

Fluxer sends [thread](/http-api/threads/) changes, thread member lists and forum unread counts as the Dispatch events below. A user session needs the `CHANNEL_THREADS` [session flag](#session-flag), and a bot session always gets them.

## Session flag

| Value | Name | Description |
| --- | --- | --- |
| 1 &lt;&lt; 2 | CHANNEL_THREADS | The client can parse thread, forum and media channels |

Set it in the [session flags](/gateway/commands/#session-flags) of Identify. A user session without it gets no thread, forum or media channels, no thread messages and none of the events on this page. Its channels and messages have no thread fields, and its permission values have the [thread permissions](/http-api/permissions/#feature-gated-permission-bits) cleared.

## Guild threads

`threads` on a [guild ready object](/gateway/events/#guild-ready-object) is an array of [thread objects](/http-api/threads/#thread-object). A user session receives the active threads it joined and can view, and a bot session receives every active non-forum thread it can view. Forum and media posts in directory snapshots require membership for both users and bots. Each entry has `member` for a thread the session joined.

## Dispatch events

| Event | Description |
| --- | --- |
| [Thread Create](#thread-create) | A thread is created or the session is added to one |
| [Thread Update](#thread-update) | A thread changes |
| [Thread Delete](#thread-delete) | A thread is deleted |
| [Thread List Sync](#thread-list-sync) | The session's active thread set is replaced |
| [Thread Member Update](#thread-member-update) | The session's own thread membership changes |
| [Thread Members Update](#thread-members-update) | Users join or leave a thread |
| [Thread Member List Update](#thread-member-list-update) | The full member list of a subscribed thread |
| [Forum Unreads](#forum-unreads) | Unread counts for forum posts |

For non-forum threads, a session that can view a thread gets its thread events when it is a bot session, when the user is a member or when the session turned on [`threads`](#lazy-request-thread-options). A [passive](/gateway/event-filtering/#active-and-passive-guilds) session gets fewer of them, as noted under each event.

For non-forum threads, messages, reactions, typing and pins go to a session that can view the thread when it is a bot session, the user is a member, the session lists the thread in [`thread_member_lists`](#lazy-request-thread-options), or the session set `threads` and the guild is active for it, whatever the guild size. They also follow [Event filtering](/gateway/event-filtering/#permission-and-visibility).

### <span id="thread-create"></span>THREAD_CREATE

A thread is created or the session is added to one. The payload is the [thread object](/http-api/threads/#thread-object) with these fields.

| Field | Type | Description |
| --- | --- | --- |
| newly_created? | boolean | `true` when the thread was just created, absent when the session was added to an existing thread |
| member? | [thread member](/http-api/thread-members/#thread-member-object) object | The session's own membership |

A passive session gets it only when its user is a member.

### <span id="thread-update"></span>THREAD_UPDATE

A thread changes, and the payload is the [thread object](/http-api/threads/#thread-object). A message sent to an archived thread unarchives it and sends this event. A passive session gets it only for a thread it joined.

### <span id="thread-delete"></span>THREAD_DELETE

A thread is deleted.

| Field | Type | Description |
| --- | --- | --- |
| id | snowflake | The ID of the thread |
| guild_id | snowflake | The ID of the guild |
| parent_id | snowflake | The ID of the parent channel |
| type | integer | The [thread type](/http-api/threads/#thread-types) |

A passive session gets it only when its user is a member.

### <span id="thread-list-sync"></span>THREAD_LIST_SYNC

The session's active threads are replaced for a guild or for some of its channels.

| Field | Type | Description |
| --- | --- | --- |
| guild_id | snowflake | The ID of the guild |
| channel_ids? | array[snowflake] | The parent channels whose threads are replaced, absent for the whole guild |
| threads | array[[thread](/http-api/threads/#thread-object) object] | The active threads the session can view |
| members | array[[thread member](/http-api/thread-members/#thread-member-object) object] | The session's memberships in those threads |

A user session that did not set `threads` gets only joined threads unless `channel_ids` is present. For forum and media posts, snapshots and directory syncs include only joined active posts even with full subscriptions. Discover other posts through the forum directory API.

Setting `threads` or `thread_member_lists` does not subscribe a nonmember to forum or media post events. Ordinary message delivery requires membership and permission; a permitted direct user mention can deliver its message, joining the user first when capacity permits. A live `thread_watches` lease independently permits browsing delivery without membership (see [Thread watches](#thread-watches)). Leaving stops membership-based delivery.

Fluxer sends this sync after enabling `threads`, on guild thread reloads, and on gaining channel view access. Full sync rate and initial jitter are configurable using `FLUXER_GATEWAY_THREAD_SYNC_RATE` and `FLUXER_GATEWAY_THREAD_SYNC_JITTER_MS`; see the deployment reference for defaults. Syncs are delivered live, not retained for Resume.

### <span id="thread-member-update"></span>THREAD_MEMBER_UPDATE

The session's own membership in a thread changes. The payload is the [thread member object](/http-api/thread-members/#thread-member-object) plus `guild_id`. Every session of the user that can view the thread receives it.

### <span id="thread-members-update"></span>THREAD_MEMBERS_UPDATE

Users join or leave a thread.

| Field | Type | Description |
| --- | --- | --- |
| id | snowflake | The ID of the thread |
| guild_id | snowflake | The ID of the guild |
| member_count | integer | The number of thread members, capped at 50 |
| added_members? | array[[thread member](/http-api/thread-members/#thread-member-object) object] | The users who joined, each with `member` and `presence` |
| removed_member_ids? | array[snowflake] | The IDs of the users who left |

`member` is the guild member or null. `presence` is the [presence object](/gateway/events/#presence-object) or null when the user is not visibly online. A passive session gets it only when its user was added or removed.

### <span id="thread-member-list-update"></span>THREAD_MEMBER_LIST_UPDATE

The full member list of a thread the session subscribed to with [`thread_member_lists`](#lazy-request-thread-options). Resume does not replay it.

| Field | Type | Description |
| --- | --- | --- |
| guild_id | snowflake | The ID of the guild |
| thread_id | snowflake | The ID of the thread |
| members | array[thread member list item object] | The members of the thread, at most 1,000 |

Each item has `user_id`, `join_timestamp`, `flags`, `member` and `presence`. `presence` is a [presence object](/gateway/events/#presence-object) with status `offline` when the user is not visibly online.

### <span id="forum-unreads"></span>FORUM_UNREADS

The answer to [Request Forum Unreads](#request-forum-unreads).

| Field | Type | Description |
| --- | --- | --- |
| guild_id | snowflake | The ID of the guild |
| channel_id | snowflake | The ID of the forum or media channel |
| threads | array[forum unread object] | One entry for each requested post found in the channel |

Each forum unread object has `thread_id` and either `count` or `missing`. `count` is the number of messages after the `ack_message_id` in the request, capped at 25. `missing` is true when the request had no valid `ack_message_id` for that post.

## <span id="lazy-request-thread-options"></span>Lazy Request thread options

The [guild subscription object](/gateway/commands/#guild-subscription-object) of [Lazy Request](/gateway/commands/#lazy-request) takes the following thread options. Fluxer ignores them for a user session without `CHANNEL_THREADS`.

| Field | Type | Description |
| --- | --- | --- |
| threads? | boolean | Whether the session subscribes to viewable non-forum threads and joined forum/media posts |
| thread_member_lists? | array[snowflake] | The threads whose member lists the session subscribes to, at most 10; forum/media posts require membership |
| thread_watches? | array[snowflake] | Full desired forum/media browsing set for this guild; requires top-level `thread_watch_nonce` |

`threads` set to false, or marking the guild passive, clears the subscription.

`thread_member_lists` replaces the previous list, and an empty array clears it. Fluxer sends a [Thread Member List Update](#thread-member-list-update) right away for each newly listed thread, and sends another 250 ms after that thread's members change.

## Thread watches

A browsing lease lets the current session receive live forum/media post events without joining the post. It does not grant permissions, expand directory discovery or follow/unread/notification scope. A direct user mention retains its normal notification behavior.

Send `thread_watch_nonce` at the top level of Lazy Request data and `thread_watches` inside each guild subscription. Omitted guild fields leave the existing set unchanged; an empty array cancels it. The final deduplicated set across guilds is limited to 10 posts. An over-limit update is rejected atomically without renewing previous leases; ordinary subscription fields in the same request are independent.

`THREAD_WATCH_ACK` carries `nonce`, `ok`, and (for guild responses) `guild_id`, accepted `thread_ids`, `resync_thread_ids` and `expires_at`. Failures include a `code`. Ignore stale nonces and expired acknowledgements. Leases last 10 minutes; clients renew roughly every four minutes and refresh the visible history after a new/re-established lease. Browsing-only events are live-only, not retained for Resume.

On reconnect or Resume, reassert the desired set and wait for acknowledgement. On foreground-to-background session handoff, release watches with an empty array **and a nonce**, just like the initial request. Account logout/reset must discard all local browsing intent and timers; ordinary connection loss retains intent for re-establishment.

## Request Forum Unreads

Opcode `28` requests unread counts for posts in one forum or media channel. Fluxer closes a user session without `CHANNEL_THREADS` with [`4001`](/gateway/opcodes-and-close-codes/#close-codes).

| Field | Type | Description |
| --- | --- | --- |
| guild_id | snowflake | The ID of the guild |
| channel_id | snowflake | The ID of the forum or media channel |
| threads | array[forum unread request object] | The posts to count, at most 40 |

Each forum unread request object has `thread_id` and an optional `ack_message_id`, the newest message the client has read in that post.

```json
{
  "op": 28,
  "d": {
    "guild_id": "1189375284394692608",
    "channel_id": "1189375284394692700",
    "threads": [{"thread_id": "1189375284394692800", "ack_message_id": "1189375284394692900"}]
  }
}
```

Fluxer answers with one [Forum Unreads](#forum-unreads) and sends nothing when the guild is unavailable to the session, the channel is not a forum or media channel or the session cannot view it. A connection can send five of these commands in any 5 seconds, and Fluxer drops the rest.
