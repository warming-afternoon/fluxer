import {stateDir,outputDir,project,apiContainer,pgContainer,gatewayContainer} from './environment.mjs';
import fs from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import http from 'node:http';
const dir=stateDir;
const log=outputDir+'/host-resources.jsonl';
const bytes=x=>{const m=x.trim().match(/^([\d.]+)([kMGT]?i?B)$/i);if(!m)return 0;return Number(m[1])*({B:1,kB:1e3,MB:1e6,GB:1e9,TB:1e12,KiB:1024,MiB:2**20,GiB:2**30,TiB:2**40}[m[2]]??1);};
const socketPath=JSON.parse(execFileSync('docker',['context','inspect','--format','{{json .Endpoints.docker.Host}}'],{encoding:'utf8'})).replace(/^unix:\/\//,'');
const dockerJson=path=>new Promise((resolve,reject)=>{const req=http.get({socketPath,path,timeout:10000},r=>{let body='';r.on('data',x=>body+=x);r.on('end',()=>{try{if(r.statusCode!==200)throw Error('Docker API '+r.statusCode);resolve(JSON.parse(body));}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Docker stats timeout')));});
let warnings=0,monitorFailures=0;
while(!fs.existsSync(dir+'/guard.done')){
 let row={utc:new Date().toISOString(),variant:fs.readFileSync(dir+'/variant','utf8').trim()};
 try{
  row.pressure=(process.platform==='darwin'?Number(execFileSync('sysctl',['-n','kern.memorystatus_vm_pressure_level'],{encoding:'utf8',timeout:3000}).trim()):1);
  warnings=row.pressure>=2?warnings+1:0;
  const running=await dockerJson('/containers/json');
  row.containers=await Promise.all(running.map(async c=>{const s=await dockerJson('/containers/'+c.Id+'/stats?stream=false&one-shot=true');const m=s.memory_stats;return {name:c.Names[0].slice(1),memoryBytes:m.usage||0,workingSetBytes:(m.usage||0)-(m.stats?.inactive_file||0),fileCacheBytes:m.stats?.file||m.stats?.cache||0,memoryLimitBytes:m.limit,cpuTotalNs:s.cpu_stats?.cpu_usage?.total_usage};}));
  row.totalContainerBytes=row.containers.reduce((a,c)=>a+c.memoryBytes,0);
  if(process.platform==='darwin')row.swap=execFileSync('sysctl',['-n','vm.swapusage'],{encoding:'utf8',timeout:3000}).trim();else{const m=fs.readFileSync('/proc/meminfo','utf8');row.linuxMemory=Object.fromEntries([...m.matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)/gm)].map(x=>[x[1],Number(x[2])*1024]));row.pressure=row.linuxMemory.MemAvailable<Math.max(512*2**20,row.linuxMemory.MemTotal*.08)?4:1;}
  if(fs.existsSync(dir+'/generator.pid')){const pid=fs.readFileSync(dir+'/generator.pid','utf8').trim();if(/^\d+$/.test(pid)){try{row.generatorRssBytes=Number(execFileSync('ps',['-p',pid,'-o','rss='],{encoding:'utf8',timeout:3000}).trim())*1024;}catch{}}}
  const reason=row.pressure>=4?'Mac critical memory pressure':warnings>=3?'Mac warning memory pressure in three consecutive samples':row.totalContainerBytes>Number(process.env.FLUXER_BENCHMARK_TOTAL_MIB||7000)*2**20?'Container aggregate including cache over 7000 MiB':row.containers.some(c=>c.name.includes('-gateway-')&&c.memoryBytes>5200*2**20)?'Gateway over 5200 MiB':row.containers.some(c=>c.name.includes('-api-')&&c.memoryBytes>2100*2**20)?'API over 2100 MiB':row.generatorRssBytes>900*2**20?'Load generator over 900 MiB':null;
  monitorFailures=0; if(reason){row.stopReason=reason;fs.writeFileSync(dir+'/STOP',reason);fs.appendFileSync(log,JSON.stringify(row)+'\n');console.log(reason);spawnSync('sh',[dir+'/compose.sh','stop','-t','15'],{stdio:'ignore',timeout:60000});break;}
 }catch(e){row.monitorError=e.message.slice(0,180);if(++monitorFailures>=3){fs.writeFileSync(dir+'/STOP','Resource monitor unavailable');fs.appendFileSync(log,JSON.stringify(row)+'\n');break;}}
 fs.appendFileSync(log,JSON.stringify(row)+'\n');
 await sleep(5000);
}
