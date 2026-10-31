// SPDX-License-Identifier: AGPL-3.0-or-later

import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {collectChildJsonLines} from '../../probes/ChildJsonLines.mjs';

/** 使用共享有界解析器连接请求响应，完成事件必须等待子进程 close 与输出排空。 */
export class JsonLineWorkerPort extends EventEmitter {
	/** 明确注入 partial 持久化回调；命令、身份和输出位置均由调用者配置。 */
	constructor({
		workerId,
		command,
		args = [],
		cwd,
		env,
		onPartial,
		maxFrameBytes = 16 * 1024 * 1024,
		maxPending = 1024,
		maxQueuedBytes = 32 * 1024 * 1024,
	} = {}) {
		super();
		if (typeof workerId !== 'string' || !workerId || typeof command !== 'string' || !command)
			throw new TypeError('workerId and command required');
		if (typeof onPartial !== 'function') throw new TypeError('onPartial evidence sink required');
		if (
			!Number.isSafeInteger(maxFrameBytes) ||
			maxFrameBytes < 1 ||
			!Number.isSafeInteger(maxPending) ||
			maxPending < 1
		)
			throw new RangeError('Invalid transport bounds');
		if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < maxFrameBytes)
			throw new RangeError('Invalid write queue bound');
		this.workerId = workerId;
		this.maxFrameBytes = maxFrameBytes;
		this.maxPending = maxPending;
		this.maxQueuedBytes = maxQueuedBytes;
		this.queuedBytes = 0;
		this.pending = new Map();
		this.closed = false;
		this.terminalFailure = null;
		this.framesRead = 0;
		this.framesWritten = 0;
		this.child = spawn(command, args, {cwd, env: {...process.env, ...env}, stdio: ['pipe', 'pipe', 'pipe']});
		this.child.stdin.on('error', (error) => this.fail(new Error(`Worker stdin failed: ${error.code ?? 'unknown'}`)));
		this.completion = collectChildJsonLines(this.child, {
			maxFrameBytes,
			onPartial,
			onFailure: (reason) => this.fail(new Error(reason)),
			onRecord: (packet) => this.consume(packet),
		}).then((result) => {
			this.closed = true;
			this.rejectAll(this.terminalFailure ?? new Error(`Worker closed with code ${result.code}; no matching response`));
			const final = {...result, ok: result.ok && !this.terminalFailure, workerId: this.workerId, processClosed: true};
			// 兼容旧事件名，但它只表示进程与管道结束，不能证明 WebSocket clean close。
			this.emit('exit', final);
			this.emit('close', final);
			return final;
		});
	}

	/** 注册有界等待，避免同一请求键覆盖或退出后挂起。 */
	waitFor(type, requestId, timeoutMs = 30_000) {
		if (typeof type !== 'string' || typeof requestId !== 'string' || !type || !requestId)
			throw new TypeError('Response type and requestId required');
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
			throw new RangeError('Invalid response timeout');
		const key = JSON.stringify([type, requestId]);
		if (this.pending.has(key)) throw new Error('Duplicate pending response');
		if (this.closed || this.terminalFailure) return Promise.reject(this.terminalFailure ?? new Error('Worker closed'));
		if (this.pending.size >= this.maxPending) throw new RangeError('Pending response bound exceeded');
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(key);
				reject(new Error('Worker response timeout'));
			}, timeoutMs);
			this.pending.set(key, {resolve, reject, timer, requestId});
		});
	}

	/** 发送完整控制帧，写入回调而非 write 返回值决定写入完成。 */
	send(message) {
		if (this.closed || this.terminalFailure || this.child.stdin.writableEnded)
			return Promise.reject(this.terminalFailure ?? new Error('Worker input closed'));
		const frame = `${JSON.stringify(message)}\n`;
		if (Buffer.byteLength(frame) > this.maxFrameBytes)
			return Promise.reject(new RangeError('Control frame exceeds byte bound'));
		const bytes = Buffer.byteLength(frame);
		if (this.queuedBytes + bytes > this.maxQueuedBytes)
			return Promise.reject(new RangeError('Control queue byte bound exceeded'));
		this.queuedBytes += bytes;
		return new Promise((resolve, reject) => {
			this.child.stdin.write(frame, (error) => {
				this.queuedBytes -= bytes;
				if (error) {
					this.fail(error);
					reject(error);
				} else {
					this.framesWritten++;
					resolve();
				}
			});
		});
	}

	/** 先注册后写入，写入失败立即移除等待者。 */
	async request(type, requestId, message, timeoutMs = 30_000) {
		const response = this.waitFor(type, requestId, timeoutMs);
		response.catch(() => {});
		try {
			await this.send(message);
		} catch (error) {
			const key = JSON.stringify([type, requestId]);
			const pending = this.pending.get(key);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(key);
				pending.reject(error);
			}
			throw error;
		}
		return response;
	}

	/** 输入 EOF 仅请求子进程收尾，完成必须等待 completion。 */
	end() {
		if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
	}

	/** 取消只作用于本实例持有的子进程输入，不按名称或 PID 扫描外部进程。 */
	cancel(reason = 'Worker cancelled') {
		this.fail(new Error(reason));
		this.end();
		return this.completion;
	}

	/** 验证响应身份，错误响应只拒绝相同 requestId，不泄露私有错误文本。 */
	consume(packet) {
		if (this.terminalFailure) throw this.terminalFailure;
		if (packet.workerId != null && packet.workerId !== this.workerId) throw new Error('Worker identity mismatch');
		if (typeof packet.type !== 'string' || (packet.requestId != null && typeof packet.requestId !== 'string'))
			throw new Error('Malformed worker response identity');
		this.framesRead++;
		if (packet.type === 'worker_command_error') {
			for (const [key, pending] of this.pending) {
				if (pending.requestId !== packet.requestId) continue;
				clearTimeout(pending.timer);
				this.pending.delete(key);
				pending.reject(new Error('Worker command failed'));
			}
		} else {
			const key = JSON.stringify([packet.type, packet.requestId]);
			const pending = this.pending.get(key);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(key);
				pending.resolve(packet);
			}
		}
		this.emit('packet', packet);
	}

	/** 第一项终止失败保留至完成结果，后续请求不能重新进入。 */
	fail(error) {
		this.terminalFailure ??= error;
		this.rejectAll(this.terminalFailure);
	}

	/** 释放全部等待和 timer，不把进程关闭伪装为成功响应。 */
	rejectAll(error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
