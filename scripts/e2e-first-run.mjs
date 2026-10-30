// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const args=process.argv.slice(2);let repeat=1;const forwarded=[];
for(let i=0;i<args.length;i++){if(args[i]==='--repeat'){repeat=Number(args[++i]);}else forwarded.push(args[i]);}
if(!Number.isInteger(repeat)||repeat<1)throw new Error('--repeat must be a positive integer');
fs.mkdirSync('test-results/first-run',{recursive:true});const results=[];
for(let run=1;run<=repeat;run++){const started=new Date().toISOString();const p=spawnSync(process.platform==='win32'?'yarn.cmd':'yarn',['playwright','test','--config','e2e/first-run/playwright.config.ts',...forwarded],{stdio:'inherit',env:{...process.env,SULLA_E2E_RUN:String(run)}});results.push({run,started,passed:p.status===0,exitCode:p.status});console.log(`[first-run-e2e] run ${run}/${repeat}: ${p.status===0?'PASS':'FAIL'}`);}
fs.writeFileSync('test-results/first-run/repeat-summary.json',JSON.stringify(results,null,2)+'\n');if(results.some(r=>!r.passed))process.exitCode=1;
