// SPDX-License-Identifier: AGPL-3.0-or-later

import {isUtf8} from 'node:buffer';

/** 等待子进程及其输出管道全部关闭，再判定完整 JSON 行与真实退出状态。 */
export function collectChildJsonLines(child, {onRecord, onPartial, onFailure, maxFrameBytes = 16 * 1024 * 1024}) {
	if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw Error('Invalid frame limit');
	return new Promise((resolve) => {
		let pending = [],
			pendingBytes = 0,
			frames = 0,
			failures = 0,
			partialBytes = 0,
			stderrTail = '',
			discarding = false;
		/** 记录质量失败，不以正常进程退出掩盖无效或不完整输出。 */
		const fail = (reason) => {
			failures++;
			try {
				onFailure(reason);
			} catch {
				failures++;
			}
		};
		/** 保存未完成的原始数据，保留诊断证据而不计入完整记录。 */
		const preserve = (bytes) => {
			partialBytes += bytes.length;
			try {
				onPartial(bytes);
			} catch {
				fail('partial output could not be saved');
			}
		};
		/** 按换行分隔处理流，超限行流式留存，避免无限扩张内存。 */
		const consume = (chunk) => {
			let start = 0;
			while (start < chunk.length) {
				const newline = chunk.indexOf(10, start);
				const end = newline < 0 ? chunk.length : newline;
				const fragment = chunk.subarray(start, end);
				if (discarding) {
					preserve(chunk.subarray(start, newline < 0 ? end : end + 1));
				} else {
					pending.push(fragment);
					pendingBytes += fragment.length;
					if (pendingBytes > maxFrameBytes) {
						fail('JSON frame exceeds byte limit');
						for (const part of pending) preserve(part);
						if (newline >= 0) preserve(Buffer.from('\n'));
						pending = [];
						pendingBytes = 0;
						discarding = true;
					} else if (newline >= 0) {
						const frame = Buffer.concat(pending, pendingBytes);
						try {
							if (!isUtf8(frame)) throw Error('Invalid UTF-8');
							const row = JSON.parse(frame.toString('utf8'));
							if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('Expected JSON object');
							onRecord(row);
							frames++;
						} catch (error) {
							fail(`Invalid JSON record or output sink: ${error.message}`);
							preserve(frame);
							preserve(Buffer.from('\n'));
						}
						pending = [];
						pendingBytes = 0;
					}
				}
				if (newline >= 0) discarding = false;
				start = end + 1;
			}
		};
		child.stdout.on('data', consume);
		child.stdout.on('error', (error) => fail(`stdout error: ${error.message}`));
		child.stderr?.on('data', (chunk) => {
			stderrTail = (stderrTail + chunk.toString()).slice(-4096);
		});
		child.stderr?.on('error', (error) => fail(`stderr error: ${error.message}`));
		child.on('error', (error) => fail(`spawn error: ${error.message}`));
		child.once('close', (code, signal) => {
			// close 在 stdio 关闭之后触发；exit 或 EOF 都不是完整收尾证明。
			if (pendingBytes > 0 || discarding) {
				for (const part of pending) preserve(part);
				fail('Unterminated JSON frame');
			}
			if (code !== 0 || signal) fail(`Child failed: ${JSON.stringify({code, signal})}`);
			resolve({ok: failures === 0, frames, failures, partialBytes, code, signal, stderrTail});
		});
	});
}
