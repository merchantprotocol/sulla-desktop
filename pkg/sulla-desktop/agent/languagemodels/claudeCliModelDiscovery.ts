// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';

import { claudeCredentialResolver } from './credentials/ClaudeCredentialResolver';
import { releaseLease } from './guestClaudeBridge';
import { currentAgentContainerRuntime } from '../services/AgentContainerRuntimeRegistry';
import { runCommand } from '../tools/util/CommandRunner';

import type { ClaudeCatalogModel } from './claudeModelCatalog';

/** Accept metadata, never conversation content or an unrelated control response. */
export function parseClaudeCliModels(body: unknown): ClaudeCatalogModel[] {
  if (!Array.isArray(body)) return [];
  const seen = new Set<string>();
  return body.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const model = item as Record<string, unknown>;
    if (model.value === 'default') return [];
    const ids = [model.resolvedModel, model.value].filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:[\]/=-]{0,199}$/.test(id));
    const efforts = model.supportsEffort === true && Array.isArray(model.supportedEffortLevels)
      ? [...new Set(model.supportedEffortLevels.filter((level): level is string => typeof level === 'string' && /^[a-z]{2,10}$/.test(level)))].map(id => ({ id })) : [];
    return ids.flatMap(id => {
      if (seen.has(id)) return [];
      seen.add(id);
      const label = typeof model.displayName === 'string' ? model.displayName : id;
      return [{ id, name: id !== model.resolvedModel && model.resolvedModel ? `${ label } (CLI alias)` : label,
        ...(typeof model.description === 'string' ? { description: model.description } : {}),
        ...(efforts.length ? { efforts } : {}) }];
    });
  });
}

// The credentials travel over stdin, never in process arguments or output. The
// short-lived process cannot run tools: it receives only initialize, no prompt.
const DISCOVERY_SCRIPT = `
const {spawn}=require('node:child_process');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);
process.stdin.on('end',()=>{
 const {environment,requestId}=JSON.parse(input);
 const env={...process.env};delete env.ANTHROPIC_API_KEY;delete env.ANTHROPIC_BASE_URL;delete env.CLAUDE_CODE_OAUTH_TOKEN;Object.assign(env,environment);
 const child=spawn('claude',['--print','--input-format','stream-json','--output-format','stream-json','--verbose','--no-session-persistence','--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools',''],{cwd:'/tmp',env,stdio:['pipe','pipe','ignore']});
 let pending='',done=false;
 const finish=(models)=>{if(done)return;done=true;clearTimeout(timer);if(models)process.stdout.write(JSON.stringify(models));child.kill('SIGTERM');};
 const timer=setTimeout(()=>finish(null),15000);
 child.on('error',()=>finish(null));child.on('close',()=>{clearTimeout(timer);if(!done)process.exitCode=1;});
 child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
  pending+=chunk;if(pending.length>2000000)return finish(null);
  let newline;while((newline=pending.indexOf('\\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);
   try{const x=JSON.parse(line);if(x.type==='control_response'&&x.response?.request_id===requestId){finish(x.response.subtype==='success'&&Array.isArray(x.response.response?.models)?x.response.response.models:null);}}catch{}
  }
 });
 child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify({type:'control_request',request_id:requestId,request:{subtype:'initialize'}})+'\\n');
});`;

export async function fetchClaudeCliModels(expectedAccountId?: string): Promise<ClaudeCatalogModel[] | null> {
  if (currentAgentContainerRuntime()) return null;
  const credential = await claudeCredentialResolver.resolve({ execution: true, conversationId: `model-catalog-${ randomUUID() }` });
  const lease = 'lease' in credential ? credential.lease : undefined;
  try {
    if (credential.kind !== 'oauth-capability' && credential.kind !== 'oauth-pending') return null;
    if (expectedAccountId && credential.accountId !== expectedAccountId) return null;
    if (!credential.oauthToken) return null;
    const environment = {
      CLAUDE_CODE_OAUTH_TOKEN: credential.oauthToken, ANTHROPIC_API_KEY: '',
      ...('baseUrl' in credential && credential.baseUrl ? { ANTHROPIC_BASE_URL: credential.baseUrl } : {}),
      DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    const script = `catalog_config=$(mktemp -d) || exit 1; trap 'rm -rf "$catalog_config"' EXIT; export CLAUDE_CONFIG_DIR="$catalog_config"; node -e '${ DISCOVERY_SCRIPT.replace(/'/g, `'"'"'`) }'`;
    const result = await runCommand(script, [], { runInGuest: true, timeoutMs: 20_000, maxOutputChars: 2_000_000,
      stdin: JSON.stringify({ environment, requestId: randomUUID() }) });
    if (result.exitCode !== 0) return null;
    const models = parseClaudeCliModels(JSON.parse(result.stdout));
    return models.length ? models : null;
  } catch {
    return null;
  } finally {
    releaseLease(lease);
  }
}
