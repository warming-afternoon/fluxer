// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isRegistrationFormClosed} from '../src/features/auth/flow/RegistrationFormGate.ts';

function snapshot(mode = 'closed', setupTokenRequired = true) {
	return {registration: {mode}, appPublic: {setup: {setup_token_required: setupTokenRequired}}};
}

test('a setup token lets the wizard show and submit its form while public registration is closed', () => {
	assert.equal(isRegistrationFormClosed(snapshot(), undefined, 'setup-token'), false);
});

test('ordinary closed registration stays closed, including blank setup tokens', () => {
	for (const token of [undefined, '', '   ']) {
		assert.equal(isRegistrationFormClosed(snapshot(), undefined, token), true);
	}
});

test('a stale setup token does not reopen the form after bootstrap', () => {
	for (const required of [false, undefined]) {
		const current = snapshot();
		current.appPublic.setup.setup_token_required = required;
		assert.equal(isRegistrationFormClosed(current, undefined, 'setup-token'), true);
	}
});

test('admin registration links retain their existing form access', () => {
	assert.equal(isRegistrationFormClosed(snapshot('closed', false), 'admin-link', undefined), false);
});

test('open and approval registration retain their existing form access', () => {
	for (const mode of ['open', 'approval']) {
		assert.equal(isRegistrationFormClosed(snapshot(mode, false), undefined, undefined), false);
	}
});
