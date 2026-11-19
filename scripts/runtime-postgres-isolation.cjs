// SPDX-License-Identifier: GPL-2.0-or-later
// Real PostgreSQL acceptance in an explicitly owned, disposable runtime.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const [runtime, directory, expected, output] = process.argv.slice(2);
const run = fs.realpathSync(directory);
if (!run.startsWith('/private/tmp/sulla-relay-') || !fs.existsSync(path.join(run, '.test-owned')) || !['healthy','blocked'].includes(expected)) throw Error('Refusing unowned runtime');
const password = crypto.randomBytes(24).toString('hex');
const name = 'sulla-relay-pg-qa';
const env = { ...process.env, SULLA_RUNTIME_DIR: run, DOCKER_HOST: `unix://${run}/docker.sock`, POSTGRES_PASSWORD: password };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function docker(args) { return spawnSync('docker', args, { env, encoding: 'utf8', timeout: 15000 }); }
(async () => {
  const created = docker(['run','--rm','-d','--name',name,'-e','POSTGRES_PASSWORD','-p','127.0.0.1:18443:5432','postgres:16-alpine']);
  if (created.status !== 0) throw Error('Owned PostgreSQL fixture could not start');
  const sockets = new Set(); let bridge, persistent;
  try {
    let ready = false;
    for (let n=0;n<30;n++) { if(docker(['exec',name,'pg_isready','-U','postgres']).status===0){ready=true;break} await delay(500); }
    if (!ready) throw Error('Fixture PostgreSQL did not become ready');
    bridge = net.createServer({allowHalfOpen:true}, client => {
      const guest = net.connect({ path: path.join(run,'guest.sock'), allowHalfOpen:true });
      sockets.add(client);sockets.add(guest);
      guest.write('2376\n'+JSON.stringify({port:18443})+'\n');client.pipe(guest);guest.pipe(client);
      const close=()=>{client.destroy();guest.destroy();sockets.delete(client);sockets.delete(guest)};
      client.on('error',close);guest.on('error',close);client.on('close',close);guest.on('close',close);
    });
    await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
    const makeClient=()=>new Client({host:'127.0.0.1',port:bridge.address().port,user:'postgres',database:'postgres',password,connectionTimeoutMillis:3000,query_timeout:3000});
    persistent=makeClient();persistent.on('error',()=>{});await persistent.connect();
    const warm=await persistent.query('SELECT 1 AS value');if(warm.rows[0].value!==1)throw Error('Bad warmup');
    const receipt=path.join(run,'stream-acceptance.json');
    const child=spawn('python3',[path.join(__dirname,'runtime-stall-isolation.py'),'--runtime',runtime,'--runtime-dir',run,'--direction','guest-to-host','--expect',expected,'--output',receipt],{env,stdio:['ignore','pipe','pipe']});
    let finished=false;let exit=null;let failure='';child.stderr.on('data',b=>{failure+=b.toString()});child.stdout.resume();
    child.on('exit',code=>{finished=true;exit=code});
    const results=[];
    while(!finished){
      const at=Date.now();
      const existing=persistent.query('SELECT 1 AS value').then(r=>r.rows[0].value===1).catch(()=>false);
      const fresh=(async()=>{const c=makeClient();c.on('error',()=>{});try{await c.connect();const r=await c.query('SELECT 1 AS value');return r.rows[0].value===1}catch{return false}finally{await c.end().catch(()=>{})}})();
      const [establishedOK,freshOK]=await Promise.all([existing,fresh]);results.push({at,establishedOK,freshOK,elapsedMs:Date.now()-at});await delay(250);
    }
    const streams=fs.existsSync(receipt)?JSON.parse(fs.readFileSync(receipt)):null;
    const passed=expected==='healthy'?results.every(r=>r.establishedOK&&r.freshOK):results.some(r=>!r.establishedOK||!r.freshOK);
    const result={expected,realPostgres:true,samples:results,streamAcceptance:streams,childExit:exit,passed:passed&&exit===0};
    fs.writeFileSync(output,JSON.stringify(result,null,2));
    console.log(JSON.stringify({expected,realPostgres:true,samples:results.length,failures:results.filter(r=>!r.establishedOK||!r.freshOK).length,passed:result.passed}));
    if(!result.passed)process.exitCode=1;
  } finally {
    await persistent?.end().catch(()=>{});for(const socket of sockets)socket.destroy();if(bridge)await new Promise(resolve=>bridge.close(resolve));
    // Only the container created above exists on this private runtime socket.
    docker(['rm','-f','-v',name]);
  }
})().catch(error=>{console.error(error.message);process.exitCode=1});
