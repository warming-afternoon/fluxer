import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {collectChildJsonLines} from './ChildJsonLines.mjs';
import {apiContainer, outputDir, stateDir} from './environment.mjs';

const code = `setInterval(async()=>{const result={utc:new Date().toISOString()};for(const [name,url]of [['api','http://127.0.0.1:8080/_metrics'],['push','http://push:8126/_metrics']]){try{const r=await fetch(url,{signal:AbortSignal.timeout(1500)});const t=await r.text();result[name]={status:r.status,metrics:Object.fromEntries(t.split('\\n').filter(l=>/^fluxer_(read_state_batch_|channel_metadata_|push_(subscription_batch_|jobs_|rpc_requests_))/.test(l)).map(l=>{const i=l.lastIndexOf(' ');return[l.slice(0,i),Number(l.slice(i+1))];}))};}catch(e){result[name]={error:e.name};}}console.log(JSON.stringify(result));},2000);`;
const child = spawn('docker', ['exec', apiContainer, 'node', '--input-type=module', '-e', code], {
	stdio: ['ignore', 'pipe', 'pipe'],
});
const output = `${outputDir}/service-metrics.jsonl`;
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
	console.error(JSON.stringify({probe: 'service-metrics', ...result}));
	process.exitCode = 1;
}
