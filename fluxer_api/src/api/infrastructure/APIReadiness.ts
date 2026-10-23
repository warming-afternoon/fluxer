// SPDX-License-Identifier: AGPL-3.0-or-later
let timer: ReturnType<typeof setInterval> | undefined;
let lastSuccess = Number.NEGATIVE_INFINITY;
let draining = true;
let running = false;
export function apiReady(): boolean {
	return !draining && Number.isFinite(lastSuccess) && performance.now() - lastSuccess < 15000;
}
export async function startAPIReadiness(probe: () => Promise<void>): Promise<void> {
	stopAPIReadiness();
	draining = false;
	const tick = async () => {
		if (running || draining) return;
		running = true;
		try {
			await probe();
			if (!draining) lastSuccess = performance.now();
		} catch {
			lastSuccess = Number.NEGATIVE_INFINITY;
		} finally {
			running = false;
		}
	};
	await tick();
	if (!apiReady()) throw new Error('Initial readiness dependencies unavailable');
	timer = setInterval(() => void tick(), 5000);
	timer.unref();
}
export function stopAPIReadiness(): void {
	draining = true;
	lastSuccess = Number.NEGATIVE_INFINITY;
	if (timer) clearInterval(timer);
	timer = undefined;
}
