// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {loadThreadWatchContexts} from '@app/api/channel/services/thread/ThreadRpcData';
import type {ThreadState} from '@app/api/models/ThreadState';
import {describe, expect, it, vi} from 'vitest';

describe('浏览帖子上下文批量读取', () => {
	it('去重后仅批量读取一次，允许归档但排除其他服务器和私有线程', async () => {
		const guildId = createGuildID(1n);
		const ids = [20n, 21n, 22n, 23n].map(createChannelID);
		const states = ids.map((threadId, index) => ({
			threadId,
			parentId: createChannelID(100n),
			guildId: index === 2 ? createGuildID(2n) : guildId,
			type: index === 3 ? 12 : 11,
			archived: index === 1,
		})) as Array<ThreadState>;
		const getStates = vi.fn(async () => states);
		const repository = {threads: {getStates}} as unknown as ChannelRepository;
		const result = await loadThreadWatchContexts(repository, guildId, [...ids, ids[0]!]);
		expect(getStates).toHaveBeenCalledExactlyOnceWith(ids);
		expect(result).toEqual([
			{id: '20', guild_id: '1', parent_id: '100', type: 11},
			{id: '21', guild_id: '1', parent_id: '100', type: 11},
		]);
	});
});
