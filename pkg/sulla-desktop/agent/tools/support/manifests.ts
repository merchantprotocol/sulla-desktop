// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import type { ToolOperation } from '../base';
import type { ToolManifest } from '../registry';
const load = () => import('./support_rpc');
const entry = (name:string, description:string, schemaDef:Record<string, any> = {}, operationTypes:ToolOperation[] = ['read']):ToolManifest => ({ name, description, category:'support', schemaDef, operationTypes, sideEffect:operationTypes.every(op => op === 'read') ? 'read' : 'write', placements:['desktop'], relayable:false, loader:load });
export const SUPPORT_TOOL_NAMES = ['support.logs.tail','support.diagnostics.snapshot','support.containers.list','support.containers.restart','support.containers.logs','support.containers.set_memory_limit','support.ai.retry_connection','support.update.set_channel','support.update.check_and_install','support.update.status'] as const;
export const supportToolManifests:ToolManifest[] = [
 entry('support.logs.tail','Read redacted logs from the supported Sulla runtime.',{source:{type:'enum',enum:['app','runtime','containers','ai']},lines:{type:'number',optional:true}}),
 entry('support.diagnostics.snapshot','Read the supported device diagnostic snapshot.'),
 entry('support.containers.list','List Sulla runtime containers.'),
 entry('support.containers.restart','Restart one named Sulla runtime container.',{name:{type:'string'}},['execute']),
 entry('support.containers.logs','Read redacted logs for one Sulla runtime container.',{name:{type:'string'},lines:{type:'number',optional:true}}),
 entry('support.containers.set_memory_limit','Set a safe memory limit on one Sulla runtime container.',{name:{type:'string'},memoryMiB:{type:'number'}},['update','execute']),
 entry('support.ai.retry_connection','Retry one AI provider connection.',{provider:{type:'string'}},['execute']),
 entry('support.update.set_channel','Switch the supported device between signed LTS and Nightly update feeds.',{channel:{type:'enum',enum:['lts','nightly']},pinnedVersion:{type:'string',optional:true,nullable:true}},['update']),
 entry('support.update.check_and_install','Check for and install a signed, notarized update.',{},['execute']),
 entry('support.update.status','Read the supported device update status.'),
];
