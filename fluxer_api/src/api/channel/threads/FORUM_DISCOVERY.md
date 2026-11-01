# Forum discovery and event subscriptions

[中文说明](FORUM_DISCOVERY.zh-CN.md)

Following a post controls automatic synchronization and ordinary event delivery. It is not an additional permission requirement for explicitly listing, searching, or reading a post. Existing channel, private-thread, age, and message-history access rules still apply.

## Directory API

`GET /channels/:channel_id/threads/directory` lists posts in one forum or media channel in descending creation order. It does not use the search provider or load every active post in the guild.

| Query | Meaning |
| --- | --- |
| `archived` | `false` for active posts, `true` for archived posts; defaults to `false`. |
| `tag`, `tag_setting` | Existing forum tag filters. |
| `limit` | Ordinary page size, from 1 to 100; defaults to 50. |
| `cursor` | Opaque continuation token returned by the preceding page. |

The response contains `threads`, the caller's own `members` records, `pinned_thread`, `next_cursor`, and `has_more`. A visible active pinned post is returned separately on the first active page, does not consume the ordinary page limit, and can also appear in `threads`; clients deduplicate by post ID. Later pages return `pinned_thread: null` without replacing the first page's pin.

Each request examines at most 1,000 index entries, in batches of at most 100. Archived, missing, filtered, and inaccessible entries can produce a short or empty page. **Continue while `next_cursor` is non-null**: `has_more` describes remaining scan work, not a guaranteed number of additional visible posts. Cursors last 15 minutes, are shared across API instances, and are bound to the caller, guild, parent channel, and filters. Every page checks current permissions. A submitted token whose record is missing, expired, or mismatched returns a validation error for `cursor`; restart from the first page. Omitting the query parameter requests the first page normally. Dependency failures do not trigger a full-directory fallback.

Text searches continue to use `/channels/:channel_id/threads/search`. Existing search sorting parameters and legacy archived-list pagination remain supported. The client directory uses creation order and no longer offers latest-activity sorting.

## Loading and access

Login and reconnect keep the existing followed-post initialization. Opening a forum starts its directory request; directory cards do not create browsing leases or follow posts. Pages and previews refresh on explicit refresh, navigation, or the user's own completed changes. There is no new live directory subscription. Permission revocation and known deletion still remove inaccessible content.

Explicit directory, search, archive, post-data, unread, and member-list requests do not require following. Inaccessible post IDs are omitted from batch previews. First messages retain message-history authorization and cutoff handling; a visible post is not a grant to read all its history. Unread requests use the API's bounded, user-authorized path for both cached and uncached posts.

Ordinary message events still require following or an accepted browsing lease, with the existing authorized direct-mention exception. Mention auto-join remains unchanged. Browsing expiry, recovery, permission checks, and session deduplication remain in effect.

## Upgrade order

Deploy the API with directory support and user-authorized unread handling first, then the matching Gateway, then the client. Do not pair the new Gateway unread behavior with an older API that does not authorize the requesting user. No database migration or search-index rebuild is required. Roll back the client before removing directory support from the API.
