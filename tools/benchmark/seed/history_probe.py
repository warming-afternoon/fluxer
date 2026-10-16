#!/usr/bin/env python3
"""Generate ONLY a small logged PostgreSQL storage probe, not the full corpus.
Does not execute SQL, start services, or mutate the current application fixture.
"""
import collections,gzip,json,pathlib,sys
from generate import metadata,j,big,UID,aset,NOW,date
import history
divisor=int(sys.argv[2]) if len(sys.argv)>2 else 1
assert divisor in [1,10,100]
out=pathlib.Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True);tables=metadata();summary={}
with gzip.open(out/'history-storage-probe.sql.gz','wt',encoding='utf-8') as f:
 f.write('\\set ON_ERROR_STOP on\n')
 for tier,thread_count,floors,offset in [('hot',divisor,10000//divisor,50000),('normal',100*divisor,100//divisor,51000)]:
  target=f'benchmark_history_{tier}_d{divisor}_storage_probe';counts=collections.Counter();raw=0
  f.write(f"CREATE TABLE {target} (LIKE fluxer_kv INCLUDING ALL);\nSELECT pg_current_wal_insert_lsn() AS start_lsn \\gset\nCOPY {target} (table_name,partition_key,row_key,row_data) FROM STDIN;\n")
  def row(table,**data):
   global raw
   cols,pk,part=tables[table];r={k:None for k in cols};r.update(data);assert not(set(data)-set(cols))
   key=lambda keys:'\x1f'.join(j(r[k]) for k in keys)
   line='\t'.join(v.replace('\\','\\\\').replace('\n','\\n').replace('\t','\\t').replace('\r','\\r') for v in [table,key(part),key(pk),j(r)])+'\n'
   f.write(line);counts[table]+=1;raw+=len(line.encode())
  for t in range(offset,offset+thread_count):
   cid=big(history.snowflake(t,0,floors));populated=set()
   for floor in range(floors):
    mid=big(history.snowflake(t,floor,floors));bucket=history.bucket(int(mid['value']));populated.add(bucket);author=UID(20000+floor%740)
    body=history.content(t,floor);assert len(body)==(1000 if floor==0 else 20);assert len(body.encode())==len(body)*3
    row('messages',channel_id=cid,bucket=bucket,message_id=mid,author_id=author,type=0,content=body,flags=0,mention_everyone=False,mention_users=aset(),mention_roles=aset(),mention_channels=aset(),attachments=[],embeds=[],sticker_items=[],has_reaction=False,version=1)
    row('messages_by_author_id_v2',author_id=author,channel_id=cid,message_id=mid)
   row('channel_state',channel_id=cid,created_bucket=min(populated),has_messages=True,last_message_id=mid,last_message_bucket=max(populated),updated_at=NOW)
   row('thread_stats',thread_id=cid,message_count=floors,total_message_sent=floors)
   for bucket in sorted(populated):row('channel_message_buckets',channel_id=cid,bucket=bucket,updated_at=NOW)
  f.write('\\.\n')
  f.write(f"SELECT '{tier}' AS tier,{thread_count*floors} AS messages,pg_table_size('{target}') AS heap_toast_bytes,pg_indexes_size('{target}') AS index_bytes,pg_total_relation_size('{target}') AS total_bytes,pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'start_lsn') AS wal_bytes;\n")
  f.write(f"SELECT '{tier}' AS tier,length(row_data->>'content') AS unicode_characters,octet_length(row_data->>'content') AS utf8_bytes,count(*) FROM {target} WHERE table_name='messages' GROUP BY 2,3 ORDER BY 2;\n")
  summary[tier]={'threads':thread_count,'floorsPerThread':floors,'messages':thread_count*floors,'kvRows':dict(counts),'uncompressedCopyBytes':raw}
summary['selectedDivisor']=divisor
summary['selectedHistoricalMessages']=10920000//divisor
summary['fullTarget']={'hotMessages':8000000,'ordinaryMessages':2920000,'totalMessages':10920000,'starterCharacters':1000,'replyCharacters':20,'starterUtf8Bytes':3000,'replyUtf8Bytes':60,'totalContentUtf8Bytes':743400000}
summary['limits']='Logged sample tables copy production KV schema/indexes, but small B-trees/cache are not full-size; WAL includes concurrent writes. Do not turn storage estimates into performance claims. Tables intentionally retained for inspection; no DROP or existing-corpus mutation.'
(out/'history-storage-probe.summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
