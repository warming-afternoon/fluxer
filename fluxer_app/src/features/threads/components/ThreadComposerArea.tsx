// SPDX-License-Identifier: AGPL-3.0-or-later

import {BarrierBase} from '@app/features/channel/components/barriers/BarrierComponents';
import {ChannelTextarea} from '@app/features/channel/components/ChannelTextarea';
import type {Channel} from '@app/features/channel/models/Channel';
import {getPostForum} from '@app/features/forum/utils/ForumChannelUtils';
import * as PostD from '@app/features/forum/utils/ForumMessageDescriptors';
import * as ThreadCommands from '@app/features/threads/commands/ThreadCommands';
import styles from '@app/features/threads/components/ThreadComposerArea.module.css';
import {reportThreadActionError} from '@app/features/threads/hooks/useThreadMenuData';
import ThreadMemberships from '@app/features/threads/state/ThreadMemberships';
import ThreadWatches from '@app/features/threads/state/ThreadWatches';
import {canJoinThreadChannel, canWriteInThread} from '@app/features/threads/utils/ThreadActionRules';
import * as D from '@app/features/threads/utils/ThreadMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ArchiveIcon, ChatsIcon, LockSimpleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useCallback, useState} from 'react';

const THREAD_WATCH_ERROR_DESCRIPTORS = {
	limit: msg({
		message: 'Too many posts are open. Close another post to receive live updates here.',
		comment: 'Shown when the session exceeds its post browsing subscription limit.',
	}),
	unavailable: msg({
		message: 'Live updates are unavailable. Reconnecting…',
		comment: 'Shown while a post browsing subscription or message recovery is failing.',
	}),
	expired: msg({
		message: 'Live updates have expired. Messages may be missing while reconnecting…',
		comment: 'Shown when the confirmed post browsing lease has expired without a successful renewal.',
	}),
};

/** 呈现帖子输入区及浏览订阅不可用提示 */
export const ThreadComposerArea = observer(({thread}: {thread: Channel}) => {
	const {i18n} = useLingui();
	const [joining, setJoining] = useState(false);
	const joined = ThreadMemberships.isMember(thread.id);
	const post = getPostForum(thread) !== undefined;
	const watchError = ThreadWatches.errors.get(thread.id);
	const handleJoin = useCallback(() => {
		setJoining(true);
		void ThreadCommands.joinThread(thread)
			.catch((error) => reportThreadActionError(i18n, error))
			.finally(() => setJoining(false));
	}, [i18n, thread]);
	// 帖子锁定时也保留浏览租约提示，避免输入屏障遮住实时消息状态
	const watchNotice = post && watchError && (
		<div className={styles.notice} role="status" data-flx="threads.thread-composer-area.notice.watch">
			{i18n._(THREAD_WATCH_ERROR_DESCRIPTORS[watchError])}
		</div>
	);
	if (thread.isLocked && !canWriteInThread(thread, 'send')) {
		return (
			<>
				{watchNotice}
				<BarrierBase
					icon={<LockSimpleIcon className={styles.lockedIcon} data-flx="threads.thread-composer-area.locked-icon" />}
					message={i18n._(D.THREAD_LOCKED_NOTICE_DESCRIPTOR)}
					data-flx="threads.thread-composer-area.barrier-base.locked"
				/>
			</>
		);
	}
	return (
		<>
			{watchNotice}
			{thread.isArchived && (
				<div className={styles.notice} role="status" data-flx="threads.thread-composer-area.notice.archived">
					<ArchiveIcon className={styles.noticeIcon} data-flx="threads.thread-composer-area.archived-icon" />
					<span className={styles.noticeText} data-flx="threads.thread-composer-area.notice-text.archived">
						{i18n._(D.THREAD_ARCHIVED_NOTICE_DESCRIPTOR)}
					</span>
				</div>
			)}
			{!post && !joined && !thread.isArchived && canJoinThreadChannel(thread) && (
				<div className={styles.notice} data-flx="threads.thread-composer-area.notice.join">
					<ChatsIcon className={styles.noticeIcon} data-flx="threads.thread-composer-area.join-icon" />
					<span className={styles.noticeText} data-flx="threads.thread-composer-area.notice-text.join">
						{i18n._(D.THREAD_JOIN_NOTICE_DESCRIPTOR)}
					</span>
					<Button
						small
						fitContent
						submitting={joining}
						onClick={handleJoin}
						data-flx="threads.thread-composer-area.button.join"
					>
						{i18n._(D.JOIN_THREAD_DESCRIPTOR)}
					</Button>
				</div>
			)}
			<ChannelTextarea
				channel={thread}
				placeholder={post ? i18n._(PostD.SEND_MESSAGE_IN_POST_DESCRIPTOR, {name: thread.name ?? ''}) : undefined}
				data-flx="threads.thread-composer-area.channel-textarea"
			/>
		</>
	);
});
