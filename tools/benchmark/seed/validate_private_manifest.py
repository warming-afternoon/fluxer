#!/usr/bin/env python3
"""Validate large manifest without retaining millions of SQL keys in RAM."""
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]);d=json.loads(p.read_text());a={x['id']:set(x['joinedThreadIds']) for x in d['accounts']};t={x['id']:set(x['memberIds']) for x in d['threads']};assert len(a)==20000 and len(t)==30000
assert all(a.values()),'Every online account must have at least one joined forum post'
counts={True:0,False:0};pairs=0
for th in d['threads']:
 members=t[th['id']];assert len(members)==len(th['memberIds']);assert len(members)<=1000;pairs+=len(members);counts[th['active']]+=1
 for uid in members:
  if uid in a:assert th['id'] in a[uid]
for uid,joined in a.items():
 for tid in joined:assert uid in t[tid]
assert counts=={True:5000,False:25000};assert pairs==1027000
base=int(d['accounts'][0]['id']);total=d['metadata']['totalMembers']
assert total in [200000,400000]
assert all(base<=int(uid)<base+total for members in t.values() for uid in members), 'Member references missing account'
if len(sys.argv)>2:
 old=json.loads(pathlib.Path(sys.argv[2]).read_text());old_online={x['id'] for x in old['accounts']}
 assert old_online==set(a)
 online_set=set(a);old_threads={x['id']:x for x in old['threads']}
 assert set(old_threads)==set(t)
 for th in d['threads']:
  previous=old_threads[th['id']]
  assert (t[th['id']]&online_set)==(set(previous['memberIds'])&old_online)
  assert len(th['memberIds'])==len(previous['memberIds'])
 print(json.dumps({'sameOnlineAccounts':True,'samePerPostOnlineSubscriptions':True,'samePostIdsAndMemberCounts':True,'offlineReferencesInBounds':True}))
m=d['metadata'];assert m['historicalMessages']==1092000 and m['historyDivisor']==10 and m['representsFullHistory'] is False
assert m['rowCounts']['messages']==1092000 and m['rowCounts']['users']==m['totalMembers']
for n in range(4000,20001,1000):
 online=set(x['id'] for x in d['accounts'][:n]);hot=[];warm=[]
 for th in d['threads']:
  if th['active']:(hot if th['hot'] else warm).append(len(t[th['id']]&online))
 assert min(hot)>=2 and min(warm)>=2
 print(json.dumps({'online':n,'hotRecipients':[min(hot),max(hot)],'warmRecipients':[min(warm),max(warm)]}))
print(json.dumps({'valid':True,'totalMembers':m['totalMembers'],'onlineCapable':len(a),'posts':len(t),'membershipPairs':pairs,'historyMessages':m['historicalMessages'],'representsFullHistory':False}))
