import {stateDir,outputDir,project,apiContainer,pgContainer,gatewayContainer} from './environment.mjs';
import fs from 'node:fs';const root=outputDir;
const host=fs.readFileSync(root+'/host-resources.jsonl','utf8').trim().split('\n').map(JSON.parse);
for(const variant of ['baseline','metadata','combined']){
 const stageFile=root+'/'+variant+'/progression/stages.json', analysisFile=root+'/'+variant+'/api-analysis.json';if(!fs.existsSync(stageFile)||!fs.existsSync(analysisFile))continue;
 const stages=JSON.parse(fs.readFileSync(stageFile)),analysis=JSON.parse(fs.readFileSync(analysisFile));
 for(const s of stages){const g=analysis.groups[s.stage];if(!g)continue;let counts={},times={};for(const [name,q] of Object.entries(g.sql)){counts[name]=q.calls;times[name]=q.ms;}
 const start=Date.parse(s.startedAt),end=Date.parse(s.finishedAt);const samples=host.filter(r=>r.variant===variant&&Date.parse(r.utc)>=start&&Date.parse(r.utc)<=end);const cpu={};
 for(const component of ['api','postgres','gateway','push','worker']){const rows=samples.map(r=>({at:Date.parse(r.utc),s:r.containers?.find(c=>c.name===`${project}-${component}-1`)})).filter(r=>r.s);if(rows.length>1){const a=rows[0],b=rows.at(-1);cpu[component]=Math.round((b.s.cpuTotalNs-a.s.cpuTotalNs)/(b.at-a.at)/1e6*1000)/1000;}}
 console.log(JSON.stringify({variant,stage:s.stage,sends:s.totals.sendSuccess,acks:s.totals.ackSuccess,sendP95:s.latencies.sendHttpMs?.p95,ackHttpP50:s.latencies.ackHttpMs?.p50,ackHttpP95:s.latencies.ackHttpMs?.p95,ackQueueP95:s.latencies.ackQueueWaitMs?.p95,ackEndP95:s.latencies.endToEndAckMs?.p95,seconds:s.completeSeconds,queryCalls:Object.values(counts).reduce((a,b)=>a+b,0),queryMs:Object.values(times).reduce((a,b)=>a+b,0),counts,tableTimings:times,cpuCores:cpu,poolWaitingMax:g.poolWaitingMax,poolAcquireMs:g.poolAcquireMs,eventLoopP99Peak:g.eventLoopP99Peak,requests:g.requests}));
 }
}
