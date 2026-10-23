#!/usr/bin/env python3
"""Offline structural validation without services, credentials, or token output."""
import collections,gzip,json,pathlib,sys
from generate import metadata,j
tables=metadata()
p=pathlib.Path(sys.argv[1]); fixture=json.loads((p/'fixture.private.json').read_text());acc={a['id']:a for a in fixture['accounts']};counts=collections.Counter(); keys=set();n=0
in_copy=False
for line in gzip.open(p/'seed.sql.gz','rt'):
    if line.startswith('COPY '):in_copy=True;continue
    if line.startswith('\\.'):break
    if not in_copy:continue
    # COPY escape reversals preserve JSON backslashes.
    parts=line.rstrip('\n').split('\t');assert len(parts)==4,len(parts)
    def unescape(s):
        out='';i=0
        while i<len(s):
            if s[i]=='\\':
                i+=1;out+=dict(n='\n',r='\r',t='\t').get(s[i],s[i])
            else:out+=s[i]
            i+=1
        return out
    table,part,key,raw=map(unescape,parts);row=json.loads(raw)
    assert (table,key) not in keys,(table,key);keys.add((table,key));counts[table]+=1
    assert isinstance(row,dict)
    columns,primary,partition=tables[table]
    assert key=='\x1f'.join(j(row[k]) for k in primary),table
    assert part=='\x1f'.join(j(row[k]) for k in partition),table
    assert set(row)==set(columns),table
assert counts==fixture['metadata']['rowCounts'],(dict(counts),fixture['metadata']['rowCounts'])
for t in fixture['threads']:
    ids=t['memberIds'];assert len(ids)==len(set(ids));assert len(ids)<=1000
    for uid in ids:
        if uid in acc: assert t['id'] in acc[uid]['joinedThreadIds']
thread_map={t['id']:set(t['memberIds']) for t in fixture['threads']}
for a in acc.values():
    for tid in a['joinedThreadIds']:assert a['id'] in thread_map[tid]
print(json.dumps({'valid':True,'rows':sum(counts.values()),'accounts':len(acc),'threads':len(fixture['threads'])}))
