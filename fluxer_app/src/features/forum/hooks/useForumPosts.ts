// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import ForumPosts, {canRequestForumPosts, type ForumListState} from '@app/features/forum/state/ForumPosts';
import ForumReadState from '@app/features/forum/state/ForumReadState';
import GatewaySessions from '@app/features/gateway/transport/GatewaySessionPool';
import * as ReadStateCommands from '@app/features/read_state/commands/ReadStateCommands';
import ReadStates from '@app/features/read_state/state/ReadStates';
import ChannelThreads from '@app/features/threads/state/ChannelThreads';
import Window from '@app/features/window/state/Window';
import {useEffect} from 'react';

export interface ForumPostListView {
	searching: boolean;
	pinned: Channel | null;
	posts: ReadonlyArray<Channel>;
	archived: ReadonlyArray<Channel>;
	list: ForumListState;
}

function resolvePosts(forumId: string, ids: ReadonlyArray<string>): Array<Channel> {
	const posts: Array<Channel> = [];
	for (const id of ids) {
		const post = ChannelThreads.getThread(id);
		if (post?.parentId === forumId) posts.push(post);
	}
	return posts;
}

export function getForumPostListView(forum: Channel): ForumPostListView {
	const searching = ForumPosts.isSearching(forum.id);
	if (searching) {
		const list = ForumPosts.getList(forum.id, 'search');
		return {searching, pinned: null, posts: resolvePosts(forum.id, list.ids), archived: [], list};
	}
	const active = ForumPosts.getList(forum.id, 'active');
	const archived = ForumPosts.getList(forum.id, 'archived');
	const pinned = active.pinnedId ? (ChannelThreads.getThread(active.pinnedId) ?? null) : null;
	return {
		searching,
		pinned,
		posts: resolvePosts(forum.id, active.ids).filter((post) => post.id !== pinned?.id),
		archived: resolvePosts(forum.id, archived.ids).filter((post) => post.id !== pinned?.id),
		list: active,
	};
}

function requestPostUnreads(forum: Channel, postIds: ReadonlyArray<string>): void {
	if (!forum.guildId || !canRequestForumPosts(forum)) return;
	if (!GatewaySessions.foregroundConnection.socket?.isConnected()) return;
	ForumReadState.requestPostUnreads(forum.guildId, forum.id, postIds);
}

export function usePostDataPrefetch(forum: Channel, posts: ReadonlyArray<Channel>): void {
	const key = posts.map((post) => post.id).join(',');
	const previewVersion = ForumPosts.previewVersion;
	const viewing = ForumPosts.isViewing(forum.id);
	useEffect(() => {
		if (!key) return;
		const postIds = key.split(',');
		ForumPosts.requestPostData(forum, postIds);
		requestPostUnreads(forum, postIds);
	}, [forum, key, previewVersion, viewing]);
}

export function useForumViewing(forum: Channel): void {
	const forumId = forum.id;
	const connectionVersion = ForumPosts.connectionVersion;
	const canRequest = canRequestForumPosts(forum);
	useEffect(() => {
		if (!canRequest) ForumPosts.purgeForum(forum.id, ChannelThreads.getThreadIdsForParent(forum.id));
	}, [forum.id, canRequest]);
	useEffect(() => {
		const release = ForumPosts.beginViewing(forumId);
		ForumReadState.beginViewing(forumId);
		return () => {
			release();
			if (!ForumPosts.isViewing(forumId)) ForumReadState.endViewing(forumId);
		};
	}, [forumId]);
	useEffect(() => {
		if (ForumPosts.isSearching(forum.id)) ForumPosts.loadMore(forum, 'search');
	}, [forum, connectionVersion]);
	const lastMessageId = ReadStates.lastMessageId(forumId);
	const unread = ReadStates.hasUnread(forumId);
	const focused = Window.focused;
	useEffect(() => {
		if (focused && unread && Channels.getChannel(forumId)) ReadStateCommands.ack(forumId);
	}, [forumId, lastMessageId, unread, focused]);
}
