// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {GatewayService} from '@app/api/infrastructure/GatewayService';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';

interface VoiceState {
	user_id: string;
	session_id: string;
	self_mute: boolean;
	self_deaf: boolean;
	self_video: boolean;
	viewer_stream_keys?: Array<string>;
}

export interface CallData {
	channel_id: string;
	message_id: string;
	region: string;
	ringing: Array<string>;
	recipients: Array<string>;
	voice_states: Array<VoiceState>;
}

export interface CallCaller {
	id: string;
	name: string;
	avatar: string | null;
}

export function callCallerRpcParams(caller: CallCaller | undefined): Record<string, unknown> {
	if (!caller) {
		return {};
	}
	return {caller_id: caller.id, caller_name: caller.name, caller_avatar: caller.avatar};
}

interface GatewayGuildMemoryStatsEntry {
	node_id: string;
	guild_id: string | null;
	guild_name: string;
	guild_icon: string | null;
	memory: string;
	member_count: number;
	session_count: number;
	presence_count: number;
}

export interface GatewayGuildMemoryStats {
	guilds: Array<GatewayGuildMemoryStatsEntry>;
}

interface GatewayNodeMemoryStats {
	total: string;
	processes: string;
	system: string;
}

interface GatewayNodeStatsEntry {
	node_id: string;
	status: string;
	sessions: number;
	session_resumes_total: number | null;
	websocket_dispatches_total: number | null;
	websocket_dispatch_drops_total: number | null;
	guilds: number;
	presences: number;
	calls: number;
	memory: GatewayNodeMemoryStats;
	process_count: number;
	process_limit: number;
	uptime_seconds: number;
}

export interface GatewayNodeStats {
	status: string;
	sessions: number;
	session_resumes_total: number;
	websocket_dispatches_total: number;
	websocket_dispatch_drops_total: number;
	guilds: number;
	presences: number;
	calls: number;
	memory: GatewayNodeMemoryStats;
	process_count: number;
	process_limit: number;
	uptime_seconds: number;
	node_count: number;
	nodes: Array<GatewayNodeStatsEntry>;
}

interface GatewayVoiceStateRegionCount {
	region_id: string;
	voice_state_count: number;
}

interface GatewayVoiceStateServerCount {
	server_id: string;
	voice_state_count: number;
}

export interface GatewayVoiceStateCounts {
	total_voice_states: number;
	regions: Array<GatewayVoiceStateRegionCount>;
	servers: Array<GatewayVoiceStateServerCount>;
}

export interface GatewayVoiceStateEntry {
	connectionId: string;
	userId: string;
	channelId: string;
	regionId?: string;
	serverId?: string;
}

/** 网关返回的频道上下文及可选合并授权结果。 */
export interface GuildChannelAuthContext {
	/** 当前请求对应的公会信息。 */
	guild: GuildResponse;

	/** 内容分级判断所需的父频道。 */
	parentChannel: ChannelResponse | null;

	/** 合并协议验证通过后提供的成员与权限快照。 */
	authorization?: {
		/** 成员查询结果，缺失成员仍交由调用方执行原有拒绝。 */
		memberResult: {
			/** 是否查询到目标成员。 */
			success: boolean;

			/** 查询成功时的成员资料。 */
			memberData?: import('@fluxer/schema/src/domains/guild/GuildMemberSchemas').GuildMemberResponse;
		};

		/** 指定权限目标的位集合。 */
		permissions: bigint;
	};
}

export interface GatewayChannelMention {
	id: string;
	name: string;
	type: number;
}

export interface GatewayMentionSourceEntry {
	userId: UserID;
	direct: boolean;
	role: boolean;
	everyone: boolean;
}

export interface GatewayMentionSourcesPage {
	mentions: Array<GatewayMentionSourceEntry>;
	nextCursor: string | null;
}

export type IGatewayService = Omit<GatewayService, 'destroy'>;
