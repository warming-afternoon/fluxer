// Temporary test-instance preload. Aggregate timings only; no SQL values,
// request bodies, credentials, user IDs or complete URLs are recorded.
'use strict';
const fs=require('node:fs');
const http=require('node:http');
const {AsyncLocalStorage}=require('node:async_hooks');
const {createRequire}=require('node:module');
const {performance,monitorEventLoopDelay}=require('node:perf_hooks');
const localRequire=createRequire('/usr/src/app/fluxer_api/package.json');
const pg=localRequire('pg');
const storage=new AsyncLocalStorage();
const output='/tmp/loadtest-api-diagnostics.jsonl';
const lag=monitorEventLoopDelay({resolution:10});lag.enable();
let buffer=[],lastStage='warmup';
function flush(){if(buffer.length){fs.appendFileSync(output,buffer.join('\n')+'\n',{mode:0o600});buffer=[];}}
function record(row){buffer.push(JSON.stringify(row));if(buffer.length>=1000)flush();}
setInterval(()=>{record({kind:'eventLoop',at:new Date().toISOString(),stage:lastStage,
  p99Ms:lag.percentile(99)/1e6,maxMs:lag.max/1e6,rssMiB:process.memoryUsage().rss/1048576});lag.reset();flush();},1000).unref();
process.once('exit',flush);

const emit=http.Server.prototype.emit;
http.Server.prototype.emit=function(event,...args){
  if(event!=='request')return emit.call(this,event,...args);
  const [req,res]=args;
  const path=(req.url||'').split('?')[0];
  const route=req.method==='POST'&&/^\/(?:(?:api\/)?v1\/|api\/)?channels\/\d+\/messages$/.test(path)?'send':
    req.method==='POST'&&/^\/(?:(?:api\/)?v1\/|api\/)?channels\/\d+\/messages\/\d+\/ack$/.test(path)?'ack':'other';
  const stage=String(req.headers['x-loadtest-stage']||'unlabelled').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,140);
  if(stage!=='unlabelled')lastStage=stage;
  const ctx={route,stage,sqlCalls:0,sqlMs:0,sqlMaxMs:0,poolAcquires:0,poolWaitMs:0,statements:{},done:false};
  const start=performance.now();
  res.once('finish',()=>{
    ctx.done=true;
    if(stage!=='unlabelled')record({kind:'request',at:new Date().toISOString(),stage,route,status:res.statusCode,
      serverMs:performance.now()-start,sqlCalls:ctx.sqlCalls,sqlMs:ctx.sqlMs,sqlMaxMs:ctx.sqlMaxMs,
      poolAcquires:ctx.poolAcquires,poolWaitMs:ctx.poolWaitMs,statements:ctx.statements});
  });
  return storage.run(ctx,()=>emit.call(this,event,...args));
};

function wrap(target,key,onComplete){
  const original=target[key];
  target[key]=function(...args){
    const ctx=storage.getStore();
    if(!ctx||ctx.done)return original.apply(this,args);
    const start=performance.now();let ended=false;
    const done=()=>{if(!ended){ended=true;if(!ctx.done)onComplete(ctx,performance.now()-start,args);}};
    const i=args.length-1;
    if(typeof args[i]==='function'){
      const callback=args[i];args[i]=function(...values){done();return storage.run(ctx,()=>callback.apply(this,values));};
      try{return original.apply(this,args);}catch(e){done();throw e;}
    }
    try{
      const result=original.apply(this,args);
      if(result&&typeof result.then==='function')return result.then(value=>{done();return value;},error=>{done();throw error;});
      done();return result;
    }catch(e){done();throw e;}
  };
}
wrap(pg.Client.prototype,'query',(ctx,ms,args)=>{
  ctx.sqlCalls++;ctx.sqlMs+=ms;ctx.sqlMaxMs=Math.max(ms,ctx.sqlMaxMs);
  const q=args[0];
  const label=typeof q==='object'&&typeof q.name==='string'?q.name.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80):
    typeof q==='string'&&/^(BEGIN|COMMIT|ROLLBACK)$/i.test(q.trim())?q.trim().toUpperCase():'unnamed';
  const row=ctx.statements[label]||(ctx.statements[label]={calls:0,ms:0});row.calls++;row.ms+=ms;
});
wrap(pg.Pool.prototype,'connect',(ctx,ms)=>{ctx.poolAcquires++;ctx.poolWaitMs+=ms;});
record({kind:'started',at:new Date().toISOString()});flush();

// Global aggregation includes unlabelled internal RPC and shared batches.
const globalSql={}, globalPools=new Set();
let globalAcquireCalls=0,globalAcquireMs=0;
function globalWrap(target,key,finish){const original=target[key];target[key]=function(...args){const start=performance.now();let ended=false;const end=()=>{if(!ended){ended=true;finish.call(this,performance.now()-start,args);}};if(key==='connect')globalPools.add(this);const i=args.length-1;if(typeof args[i]==='function'){const callback=args[i];args[i]=function(...values){end();return callback.apply(this,values);};try{return original.apply(this,args);}catch(e){end();throw e;}}try{const result=original.apply(this,args);if(result&&typeof result.then==='function')return result.then(v=>{end();return v;},e=>{end();throw e;});end();return result;}catch(e){end();throw e;}};}
globalWrap(pg.Client.prototype,'query',function(ms,args){const q=args[0];let name=q&&typeof q==='object'?q.name||'unnamed':String(q).trim().match(/^(BEGIN|COMMIT|ROLLBACK)$/i)?.[0]||'unnamed';if(/^read_state_batch_/.test(name))name+=':read_states';else if(/^kv_/.test(name)&&typeof q.values?.[0]==='string'&&/^[a-z_]{1,80}$/.test(q.values[0]))name+=':'+q.values[0];const r=globalSql[name]??={calls:0,ms:0,maxMs:0};r.calls++;r.ms+=ms;r.maxMs=Math.max(r.maxMs,ms);});
globalWrap(pg.Pool.prototype,'connect',function(ms){globalAcquireCalls++;globalAcquireMs+=ms;});
setInterval(()=>{record({kind:'globalSql',at:new Date().toISOString(),stage:lastStage,statements:{...globalSql},poolAcquireCalls:globalAcquireCalls,poolAcquireMs:globalAcquireMs,pools:[...globalPools].map(p=>({total:p.totalCount,idle:p.idleCount,waiting:p.waitingCount,max:p.options?.max}))});for(const key of Object.keys(globalSql))delete globalSql[key];globalAcquireCalls=0;globalAcquireMs=0;flush();},1000).unref();
