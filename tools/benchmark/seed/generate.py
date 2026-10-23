#!/usr/bin/env python3
"""Deterministic isolated PostgreSQL-KV fixture. Generates only, never starts or touches services.
Read repository table metadata rather than maintaining a divergent SQL schema.
SQL must be applied only to the disposable benchmark DB after normal schema initialization.
"""
import argparse, collections, datetime, gzip, hashlib, json, os, pathlib, re, sys, shutil, time
import history
ROOT=pathlib.Path(__file__).resolve().parents[3]
D=ROOT/'fluxer_api/src/api/database/types'
def j(v): return json.dumps(v,ensure_ascii=False,separators=(',',':'))
def typed(t,v): return {'__fluxer_type':t,'value':v}
def big(v): return typed('bigint',str(v))
def date(v): return typed('date',v)
def aset(v=()): return typed('set',list(v))
STAMP='2026-10-14T10:00:00.000Z'; NOW=date(STAMP)
BASE=(int(datetime.datetime(2026,9,1,tzinfo=datetime.timezone.utc).timestamp()*1000)-1420070400000)<<22
UID=lambda i: big(BASE+1000000+i)
GID=big(BASE+1); FORUM=big(BASE+2); TEXT=big(BASE+3)
def metadata():
    cols={}
    for p in D.glob('*.ts'):
        for name, body in re.findall(r'export const (\w+_COLUMNS) = \[(.*?)\]',p.read_text(),re.S): cols[name]=re.findall(r"'([^']+)'",body)
    tables={}
    text=(ROOT/'fluxer_api/src/api/Tables.ts').read_text()
    for body in re.findall(r'\(\{\s*name:.*?\n\}\);',text,re.S):
        name=re.search(r"name: '([^']+)'",body).group(1)
        cn=re.search(r'columns: (\w+)',body); pk=re.search(r'primaryKey: \[(.*?)\]',body,re.S)
        if not cn or not pk or cn.group(1) not in cols: continue
        part=re.search(r'partitionKey: \[(.*?)\]',body,re.S)
        tables[name]=(cols[cn.group(1)], re.findall(r"'([^']+)'",pk.group(1)),re.findall(r"'([^']+)'",(part or pk).group(1)))
    return tables

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--scale',choices=['smoke','full'],default='smoke');ap.add_argument('--total-members',type=int,choices=[200000,400000],default=400000);ap.add_argument('--history-divisor',type=int,choices=[1,10,100],default=1,help='Explicit authorized history reduction;1=full,10=1000hot/10ordinary,100=100hot/1ordinary');ap.add_argument('--direct-copy',action='store_true',help='Low-peak import into verified empty benchmark corpus; refuses existing users/guilds/channels');ap.add_argument('--compression-level',type=int,choices=range(10),default=1);ap.add_argument('--min-free-gib',type=float,default=6);ap.add_argument('--output',required=True);ap.add_argument('--credentials',required=True,help='Private JSON with password and passwordHash, produced with production argon2 defaults');ap.add_argument('--api-base',default='http://127.0.0.1:8080/v1');ap.add_argument('--gateway-url',default='ws://127.0.0.1:8771/?v=1&encoding=json');a=ap.parse_args()
    cred=json.loads(pathlib.Path(a.credentials).read_text()); assert cred['passwordHash'].startswith('$argon2id$v=19$m=65536,t=3,p=4$'),'Require production-default Argon2 hash, not testMode weak hashing'
    total,online,posts,active,hot=(a.total_members,20000,30000,5000,800) if a.scale=='full' else (100,16,30,10,4)
    out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True);os.chmod(out,0o700)
    tables=metadata();counts=collections.Counter();raw_bytes=0
    accounts=[{'id':UID(i)['value'],'email':f'bench{i:06d}@benchmark.invalid','password':cred['password'],'joinedThreadIds':[]} for i in range(online)]
    threads=[]
    sql=gzip.open(out/'seed.sql.gz','wt',encoding='utf-8',compresslevel=a.compression_level); os.chmod(out/'seed.sql.gz',0o600)
    if a.direct_copy:
        sql.write("\\set ON_ERROR_STOP on\nDO $check$ BEGIN IF EXISTS (SELECT 1 FROM fluxer_kv WHERE table_name IN ('users','guilds','channels') LIMIT 1) THEN RAISE EXCEPTION 'Direct fixture COPY requires empty synthetic corpus'; END IF; END $check$;\nCOPY fluxer_kv (table_name,partition_key,row_key,row_data) FROM STDIN;\n")
    else:
        sql.write('\\set ON_ERROR_STOP on\nBEGIN;\nCREATE TEMP TABLE benchmark_seed_rows (LIKE fluxer_kv INCLUDING DEFAULTS) ON COMMIT DROP;\nCOPY benchmark_seed_rows (table_name,partition_key,row_key,row_data) FROM STDIN;\n')
    def row(table,**data):
        nonlocal raw_bytes
        cols,pk,part=tables[table];unknown=set(data)-set(cols)
        assert not unknown,(table,unknown)
        r={k:None for k in cols};r.update(data)
        key=lambda keys:'\x1f'.join(j(r[k]) for k in keys)
        assert all(r[k] is not None for k in pk),(table,pk)
        line='\t'.join(str(v).replace('\\','\\\\').replace('\t','\\t').replace('\n','\\n').replace('\r','\\r') for v in [table,key(part),key(pk),j(r)])+'\n'
        sql.write(line);raw_bytes+=len(line.encode());counts[table]+=1
    perms=sum(1<<b for b in [0,6,10,11,14,15,16,18,26,35,36,38,54])
    row('guilds',guild_id=GID,owner_id=UID(0),name='Isolated Fluxer benchmark',features=aset(),verification_level=0,mfa_level=0,nsfw_level=0,explicit_content_filter=0,default_message_notifications=1,system_channel_flags=0,afk_timeout=300,disabled_operations=0,member_count=total,version=1)
    row('guild_roles',guild_id=GID,role_id=GID,name='@everyone',permissions=big(perms),position=0,color=0,hoist=False,mentionable=False,version=1)
    row('guild_thread_state',guild_id=GID,first_active_at=NOW,perms_seeded_at=NOW)
    def channel(cid,typ,name,parent=None,owner=None,last=None):
        row('channels',channel_id=cid,guild_id=GID,type=typ,name=name,parent_id=parent,position=0,owner_id=owner,nsfw=False,rate_limit_per_user=0,last_message_id=last,permission_overwrites=typed('map',[]),soft_deleted=False,version=1)
    channel(FORUM,15,'benchmark-forum');channel(TEXT,0,'benchmark-text')
    row('thread_only_channels_by_guild',guild_id=GID,channel_id=FORUM);row('channels_by_guild_id',guild_id=GID,channel_id=TEXT)
    row('thread_parent_config',guild_id=GID,channel_id=FORUM,flags=0,default_auto_archive_duration=10080,default_thread_rate_limit_per_user=0,available_tags=[],default_tag_setting='match_some',has_threads=True)
    def progress(stage,current,maximum):
        free=shutil.disk_usage(out).free
        print(j({'stage':stage,'done':current,'total':maximum,'freeGiB':round(free/2**30,2)}),file=sys.stderr,flush=True)
        if free<a.min_free_gib*2**30:raise RuntimeError('Generation stopped: minimum free disk headroom reached')
    for i in range(total):
        if i%10000==0:progress('users',i,total)
        uid=UID(i);email=f'bench{i:06d}@benchmark.invalid';username=f'bench{i:06d}'
        row('users',user_id=uid,username=username,discriminator=1,bot=False,system=False,email=email,email_verified=True,password_hash=cred['passwordHash'],password_last_changed_at=NOW,date_of_birth=typed('local_date','1990-01-01'),locale='en-US',flags=big(0),premium_type=0,terms_agreed_at=NOW,privacy_agreed_at=NOW,authenticator_types=aset(),acls=aset(),traits=aset(),version=1)
        row('users_by_email',email_lower=email,user_id=uid);row('user_email_owners',email_lower=email,user_id=uid,claimed_at=NOW,claimed=True)
        row('users_by_username',username=username,discriminator=1,user_id=uid)
        row('guild_members',guild_id=GID,user_id=uid,joined_at=NOW,deaf=False,mute=False,role_ids=aset(),temporary=False,version=1)
        row('guild_members_by_user_id',user_id=uid,guild_id=GID)
    for t in range(posts):
        if t%500==0:progress('posts',t,posts)
        floors=((10000 if t<hot else 100)//a.history_divisor) if a.scale=='full' else 1
        tid=big(history.snowflake(t,0,floors)); archived=t>=active
        # Coprime stride ensures distinct online IDs and prefix-N coverage at each scale.
        live_count=(250 if a.scale=='full' else 8) if t<hot else ((40 if a.scale=='full' else 4) if not archived else 0)
        offline_count=(740 if a.scale=='full' else 8) if t<hot else (10 if not archived else 1)
        stride=79 if t<hot else 503
        live=[(t*37+k*stride)%online for k in range(live_count)]
        offline=[online+(t*997+k)%(total-online) for k in range(offline_count)]
        members=live+offline; assert len(set(members))==len(members)
        assert all(0<=i<total for i in members), 'Referenced member outside generated account range'
        owner=UID(members[0]);first_bucket=history.bucket(int(tid['value']));last=big(history.snowflake(t,floors-1,floors));last_bucket=history.bucket(int(last['value']))
        channel(tid,11,f'benchmark-post-{t:05d}',FORUM,owner,last)
        row('thread_state',thread_id=tid,guild_id=GID,parent_id=FORUM,type=11,archived=archived,locked=False,invitable=True,auto_archive_duration=10080,archive_timestamp=NOW,created_at=date(history.iso(history.timestamp_ms(t,0,floors))),flags=0,applied_tags=[],member_count=len(members),member_ids_preview=[UID(i) for i in members[:5]],has_starter=True,state_version=1)
        row('thread_stats',thread_id=tid,message_count=floors,total_message_sent=floors)
        row('threads_by_parent',parent_id=FORUM,thread_id=tid,guild_id=GID,type=11)
        if archived: row('archived_threads_by_parent',parent_id=FORUM,is_private=False,archive_timestamp=NOW,thread_id=tid,guild_id=GID)
        else: row('active_threads_by_guild',guild_id=GID,thread_id=tid,parent_id=FORUM,type=11)
        populated_buckets=set()
        for floor in range(floors):
            mid=big(history.snowflake(t,floor,floors));bucket=history.bucket(int(mid['value']));populated_buckets.add(bucket)
            author=owner if floor==0 else UID(offline[(floor-1)%len(offline)])
            row('messages',channel_id=tid,bucket=bucket,message_id=mid,author_id=author,type=0,content=history.content(t,floor),flags=0,mention_everyone=False,mention_users=aset(),mention_roles=aset(),mention_channels=aset(),attachments=[],embeds=[],sticker_items=[],has_reaction=False,version=1)
            row('messages_by_author_id_v2',author_id=author,channel_id=tid,message_id=mid)
        row('channel_state',channel_id=tid,created_bucket=first_bucket,has_messages=True,last_message_id=last,last_message_bucket=last_bucket,updated_at=NOW)
        for bucket in sorted(populated_buckets):row('channel_message_buckets',channel_id=tid,bucket=bucket,updated_at=NOW)
        for i in members:
            row('thread_members',thread_id=tid,user_id=UID(i),guild_id=GID,parent_id=FORUM,join_timestamp=NOW,flags=0,muted=False)
            row('thread_members_by_user',user_id=UID(i),guild_id=GID,parent_id=FORUM,is_private=False,thread_id=tid)
            if i<online: accounts[i]['joinedThreadIds'].append(tid['value'])
        threads.append({'id':tid['value'],'parentId':FORUM['value'],'archived':archived,'active':not archived,'hot':t<hot,'memberIds':[UID(i)['value'] for i in members]})
    if a.direct_copy:sql.write('\\.\nANALYZE fluxer_kv;\n')
    else:sql.write('\\.\nINSERT INTO fluxer_kv (table_name,partition_key,row_key,row_data) SELECT table_name,partition_key,row_key,row_data FROM benchmark_seed_rows ON CONFLICT (table_name,row_key) DO UPDATE SET partition_key=EXCLUDED.partition_key,row_data=EXCLUDED.row_data,expires_at=NULL,updated_at=now();\nCOMMIT;\nANALYZE fluxer_kv;\n')
    sql.close()
    meta={'seed':f'fluxer-d7a2c609969c-v2-members{total}-history{a.history_divisor}','scale':a.scale,'importMode':'direct-copy-empty-corpus' if a.direct_copy else 'staged-upsert','totalMembers':total,'totalThreads':posts,'activeThreads':active,'hotThreads':hot,'onlineCapableAccounts':online,'historicalMessages':10920000//a.history_divisor if a.scale=='full' else posts,'historyDivisor':a.history_divisor,'representsFullHistory':a.scale=='full' and a.history_divisor==1,'starterChineseCharacters':1000,'replyChineseCharacters':20,'fullHistoryRequired':a.scale=='full' and a.history_divisor==1,'rowCounts':dict(counts),'uncompressedCopyBytes':raw_bytes,'sqlGzipBytes':(out/'seed.sql.gz').stat().st_size,'membershipModel':'hot 250 online-capable+740 offline; warm 40 online-capable+10 offline; archived one offline (smoke scaled down)','fixtureWarning':'Synthetic chosen membership distribution, not measured user traffic. No DM/voice; no testMode. All message recipients must be intersected with actual online sessions.'}
    fixture={'apiBase':a.api_base,'gatewayUrl':a.gateway_url,'guildId':GID['value'],'forumId':FORUM['value'],'textChannelId':TEXT['value'],'accounts':accounts,'threads':threads,'metadata':meta}
    (out/'fixture.private.json').write_text(j(fixture));os.chmod(out/'fixture.private.json',0o600)
    (out/'summary.json').write_text(json.dumps(meta,indent=2));print(json.dumps(meta,indent=2))
if __name__=='__main__': main()
