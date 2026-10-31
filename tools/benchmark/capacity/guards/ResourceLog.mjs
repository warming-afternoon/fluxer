// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';

/** 显式启用才打开追加日志；单写者锁、行数与字节预算限制观察成本。 */
export function openResourceLog({enabled = false, file, maxRows, maxBytes} = {}) {
	if (typeof enabled !== 'boolean') throw Error('Observation enable flag must be boolean');
	if (!enabled) return {enabled: false, append: () => false, close: () => ({rows: 0, bytes: 0, enabled: false})};
	if (
		typeof file !== 'string' ||
		!file ||
		!Number.isSafeInteger(maxRows) ||
		maxRows < 1 ||
		maxRows > 100000 ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > 64 * 1024 ** 2
	)
		throw Error('Explicit bounded resource log configuration required');
	const lock = `${file}.lock`;
	const lockFd = fs.openSync(lock, 'wx', 0o600);
	let fd;
	try {
		fd = fs.openSync(
			file,
			fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > maxBytes) throw Error('Resource log is not a bounded regular file');
		const prior = Buffer.alloc(stat.size);
		let read = 0;
		while (read < prior.length) {
			const count = fs.readSync(fd, prior, read, prior.length - read, read);
			if (count === 0) throw Error('Resource log changed during opening');
			read += count;
		}
		if (prior.length && prior.at(-1) !== 10)
			throw Error('Existing resource log has partial tail; preserve it before resuming');
		let rows = prior.filter((byte) => byte === 10).length;
		let bytes = prior.length;
		let closed = false;
		let failed = false;
		if (rows > maxRows) throw Error('Existing resource log exceeds row budget');
		return {
			enabled: true,
			/** 完整编码后检查预算；超限拒绝该记录，不清空历史或补造采样。 */
			append(record) {
				if (closed) throw Error('Resource log closed');
				if (!record || typeof record !== 'object' || Array.isArray(record))
					throw Error('Resource record must be an object');
				const data = Buffer.from(
					`${JSON.stringify(record, (_, value) => (typeof value === 'bigint' ? value.toString() : value))}\n`,
				);
				if (rows >= maxRows || bytes + data.length > maxBytes) return false;
				let written = 0;
				try {
					while (written < data.length) {
						const count = fs.writeSync(fd, data, written, data.length - written);
						if (count <= 0) throw Error('Resource log write made no progress');
						written += count;
					}
				} catch (error) {
					// 留存可能写出的 partial，关闭写端；不得继续把半行当成完整记录。
					closed = true;
					failed = true;
					bytes += written;
					fs.closeSync(fd);
					fs.closeSync(lockFd);
					fs.unlinkSync(lock);
					throw error;
				}
				rows++;
				bytes += written;
				return true;
			},
			/** 关闭仅释放本实例的锁，不删除或重写采样日志。 */
			close() {
				if (!closed) {
					closed = true;
					fs.closeSync(fd);
					fs.closeSync(lockFd);
					fs.unlinkSync(lock);
				}
				return {rows, bytes, failed, enabled: true};
			},
		};
	} catch (error) {
		if (fd !== undefined) fs.closeSync(fd);
		fs.closeSync(lockFd);
		fs.unlinkSync(lock);
		throw error;
	}
}

/** 只读取有界尾部的最近完整记录，正在写入的 partial 不作为新鲜样本。 */
export function readLatestResourceRecord(file, {maxTailBytes = 65536} = {}) {
	if (!Number.isSafeInteger(maxTailBytes) || maxTailBytes < 2 || maxTailBytes > 16 * 1024 ** 2)
		throw Error('Bounded resource tail size required');
	const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) throw Error('Regular resource log required');
		const length = Math.min(stat.size, maxTailBytes),
			offset = stat.size - length;
		const bytes = Buffer.alloc(length);
		const count = fs.readSync(fd, bytes, 0, length, offset);
		if (count !== length) throw Error('Resource log changed while reading');
		const end = bytes.lastIndexOf(10);
		if (end < 0) throw Error('No complete resource record in bounded tail');
		const separator = end > 0 ? bytes.lastIndexOf(10, end - 1) : -1;
		if (separator < 0 && offset > 0) throw Error('Complete resource record exceeds bounded tail');
		const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(separator + 1, end));
		const record = JSON.parse(text);
		if (!record || typeof record !== 'object' || Array.isArray(record))
			throw Error('Resource record must be an object');
		return record;
	} finally {
		fs.closeSync(fd);
	}
}
