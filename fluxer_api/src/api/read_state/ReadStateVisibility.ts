// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {isNsfwVisibilityGuild, NsfwVisibility} from '@app/api/channel/utils/NsfwVisibility';
import {viewerActive} from '@app/api/experiment/ChannelThreadsGate';
import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import type {ReadState} from '@app/api/models/ReadState';
import {forumNsfwGuildId} from '@app/api/user/NsfwDisplayScope';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';

export function visibleReadStates(
	readStates: Array<ReadState>,
	viewer: {userId: UserID; capable: boolean; bot?: boolean},
): Array<ReadState> {
	if (!readStates.some((readState) => readState.isMarked)) return readStates;
	const threadViewer = {
		kind: 'user',
		userId: viewer.userId,
		bot: viewer.bot === true,
		capable: viewer.capable,
	} as const;
	return readStates.filter((readState) => readState.guildId === null || viewerActive(threadViewer, readState.guildId));
}

/** Filter both marked threads and legacy unmarked channel read states using authoritative channel data. */
export async function filterNsfwReadStates(
	readStates: Array<ReadState>,
	userId: UserID,
	channelRepository: ChannelRepository = new ChannelRepository(),
	guildRepository: GuildRepository = new GuildRepository(),
): Promise<Array<ReadState>> {
	if (!forumNsfwGuildId() || readStates.length === 0) return readStates;
	const candidates = readStates.filter((state) => state.guildId === null || isNsfwVisibilityGuild(state.guildId));
	const channels = await channelRepository.channelData
		.listChannels(candidates.map((state) => state.channelId))
		.catch((error: unknown) => {
			throw new ServiceUnavailableError({
				message: 'Read-state channel visibility is temporarily unavailable',
				cause: error instanceof Error ? error : undefined,
			});
		});
	const allowed = new Set(
		(await new NsfwVisibility(userId, channelRepository, guildRepository).filter(channels)).map(
			(channel) => channel.id,
		),
	);
	const known = new Set(channels.map((channel) => channel.id));
	return readStates.filter((state) => {
		if (known.has(state.channelId)) return allowed.has(state.channelId);
		// Legacy unscoped metadata cannot prove that a missing channel is outside the target.
		return state.guildId !== null && !isNsfwVisibilityGuild(state.guildId);
	});
}
