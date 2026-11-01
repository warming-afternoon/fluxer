// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/channel/components/ThreadMentionWarning.module.css';
import type {Channel} from '@app/features/channel/models/Channel';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {InfoIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

const warningDescriptors = {
	role_group_too_large: msg({
		message: 'Some role notifications were skipped because a mentioned role exceeds the size limit.',
		comment: 'Non-blocking note beside a thread message. Do not include audience counts.',
	}),
	role_union_too_large: msg({
		message: 'Role notifications were skipped because the combined audience exceeds the size limit.',
		comment: 'Non-blocking note beside a thread message. Do not include audience counts.',
	}),
	role_index_unavailable: msg({
		message: 'Role notifications were skipped because role information is temporarily unavailable.',
		comment: 'Non-blocking note beside a thread message. Do not promise a later notification retry.',
	}),
};

interface ThreadMentionWarningProps {
	// 当前消息只提供公开原因，不包含内部角色候选身份。
	message: Pick<Message, 'threadMentionWarnings'>;

	// 普通频道不显示帖子专用说明。
	channel: Pick<Channel, 'isThread'>;
}

/** 仅按专用原因显示非阻塞说明，不把旧消息flags解释为新决策。 */
export const ThreadMentionWarning = observer(({message, channel}: ThreadMentionWarningProps) => {
	const {i18n} = useLingui();
	if (!channel.isThread()) return null;
	const warnings = [...new Set(message.threadMentionWarnings)].filter((reason) => warningDescriptors[reason] != null);
	if (warnings.length === 0) return null;
	return (
		<div
			className={styles.note}
			role="note"
			data-message-copy-hidden="true"
			data-flx="channel.thread-mention-warning.note"
		>
			<InfoIcon className={styles.icon} aria-hidden="true" data-flx="channel.thread-mention-warning.icon" />
			<ul className={styles.reasons} data-flx="channel.thread-mention-warning.reasons">
				{warnings.map((reason) => (
					<li key={reason} data-flx="channel.thread-mention-warning.reason">
						{i18n._(warningDescriptors[reason])}
					</li>
				))}
			</ul>
		</div>
	);
});
