#!/usr/bin/env python3
"""Streaming fingerprint of actual seed message IDs/body, optionally validate all author links.
Reads only local private seed; prints no raw data/secrets. Excludes authors from fingerprint to
permit documented offline-member remapping while retaining exact message IDs/body/history.
"""
import collections,gzip,hashlib,json,pathlib,sys,re
src=pathlib.Path(sys.argv[1]);digest=hashlib.sha256();count=0;lengths=collections.Counter();members=None
if len(sys.argv)>2:
 fixture=json.loads(pathlib.Path(sys.argv[2]).read_text());members={t['id']:set(t['memberIds']) for t in fixture['threads']}
def unescape(s):
 return re.sub(r'\\(.)',lambda m:dict(n='\n',r='\r',t='\t').get(m.group(1),m.group(1)),s)
for line in gzip.open(src,'rt',encoding='utf-8'):
 if not line.startswith('messages\t'):continue
 row=json.loads(unescape(line.rstrip('\n').split('\t',3)[3]));cid=row['channel_id']['value'];mid=row['message_id']['value'];body=row['content'];author=row['author_id']['value']
 if members is not None:assert author in members[cid], 'Stored historical author not a thread member'
 assert len(body) in [20,1000] and len(body.encode())==3*len(body)
 digest.update(json.dumps([cid,mid,body],ensure_ascii=False,separators=(',',':')).encode());digest.update(b'\n');count+=1;lengths[len(body)]+=1
assert count==1092000 and lengths=={1000:30000,20:1062000}
print(json.dumps({'historicalMessages':count,'messageIdBodySha256':digest.hexdigest(),'bodyCharacterCounts':dict(lengths),'allAuthorsInThreadMembers':True if members is not None else None}))
