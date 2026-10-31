// SPDX-License-Identifier: AGPL-3.0-or-later

import {z} from 'zod';

export const ThreadMentionWarningSchema = z.enum([
	'role_group_too_large',
	'role_union_too_large',
	'role_index_unavailable',
]);

const InternalIdSchema = z.string().regex(/^[0-9]{1,20}$/);

export const ThreadMentionDecisionSchema = z.object({
	version: z.literal(1),
	message_id: InternalIdSchema,
	channel_id: InternalIdSchema,
	author_id: InternalIdSchema,
	allowed_role_ids: z.array(InternalIdSchema).max(1024),
	role_user_ids: z.array(InternalIdSchema).max(3000),
	direct_user_ids: z.array(InternalIdSchema).max(1024),
	warnings: z.array(ThreadMentionWarningSchema).max(3),
});

export type ThreadMentionDecision = z.infer<typeof ThreadMentionDecisionSchema>;

export type ThreadMentionWarning = z.infer<typeof ThreadMentionWarningSchema>;
