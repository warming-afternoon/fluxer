// SPDX-License-Identifier: AGPL-3.0-or-later

import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import {Logger} from '@app/api/Logger';

/** 用短租约登记实际运行的新版本组件，未注册或过期组件不能启用角色决策。 */
export class ThreadMentionComponentLease {
	private readonly instanceId = process.env.FLUXER_THREAD_MENTION_INSTANCE_ID?.trim() ?? '';

	private warnedInvalidIdentity = false;

	private timer: ReturnType<typeof setInterval> | undefined;

	private publishing = false;

	constructor(
		private readonly gateway: IGatewayService,
		private readonly component: 'api' | 'worker',
	) {}

	/** 发布失败只使角色能力降级，不改变业务异常传播。 */
	start(): void {
		if (this.timer) return;
		// 身份由部署固定，重启不能用新随机值填补缺失的旧版本副本。
		if (!/^[A-Za-z0-9._:-]+$/.test(this.instanceId) || Buffer.byteLength(this.instanceId, 'utf8') > 128) {
			if (!this.warnedInvalidIdentity) {
				Logger.warn(
					{component: this.component},
					'Stable FLUXER_THREAD_MENTION_INSTANCE_ID is required for role capability',
				);
				this.warnedInvalidIdentity = true;
			}
			return;
		}
		void this.publish();
		this.timer = setInterval(() => {
			void this.publish();
		}, 15000);
		this.timer.unref();
	}

	/** 停止续租，网关在最长六十秒后自然移除能力。 */
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** 防止慢网关令周期注册重叠积压。 */
	private async publish(): Promise<void> {
		if (this.publishing) return;
		this.publishing = true;
		try {
			await this.gateway.registerThreadMentionComponent(this.instanceId, this.component);
		} catch (error) {
			Logger.warn({error, component: this.component}, 'Thread mention component lease unavailable');
		} finally {
			this.publishing = false;
		}
	}
}
