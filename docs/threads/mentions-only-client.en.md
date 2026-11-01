# Thread notification client maintenance

The thread member notification UI offers **Only mentions** and **Nothing**. The desktop header, thread context menus, sidebar mobile menu, and mobile channel-details notification sheet use the same thread menu builder. The mobile sheet must write thread-member flags, not a generic channel notification override.

Legacy `ALL_MESSAGES` flags are read and written as `ONLY_MENTIONS`. A member with no explicit choice inherits a parent's **Nothing** setting; all other parent notification levels resolve to mentions. An explicit member choice still overrides inheritance. Muting remains separate. Generic channel/DM settings, unread badges, and forum new-post settings keep their existing choices.

`Message.threadMentionWarnings` carries the optional public `thread_mention_warnings` array. Missing fields in older responses become an empty array. Partial updates preserve an absent field; an explicit empty/undefined field clears it. Equality and JSON serialization include the reasons, so a warning-only gateway update can refresh the message view. Message snapshots do not inherit these delivery decisions.

The compact and normal message layouts render a nonblocking note for `role_group_too_large`, `role_union_too_large`, or `role_index_unavailable`. Unknown future codes and historical failure flags do not produce a new note. The note contains no counts or identities and is excluded from message-copy text. Original mention payloads and WS mention display remain unchanged.

The three notes have English and Simplified Chinese catalog entries. Other locales explicitly use English fallback text until localized. All 34 catalogs pass the existing strict compiler; the fallback entries must remain present during subsequent extraction and translation work.

Upgrade the frontend independently to accept the optional field, but enable the server rule only after the API, worker, and Gateway decision capability is ready. A frontend deployment does not enforce delivery eligibility. Older frontend versions may show an All choice again after rollback; the server must continue enforcing its own thread policy. Notification rollback is independent of the 100,000-member cap and must never truncate existing memberships.

Local desktop/browser notification matching still uses the existing general mention matcher: `@everyone`/`@here` can remain mention-like locally. This change does not claim to disable that separate path. Gateway device Push suppression is enforced by the server implementation. Forum new-post creation notification resolution is unchanged.

Actual commands and results for this integration are listed in the delivery package. Historical candidate tests and builds do not validate the final source. Full app typechecking, browser visual QA, and a real mixed-version deployment must be reported independently.

Thread MESSAGE_CREATE uses a versioned dedicated Gateway RPC. An old gateway rejects this route explicitly; the API never falls back to a legacy route that could expose a private decision or broadcast plain thread Push. An upgraded gateway keeps direct mentions when role capability is unavailable. Upgrade all gateways before API/worker rollout, wait for component leases, and enable role notifications and client hints last. A failed dispatch can follow message persistence; investigate the message ID and logs rather than assuming message-outbox recovery exists.
