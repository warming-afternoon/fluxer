// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ThreadRepository} from '@app/api/channel/repositories/ThreadRepository';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {ThreadState} from '@app/api/models/ThreadState';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';

/** 首次准备完整受众；部分清理后的重试只能复用持久化原票据，不能重读残缺名单。 */
export async function prepareThreadDeletion(
	threads: ThreadRepository,
	gateway: IGatewayService,
	state: ThreadState,
): Promise<{ticket: string; preparedVersion: number}> {
	if (state.deleting && (!state.deleteTicket || state.deletePreparedVersion === null))
		throw new ServiceUnavailableError();
	if (state.deleteDispatched && state.deleteTicket && state.deletePreparedVersion !== null) {
		return {ticket: state.deleteTicket, preparedVersion: state.deletePreparedVersion};
	}
	const preparedVersion = state.deleting ? state.deletePreparedVersion! : state.stateVersion;
	const resumeTicket = state.deleting ? state.deleteTicket! : undefined;
	const ticket = await gateway.prepareThreadLifecycle(state.guildId, state.threadId, preparedVersion, resumeTicket);
	if (resumeTicket !== undefined && ticket !== resumeTicket) throw new ServiceUnavailableError();
	await threads.beginDelete(state.threadId, state.stateVersion, ticket, preparedVersion);
	return {ticket, preparedVersion};
}
