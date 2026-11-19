#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Bounded stalled-reader canary. Only a marked disposable runtime is accepted.

No project data, credentials, or live sockets are used. Fixture services bind
only guest loopback; the reverse fixture binds only host loopback.
"""
import argparse
import hashlib
import concurrent.futures
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import threading
import time

GUEST = r'''
import json,socket,threading,time,sys
bulk_progress=[0]
def listener(port,handler):
 s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',port));s.listen()
 def run():
  while True:
   c,_=s.accept();threading.Thread(target=handler,args=(c,),daemon=True).start()
 threading.Thread(target=run,daemon=True).start()
def echo(c):
 with c:
  try:c.sendall(c.recv(32))
  except OSError:pass
def bulk(c):
 with c:
  try:
   c.recv(1)
   for _ in range(1024):c.sendall(b'x'*65536);bulk_progress[0]+=65536
  except OSError:pass
def stream(c):
 with c:
  try:
   for i in range(1200):c.sendall(str(i).encode()+bytes([10]));time.sleep(.05)
  except OSError:pass
def upload(c):
 import hashlib
 with c:
  c.shutdown(socket.SHUT_WR);time.sleep(.5);h=hashlib.sha256();n=0
  while True:
   data=c.recv(65536)
   if not data:break
   h.update(data);n+=len(data)
  with open('/tmp/sulla-upload-receipt.json','w') as out:json.dump({'bytes':n,'sha256':h.hexdigest()},out)
listener(18445,upload)
listener(18441,bulk);listener(18442,echo);listener(18444,stream)
if len(sys.argv)>1:
 def reverse():
  c=socket.create_connection(('192.168.5.2',int(sys.argv[1])));c.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,4096)
  time.sleep(50);c.close()
 threading.Thread(target=reverse,daemon=True).start()
def health():
 with open('/tmp/sulla-isolation-health.jsonl','w',buffering=1) as out:
  for _ in range(220):
   start=time.monotonic();c=socket.create_connection(('127.0.0.1',18442),timeout=1);c.sendall(b'local');assert c.recv(5)==b'local';c.close()
   out.write(json.dumps({'guestLocalMs':round((time.monotonic()-start)*1000,3),'bulkSent':bulk_progress[0],'at':time.time()})+'\n');time.sleep(.25)
threading.Thread(target=health,daemon=True).start()
print('READY',flush=True)
time.sleep(55)
'''

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--runtime',required=True);p.add_argument('--runtime-dir',required=True)
 p.add_argument('--direction',choices=['guest-to-host','host-to-guest'],required=True)
 p.add_argument('--resume',action='store_true');p.add_argument('--expect',choices=['healthy','blocked'],required=True);p.add_argument('--duration',type=int,default=18);p.add_argument('--output',required=True)
 args=p.parse_args();run=Path(args.runtime_dir).resolve()
 if not str(run).startswith('/private/tmp/sulla-relay-') or not (run/'.test-owned').is_file():
  p.error('Refusing an unmarked or non-disposable runtime directory')
 if not 12<=args.duration<=25:p.error('Duration must be 12–25 seconds')
 env=dict(os.environ,SULLA_RUNTIME_DIR=str(run));stop=threading.Event();samples=[];local=[];stream_times=[];bulk_counts=[];clients=[];trigger=threading.Event()
 def wire(port):
  c=socket.socket(socket.AF_UNIX);c.settimeout(3);c.connect(str(run/'guest.sock'))
  c.sendall(('2376\n'+json.dumps({'port':port,'traceId':'isolation-canary'})+'\n').encode());return c
 reverse=socket.socket();reverse.bind(('127.0.0.1',0));reverse.listen();reverse.settimeout(3)
 def produce():
  try:
   c,_=reverse.accept();clients.append(c);c.settimeout(1);trigger.wait()
   for _ in range(1024):
    try:c.sendall(b'x'*65536);bulk_counts.append(65536)
    except socket.timeout:break
  except OSError:pass
 if args.direction=='host-to-guest':threading.Thread(target=produce,daemon=True).start()
 command=[args.runtime,'exec','--','/usr/bin/python3','-u','-c',GUEST]
 if args.direction=='host-to-guest':command.append(str(reverse.getsockname()[1]))
 proc=subprocess.Popen(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 ready=proc.stdout.readline().strip();assert ready=='READY',(ready,proc.poll())
 def read_local():
  for line in proc.stdout:
   try:local.append(json.loads(line))
   except ValueError:pass
 threading.Thread(target=read_local,daemon=True).start()
 def ai_reader():
  try:
   c=wire(18444);clients.append(c)
   pending=bytearray();sequence=0
   while not stop.is_set():
    data=c.recv(4096)
    if not data:break
    pending.extend(data)
    while 10 in pending:
     end=pending.index(10);frame=int(pending[:end]);del pending[:end+1]
     if frame!=sequence:raise ValueError('Heartbeat sequence changed')
     sequence+=1;stream_times.append(time.monotonic())
  except OSError:pass
 threading.Thread(target=ai_reader,daemon=True).start()
 def probe(kind):
  start=time.monotonic();ok=False;error=None
  try:
   if kind=='fresh':
    with wire(18442) as c:c.sendall(b'ping');ok=c.recv(4)==b'ping'
   elif kind=='docker':
    with socket.socket(socket.AF_UNIX) as c:
     c.settimeout(3);c.connect(str(run/'docker.sock'));c.sendall(b'GET /_ping HTTP/1.0\r\nHost: localhost\r\n\r\n');ok=b'200 OK' in c.recv(4096)
   else:
    result=subprocess.run([args.runtime,'status'],env=env,capture_output=True,text=True,timeout=3);ok=result.returncode==0 and json.loads(result.stdout).get('state')=='docker-ready'
  except (OSError,subprocess.TimeoutExpired) as exc:error=type(exc).__name__
  return {'kind':kind,'ok':ok,'elapsedMs':round((time.monotonic()-start)*1000,3),'error':error,'at':time.time()}
 time.sleep(.3)
 warmup=[probe(kind) for kind in ['fresh','docker','control']]
 assert all(s['ok'] for s in warmup) and len(stream_times)>=3, ('Fixture warmup failed',warmup,stream_times)
 if args.direction=='guest-to-host':
  stalled=wire(18441);stalled.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,4096);clients.append(stalled);stalled.sendall(b'S')
 trigger.set();stall_start=time.monotonic()
 with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
  began=time.monotonic()
  while time.monotonic()-began<args.duration:
   samples.extend(pool.map(probe,['fresh','docker','control']));time.sleep(.25)
 resumed=None
 if args.resume and args.direction=='guest-to-host':
  stalled.settimeout(5);received=0;h=hashlib.sha256()
  while True:
   data=stalled.recv(65536)
   if not data:break
   h.update(data);received+=len(data)
   if received//(1024*1024)!=(received-len(data))//(1024*1024):time.sleep(.05)
  expected=hashlib.sha256()
  for _ in range(1024):expected.update(b'x'*65536)
  resumed={'bytes':received,'hashMatches':h.digest()==expected.digest()}
  assert received==64*1024*1024 and resumed['hashMatches'],'Slow reader lost data'
 upload_receipt=None
 if args.resume:
  payload=b'u'*65536
  with wire(18445) as uploading:
   assert uploading.recv(1)==b'','Target did not half-close response'
   for _ in range(64):uploading.sendall(payload)
   uploading.shutdown(socket.SHUT_WR)
  for _ in range(20):
   result=subprocess.run([args.runtime,'exec','--','cat','/tmp/sulla-upload-receipt.json'],env=env,capture_output=True,text=True,timeout=5)
   if result.returncode==0:
    upload_receipt=json.loads(result.stdout);break
   time.sleep(.1)
  assert upload_receipt and upload_receipt['bytes']==4*1024*1024 and upload_receipt['sha256']==hashlib.sha256(payload*64).hexdigest(),'Half-closed upload lost bytes'
 stall_end=time.monotonic();stop.set()
 for c in clients:
  try:c.close()
  except OSError:pass
 reverse.close();proc.terminate()
 try:proc.wait(timeout=3)
 except subprocess.TimeoutExpired:proc.kill();proc.wait()
 time.sleep(.2)
 health=subprocess.run([args.runtime,'exec','--','cat','/tmp/sulla-isolation-health.jsonl'],env=env,capture_output=True,text=True,timeout=10)
 local=[json.loads(line) for line in health.stdout.splitlines() if line.startswith('{')]
 measured=[stall_start]+[t for t in stream_times if stall_start<t<stall_end]+[stall_end]
 gaps=[b-a for a,b in zip(measured,measured[1:])]
 result={'direction':args.direction,'duration':args.duration,'warmup':warmup,'guestBulkSent':max((r['bulkSent'] for r in local),default=0),'samples':samples,'guestLocal':local,'streamFrames':len(stream_times),'maxStreamGapMs':round(max(gaps,default=0)*1000,3),'hostBulkSent':sum(bulk_counts),'allFreshHealthy':all(s['ok'] for s in samples),'allStreamHealthy':len(stream_times)>args.duration*10 and max(gaps,default=0)<1,'fixtureOnly':True,'resumed':resumed,'halfClosedUpload':upload_receipt}
 Path(args.output).write_text(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in result.items() if k not in ['samples','guestLocal','warmup']}))
 assert len(local)>args.duration*2, 'Guest-local health stopped'
 assert result['guestBulkSent']>0 or result['hostBulkSent']>0,'No bulk pressure generated'
 if args.expect=='healthy':assert result['allFreshHealthy'] and result['allStreamHealthy'], 'Independent traffic interrupted'
 else:assert not result['allFreshHealthy'] and not result['allStreamHealthy'], 'Baseline did not reproduce'

if __name__=='__main__':main()
