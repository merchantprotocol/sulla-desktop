#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
import fs from 'node:fs'; import path from 'node:path';
const root=path.resolve('pkg/sulla-desktop');
const queue=['window/supportCenter.ts','main/supportRemote.ts','main/supportTimeline.ts','main/support/supportCloud.ts','main/support/supportIdentity.ts'];
const seen=new Set(); const forbidden=[/main\/cloud\/cloudFetch/,/main\/sullaCloudAuth/,/vault-broker/i,/(?:^|\/)agent\//,/agent\/database/,/ServiceLifecycleManager/];
const violations=[];
while(queue.length){const rel=queue.shift();if(seen.has(rel))continue;seen.add(rel);const file=path.join(root,rel);const source=fs.readFileSync(file,'utf8');for(const match of source.matchAll(/(?:import|export)[^;\n]*?(?:from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)){if(/^import\s+type\b/.test(match[0]))continue;const spec=match[1]??match[2];let target;if(spec.startsWith('@pkg/'))target=spec.slice(5);else if(spec.startsWith('.'))target=path.normalize(path.join(path.dirname(rel),spec));else continue;if(forbidden.some(rule=>rule.test(spec)||rule.test(target)))violations.push(`${rel}: ${spec}`);const candidates=[target,`${target}.ts`,`${target}.tsx`,`${target}.js`,`${target}.mjs`,`${target}.vue`,path.join(target,'index.ts'),path.join(target,'index.js')];for(const candidate of candidates)if(fs.existsSync(path.join(root,candidate))&&fs.statSync(path.join(root,candidate)).isFile()){queue.push(candidate);break}}}
if(violations.length){console.error(`Support standalone import policy failed:\n${violations.join('\n')}`);process.exit(1)}
console.log(`Support standalone import policy passed (${seen.size} modules).`);
