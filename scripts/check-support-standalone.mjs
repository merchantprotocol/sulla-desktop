#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
import fs from 'node:fs'; import path from 'node:path';
const root=path.resolve('pkg/sulla-desktop');
const queue=['window/supportCenter.ts','main/supportRemote.ts','main/supportTimeline.ts','main/support/supportCloud.ts','main/support/supportIdentity.ts'];
const seen=new Set(); const forbidden=[/main\/cloud\/cloudFetch/,/main\/sullaCloudAuth/,/vault-broker/i,/\/agent\//,/agent\/database/,/ServiceLifecycleManager/];
const violations=[];
while(queue.length){const rel=queue.shift();if(seen.has(rel))continue;seen.add(rel);const file=path.join(root,rel);const source=fs.readFileSync(file,'utf8');for(const match of source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)){const spec=match[1];if(forbidden.some(rule=>rule.test(spec)))violations.push(`${rel}: ${spec}`);let target;if(spec.startsWith('@pkg/'))target=spec.slice(5);else if(spec.startsWith('.'))target=path.normalize(path.join(path.dirname(rel),spec));else continue;if (target.startsWith('main/support') || target === 'main/supportState' || target === 'main/cloud/deviceKey') for(const candidate of [`${target}.ts`,`${target}.js`,path.join(target,'index.ts')])if(fs.existsSync(path.join(root,candidate))){queue.push(candidate);break}}}
if(violations.length){console.error(`Support standalone import policy failed:\n${violations.join('\n')}`);process.exit(1)}
console.log(`Support standalone import policy passed (${seen.size} modules).`);
