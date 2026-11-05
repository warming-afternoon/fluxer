// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RuntimeConfigSnapshot} from '@app/features/app/state/InstanceSnapshotStore';

/** 根据公开注册策略、注册链接和初始化令牌判断是否关闭注册表单。 */
export function isRegistrationFormClosed(
	snapshot: Pick<RuntimeConfigSnapshot, 'registration' | 'appPublic'>,
	registrationUrlCode: string | undefined,
	setupToken: string | undefined,
): boolean {
	// 此处仅允许展示初始化表单，令牌校验和管理员初始化的原子认领由接口执行。
	const setupRegistration = snapshot.appPublic.setup.setup_token_required === true && Boolean(setupToken?.trim());
	return snapshot.registration.mode === 'closed' && !registrationUrlCode && !setupRegistration;
}
