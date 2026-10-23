import {stateDir,outputDir,project,apiContainer,pgContainer,gatewayContainer} from './environment.mjs';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const directory=stateDir;
const {guildId}=JSON.parse(fs.readFileSync((process.env.FLUXER_BENCHMARK_FIXTURE||directory+'/fixture.private.json')));
if(!/^\d+$/.test(guildId))throw Error('Invalid synthetic guild');
const expr=`F=fun() -> case gateway_rpc_guild_infra:get_guild_pid(${guildId}) of
 {ok,P} -> case process_info(P,[message_queue_len,reductions,memory,current_function]) of
 undefined -> #{loaded=>false}; L -> M=maps:from_list(L),#{loaded=>true,atMs=>erlang:system_time(millisecond),queue=>maps:get(message_queue_len,M),reductions=>maps:get(reductions,M),memory=>maps:get(memory,M),currentFunction=>iolist_to_binary(io_lib:format("~p",[maps:get(current_function,M)]))} end;
 _ -> #{loaded=>false,atMs=>erlang:system_time(millisecond)} end end,
 Loop=fun Loop(0)->ok;Loop(N)->R=rpc:call('fluxer_gateway@127.0.0.1',erlang,apply,[F,[]],5000),case is_map(R) of true->io:format("~s~n",[json:encode(R)]);false->ok end,timer:sleep(1000),Loop(N-1) end,Loop(7200),halt().`;
const child=spawn('docker',['exec',gatewayContainer,'sh','-c','exec erl +S 1 +A 1 +SDcpu 1 +SDio 1 -noshell -name benchmark_probe@127.0.0.1 -setcookie "$FLUXER_ERLANG_COOKIE" -eval "$1"','sh',expr],{stdio:['ignore','pipe','ignore']});
let pending='';child.stdout.on('data',data=>{pending+=data;let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);try{const row=JSON.parse(line);fs.appendFileSync(outputDir+'/gateway-queue.jsonl',JSON.stringify(row)+'\n');}catch{}}});
child.on('exit',code=>process.exitCode=code||0);
