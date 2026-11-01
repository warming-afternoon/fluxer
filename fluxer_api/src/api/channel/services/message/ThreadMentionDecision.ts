// SPDX-License-Identifier: AGPL-3.0-or-later

import {z} from 'zod';

export const ThreadMentionWarningSchema = z.enum([
	'role_group_too_large',
	'role_union_too_large',
	'role_index_unavailable',
]);

const InternalIdSchema = z.string().regex(/^[0-9]{1,20}$/);
const AdmissionIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/);

export const ThreadMentionDecisionSchema = z
	.object({
		version: z.union([z.literal(1), z.literal(2)]),
		message_id: InternalIdSchema,
		channel_id: InternalIdSchema,
		author_id: InternalIdSchema,
		allowed_role_ids: z.array(InternalIdSchema).max(1024),
		role_user_ids: z.array(InternalIdSchema).max(3000),
		// Version 1 never authorized a durable outsider admission list.
		role_add_user_ids: z.array(AdmissionIdSchema).max(250).optional(),
		direct_user_ids: z.array(InternalIdSchema).max(1024),
		warnings: z.array(ThreadMentionWarningSchema).max(3),
	})
	.superRefine((decision, ctx) => {
		const adds = decision.role_add_user_ids ?? [];
		if (
			(decision.version === 2 && decision.role_add_user_ids === undefined) ||
			(decision.version === 1 && adds.length > 0) ||
			new Set(adds).size !== adds.length ||
			adds.some(
				(id) =>
					!decision.role_user_ids.includes(id) || decision.direct_user_ids.includes(id) || id === decision.author_id,
			)
		) {
			ctx.addIssue({code: 'custom', path: ['role_add_user_ids'], message: 'Invalid frozen role admission allowlist'});
		}
	});

export type ThreadMentionDecision = z.infer<typeof ThreadMentionDecisionSchema>;

export type ThreadMentionWarning = z.infer<typeof ThreadMentionWarningSchema>;
