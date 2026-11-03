#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
import fs from 'node:fs'; import path from 'node:path';
const root=path.resolve('pkg/sulla-desktop');
const queue=['window/supportCenter.ts','main/supportRemote.ts','main/supportTimeline.ts','main/support/supportCloud.ts','main/support/supportIdentity.ts'];
const seen=new Set(); const forbidden=[/main\/cloud\/cloudFetch/,/main\/sullaCloudAuth/,/vault-broker/i,/(?:^|\/)agent\//,/agent\/database/,/ServiceLifecycleManager/];
const violations=[];
// Boundaries: modules support may call but whose own graph is not walked.
// config/settingsImpl: getSettings() returns in-memory settings; its agent import is a
// lazy, failure-tolerant import used only when a setting is saved, never on a support path.
const boundary=new Set(['config/settingsImpl.ts']);
// Pure data with no imports: the default heartbeat prompt string referenced by config/settings.
const allowed=new Set(['agent/prompts/heartbeat']);
while(queue.length){const rel=queue.shift();if(seen.has(rel))continue;seen.add(rel);if(boundary.has(rel))continue;const file=path.join(root,rel);const source=fs.readFileSync(file,'utf8');for(const match of source.matchAll(/(?:import|export)[^;\n]*?(?:from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g)){if(/^import\s+type\b/.test(match[0]))continue;const spec=match[1]??match[2]??match[3];let target;if(spec.startsWith('@pkg/'))target=spec.slice(5);else if(spec.startsWith('.'))target=path.normalize(path.join(path.dirname(rel),spec));else continue;if(!allowed.has(target)&&forbidden.some(rule=>rule.test(spec)||rule.test(target)))violations.push(`${rel}: ${spec}`);const candidates=[target,`${target}.ts`,`${target}.tsx`,`${target}.js`,`${target}.mjs`,`${target}.vue`,path.join(target,'index.ts'),path.join(target,'index.js')];for(const candidate of candidates)if(fs.existsSync(path.join(root,candidate))&&fs.statSync(path.join(root,candidate)).isFile()){queue.push(candidate);break}}}
if(violations.length){console.error(`Support standalone import policy failed:\n${violations.join('\n')}`);process.exit(1)}
console.log(`Support standalone import policy passed (${seen.size} modules).`);
