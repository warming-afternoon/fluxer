#!/usr/bin/env python3
"""Read private smoke COPY and generate small nonhistory storage probes only."""
import gzip,json,pathlib,sys,collections
from generate import metadata,j,big
source=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True);tables=metadata();rows=[];active=False
for line in gzip.open(source,'rt'):
 if line.startswith('COPY '):active=True;continue
 if line.startswith('\\.'):break
 if not active:continue
 def unesc(s):
  result='';i=0
  while i<len(s):
   if s[i]=='\\':i+=1;result+=dict(n='\n',r='\r',t='\t').get(s[i],s[i])
   else:result+=s[i]
   i+=1
  return result
 table,_,_,raw=map(unesc,line.rstrip('\n').split('\t'));rows.append((table,json.loads(raw)))
groups={'accounts':{'users','users_by_email','user_email_owners','users_by_username','guild_members','guild_members_by_user_id'},'memberships':{'thread_members','thread_members_by_user'}}
with gzip.open(out/'corpus-storage-probe.private.sql.gz','wt') as f:
 f.write('\\set ON_ERROR_STOP on\n')
 for group,names in groups.items():
  target='benchmark_'+group+'_storage_probe';count=collections.Counter();f.write(f"CREATE TABLE {target} (LIKE fluxer_kv INCLUDING ALL);\nSELECT pg_current_wal_insert_lsn() AS start_lsn \\gset\nCOPY {target} (table_name,partition_key,row_key,row_data) FROM STDIN;\n")
  for clone in range(100):
   for table,data in rows:
    if table not in names:continue
    r=json.loads(j(data))
    for k in ['user_id','thread_id']:
     if r.get(k):r[k]=big(int(r[k]['value'])+clone*10000000)
    for k in ['username','email','email_lower']:
     if r.get(k):r[k]=f'c{clone:03d}'+r[k]
    _,pk,part=tables[table];key=lambda keys:'\x1f'.join(j(r[k]) for k in keys)
    f.write('\t'.join(v.replace('\\','\\\\').replace('\t','\\t').replace('\n','\\n').replace('\r','\\r') for v in [table,key(part),key(pk),j(r)])+'\n');count[table]+=1
  f.write('\\.\n');f.write(f"SELECT '{group}' AS kind,pg_table_size('{target}') AS heap_toast_bytes,pg_indexes_size('{target}') AS index_bytes,pg_total_relation_size('{target}') AS total_bytes,pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'start_lsn') AS wal_bytes;\nSELECT table_name,count(*) FROM {target} GROUP BY table_name ORDER BY table_name;\n")
  print(group,dict(count))
import os
os.chmod(out/'corpus-storage-probe.private.sql.gz',0o600)
