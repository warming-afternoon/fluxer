"""Historical corpus helpers. Lengths are Chinese Unicode characters, not UTF-8 bytes."""
import datetime,hashlib
EPOCH=1420070400000
START_MS=int(datetime.datetime(2026,9,14,10,tzinfo=datetime.timezone.utc).timestamp()*1000)
END_MS=int(datetime.datetime(2026,10,13,10,tzinfo=datetime.timezone.utc).timestamp()*1000)
def content(thread,floor):
    length=1000 if floor==0 else 20
    # Non-repeated synthetic Chinese text: avoid artificial storage-compression advantage.
    words=[]
    for block in range((length+15)//16):
        b=hashlib.sha256(f'fluxer-history-v1:{thread}:{floor}:{block}'.encode()).digest()
        words.extend(chr(0x4e00+int.from_bytes(b[i:i+2],'little')%20902) for i in range(0,32,2))
    return ''.join(words)[:length]
def timestamp_ms(thread,floor,floors):
    start=START_MS+thread*100
    return start if floor==0 else start+((END_MS-start)*floor)//(floors-1)
def snowflake(thread,floor,floors):
    return ((timestamp_ms(thread,floor,floors)-EPOCH)<<22)|(2000000+thread)
def iso(ms):return datetime.datetime.fromtimestamp(ms/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def bucket(mid):return (mid>>22)//864000000
