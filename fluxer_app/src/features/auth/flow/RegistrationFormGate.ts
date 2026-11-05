// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RuntimeConfigSnapshot} from '@app/features/app/state/InstanceSnapshotStore';

export function isRegistrationFormClosed(
	snapshot: Pick<RuntimeConfigSnapshot, 'registration' | 'appPublic'>,
	registrationUrlCode: string | undefined,
	setupToken: string | undefined,
): boolean {
	// Only show the setup form here. The API verifies the token and claims the bootstrap atomically.
	const setupRegistration = snapshot.appPublic.setup.setup_token_required === true && Boolean(setupToken?.trim());
	return snapshot.registration.mode === 'closed' && !registrationUrlCode && !setupRegistration;
}
