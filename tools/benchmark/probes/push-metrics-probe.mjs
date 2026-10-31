import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {collectChildJsonLines} from './ChildJsonLines.mjs';
import {outputDir, project, stateDir} from './environment.mjs';

const code = `setInterval(async()=>{try{const r=await fetch('http://127.0.0.1:8126/_metrics',{signal:AbortSignal.timeout(1500)});const t=await r.text();console.log(JSON.stringify({utc:new Date().toISOString(),status:r.status,metrics:Object.fromEntries(t.split('\\n').filter(l=>/^fluxer_push_(subscription_batch_|jobs_|rpc_requests_)/.test(l)).map(l=>{const i=l.lastIndexOf(' ');return[l.slice(0,i),Number(l.slice(i+1))];}))}));}catch(e){console.log(JSON.stringify({utc:new Date().toISOString(),error:e.name}));}},2000);`;
const child = spawn(
	'docker',
	[
		'run',
		'--rm',
		'--name',
		'fluxer-benchmark-push-metrics',
		'--memory=96m',
		'--cpus=0.15',
		'--pids-limit=32',
		'--read-only',
		'--network',
		`container:${project}-push-1`,
		'--entrypoint',
		'node',
		process.env.FLUXER_BENCHMARK_TOOLS_IMAGE || 'node:24-alpine',
		'--max-old-space-size=24',
		'--input-type=module',
		'-e',
		code,
	],
	{stdio: ['ignore', 'pipe', 'pipe']},
);
const output = `${outputDir}/push-metrics.jsonl`;
const result = await collectChildJsonLines(child, {
	/** 每条完整指标追加写入，失败不会静默丢弃。 */
	onRecord(row) {
		row.variant = fs.readFileSync(`${stateDir}/variant`, 'utf8').trim();
		fs.appendFileSync(output, `${JSON.stringify(row)}\n`);
	},
	/** 不完整输出单独保留，不冒充完整指标。 */
	onPartial(text) {
		fs.appendFileSync(`${output}.partial`, text, {mode: 0o600});
	},
	/** 质量失败写入独立日志，成功退出不能覆盖失败。 */
	onFailure(reason) {
		fs.appendFileSync(`${output}.errors.jsonl`, `${JSON.stringify({utc: new Date().toISOString(), reason})}\n`, {
			mode: 0o600,
		});
	},
});
if (!result.ok) {
	console.error(JSON.stringify({probe: 'push-metrics', ...result}));
	process.exitCode = 1;
}
