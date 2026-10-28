// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import tar from 'tar-stream';

import { config } from './config.js';
import { pool } from './db.js';
import { providerResult } from './providerOutput.js';
import { DockerRuntimeDriver } from '../../../pkg/sulla-desktop/runtime/containerRuntime.js';
import { deriveCapabilitySigningKey, issueCapabilityToken } from '../../../pkg/sulla-desktop/runtime/capabilityToken.js';

import type { RequestIdentity } from './auth.js';

// Explicit public projection: provider diagnostics stay server-side.
export const publicRunColumns = `id,agent_id,label,prompt,provider,model,status,container_id,output,error,
  requested_by,owner_issuer,owner_subject,authority_id,organization_id,workflow_execution_id,
  workflow_invocation_id,created_at,started_at,finished_at,updated_at`;

const docker = new DockerRuntimeDriver();
const monitors = new Set<string>();

function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80) }

async function archive(entries: Array<{ name: string; value: string; mode?: number }>): Promise<Buffer> {
  const pack = tar.pack();
  for (const entry of entries) pack.entry({ name: entry.name, mode: entry.mode ?? 0o400, uid: 10001, gid: 10001 }, entry.value);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function monitor(id: string, containerId: string, tenant: [string | null, string | null]): Promise<void> {
  if (monitors.has(id)) return;
  monitors.add(id);
  try {
    let details: any;
    while (true) {
      details = await docker.inspect(containerId).catch(() => null);
      if (!details?.State?.Running) break;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    const current = (await pool.query('SELECT status,provider FROM server_agent_runs WHERE id=$1 AND authority_id IS NOT DISTINCT FROM $2::uuid AND organization_id IS NOT DISTINCT FROM $3::uuid', [id, ...tenant])).rows[0];
    if (!current || current.status === 'stopped') return;
    const diagnostics = (await docker.logs(containerId, 4_000).catch(() => '')).slice(-200_000);
    const output = providerResult(current.provider, diagnostics);
    const exitCode = Number(details?.State?.ExitCode ?? 1);
    await pool.query(
      `UPDATE server_agent_runs SET status=$4,output=$5,error=$6,diagnostic_log=$7,finished_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND authority_id IS NOT DISTINCT FROM $2::uuid AND organization_id IS NOT DISTINCT FROM $3::uuid`,
      [id, ...tenant, exitCode === 0 && output !== null ? 'completed' : 'failed', output ?? '',
        exitCode !== 0 ? `agent container exited ${ exitCode }` : output === null ? 'provider returned no terminal assistant result' : null, diagnostics],
    );
  } finally {
    await docker.remove(containerId).catch(() => {});
    monitors.delete(id);
  }
}

export async function startAgentRun(agent: any, prompt: string, identity: RequestIdentity, workflow?: {
  executionId: string;
  invocationId: string;
}): Promise<any> {
  const id = workflow ? `agent-run-${ workflow.invocationId }` : `agent-run-${ Date.now() }-${ crypto.randomBytes(4).toString('hex') }`;
  const provider = String(agent.provider ?? agent.model_priority?.[0]?.provider ?? '').trim();
  const model = String(agent.model ?? agent.model_priority?.[0]?.model ?? '').trim();
  if (!['codex', 'claude-code'].includes(provider)) throw new Error('agent provider must be codex or claude-code for headless execution');
  if (provider === 'codex' && !config.openAiApiKey) throw new Error('SULLA_OPENAI_API_KEY_FILE is required for codex server execution');
  if (provider === 'claude-code' && !config.anthropicApiKey) throw new Error('SULLA_ANTHROPIC_API_KEY_FILE is required for claude-code server execution');
  const tenant: [string | null, string | null] = [identity.authorityId, identity.organizationId];
  await pool.query(
    `INSERT INTO server_agent_runs(id,agent_id,label,prompt,provider,model,status,requested_by,owner_issuer,owner_subject,authority_id,organization_id,workflow_execution_id,workflow_invocation_id)
     VALUES($1,$2,$3,$4,$5,$6,'starting',$7,$8,$9,$10,$11,$12,$13)`,
    [id, agent.slug, agent.name, prompt, provider, model || null, identity.subject, identity.issuer, identity.subject, ...tenant,
      workflow?.executionId ?? null, workflow?.invocationId ?? null],
  );
  let containerId = '';
  try {
    const containerName = `sulla-agent-${ safeName(id) }`;
    const scopes = Array.isArray(agent.allowed_tools) ? agent.allowed_tools.filter((value: unknown) => typeof value === 'string' && value.length > 0) : [];
    const runToken = issueCapabilityToken({
      sub: identity.subject, org_id: identity.organizationId ?? undefined, agent_id: agent.slug,
      pod_id: containerName, job_id: id, scopes, expiresInSeconds: 3_600,
    }, deriveCapabilitySigningKey(config.toolApiToken), 'sulla-agents-service');
    containerId = await docker.create({
      name: containerName, image: config.image, network: config.dockerNetwork, autoRemove: false,
      stdinOpen: true, workingDir: '/workspace', user: '10001:10001', memoryBytes: 4 * 1024 * 1024 * 1024, nanoCpus: 2_000_000_000,
      labels: { 'com.sulla.workload': 'agent', 'com.sulla.server-run-id': id, 'com.sulla.agent-id': agent.slug },
      env: {
        SULLA_AGENT_PROVIDER: provider, SULLA_AGENT_MODEL: model,
        SULLA_TOOL_API_URL: config.toolApiUrl, SULLA_HOST: 'sulla_tools',
        SULLA_AGENT_MANAGED: '1',
      },
      tmpfs: {
        '/home/sulla': 'rw,uid=10001,gid=10001,mode=0700',
        '/run/secrets/sulla-agent': 'rw,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0700',
      },
    });
    await pool.query(`UPDATE server_agent_runs SET container_id=$4,updated_at=NOW()
      WHERE id=$1 AND authority_id IS NOT DISTINCT FROM $2::uuid AND organization_id IS NOT DISTINCT FROM $3::uuid`, [id, ...tenant, containerId]);
    const instructions = [...new Set([agent.system_prompt, agent.soul_content, agent.prompt_content].map((value: unknown) => String(value ?? '').trim()).filter(Boolean))].join('\n\n');
    const secrets = [
      { name: 'SULLA_API_TOKEN', value: runToken },
      { name: 'SULLA_AGENT_INSTRUCTIONS_B64', value: Buffer.from(instructions).toString('base64') },
      { name: 'SULLA_AGENT_PROMPT_B64', value: Buffer.from(prompt).toString('base64') },
      ...(provider === 'codex' ? [{ name: 'OPENAI_API_KEY', value: config.openAiApiKey }] : []),
      ...(provider === 'claude-code' ? [{ name: 'ANTHROPIC_API_KEY', value: config.anthropicApiKey }] : []),
    ];
    // Docker's archive endpoint reports success but does not expose files copied
    // into a directly mounted tmpfs. Stage into the image-owned private rootfs
    // directory before start. The entrypoint moves renewable leases into tmpfs
    // and unlinks all staging files before launching the provider process.
    // Control messages use a private rootfs inbox and are removed immediately.
    await docker.upload(containerId, '/run/sulla-bootstrap', await archive([
      ...secrets,
      { name: '.ready', value: 'ready\n', mode: 0o400 },
    ]));
    await docker.start(containerId);
    await pool.query(`UPDATE server_agent_runs SET status='running',container_id=$4,started_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND authority_id IS NOT DISTINCT FROM $2::uuid AND organization_id IS NOT DISTINCT FROM $3::uuid`, [id, ...tenant, containerId]);
    void monitor(id, containerId, tenant);
    return (await pool.query(`SELECT ${ publicRunColumns } FROM server_agent_runs WHERE id=$1 AND authority_id IS NOT DISTINCT FROM $2::uuid AND organization_id IS NOT DISTINCT FROM $3::uuid`, [id, ...tenant])).rows[0];
  } catch (error) {
    if (containerId) await docker.remove(containerId).catch(() => {});
    await pool.query(`UPDATE server_agent_runs SET status='failed',error=$4,finished_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND authority_id IS NOT DISTINCT FROM $2::uuid AND organization_id IS NOT DISTINCT FROM $3::uuid`, [id, ...tenant, 'agent container could not start']);
    throw error;
  }
}

async function control(id: string, command: Record<string, unknown>, identity: RequestIdentity): Promise<void> {
  const row = (await pool.query(`SELECT container_id,status FROM server_agent_runs WHERE id=$1 AND authority_id IS NOT DISTINCT FROM $2::uuid AND organization_id IS NOT DISTINCT FROM $3::uuid`, [id, identity.authorityId, identity.organizationId])).rows[0];
  if (!row) throw Object.assign(new Error('run not found'), { status: 404 });
  if (row.status !== 'running' || !row.container_id) throw Object.assign(new Error('run is not active'), { status: 409 });
  const name = `${ Date.now() }-${ crypto.randomUUID() }.json`;
  await docker.upload(row.container_id, '/run/sulla-control/inbox', await archive([{ name, value: JSON.stringify(command), mode: 0o600 }]));
}

export async function messageAgentRun(id: string, message: string, identity: RequestIdentity): Promise<void> {
  await control(id, { type: 'steer', id: crypto.randomUUID(), message }, identity);
}

export async function stopAgentRun(id: string, identity: RequestIdentity): Promise<void> {
  const row = (await pool.query(`SELECT container_id,status FROM server_agent_runs WHERE id=$1 AND authority_id IS NOT DISTINCT FROM $2::uuid AND organization_id IS NOT DISTINCT FROM $3::uuid`, [id, identity.authorityId, identity.organizationId])).rows[0];
  if (!row) throw Object.assign(new Error('run not found'), { status: 404 });
  if (row.status !== 'running' || !row.container_id) throw Object.assign(new Error('run is not active'), { status: 409 });
  await control(id, { type: 'cancel' }, identity);
  await pool.query(`UPDATE server_agent_runs SET status='stopped',finished_at=NOW(),updated_at=NOW()
    WHERE id=$1 AND authority_id IS NOT DISTINCT FROM $2::uuid AND organization_id IS NOT DISTINCT FROM $3::uuid`, [id, identity.authorityId, identity.organizationId]);
  setTimeout(() => docker.remove(row.container_id).catch(() => {}), 6_000).unref();
}

export async function recoverRuns(): Promise<void> {
  const rows = (await pool.query(`SELECT id,container_id,status,authority_id,organization_id FROM server_agent_runs WHERE status IN ('starting','running')`)).rows;
  for (const row of rows) {
    const details = row.container_id ? await docker.inspect(row.container_id).catch(() => null) : null;
    if (!details || (row.status === 'starting' && !details.State?.Running)) {
      if (row.container_id) await docker.remove(row.container_id).catch(() => {});
      await pool.query(`UPDATE server_agent_runs SET status='failed',error='agent manager restarted before container recovery',finished_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND authority_id IS NOT DISTINCT FROM $2::uuid AND organization_id IS NOT DISTINCT FROM $3::uuid`,
      [row.id, row.authority_id, row.organization_id]);
    } else {
      if (row.status === 'starting') {
        await pool.query(`UPDATE server_agent_runs SET status='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW()
          WHERE id=$1 AND authority_id IS NOT DISTINCT FROM $2::uuid AND organization_id IS NOT DISTINCT FROM $3::uuid`,
        [row.id, row.authority_id, row.organization_id]);
      }
      void monitor(row.id, row.container_id, [row.authority_id, row.organization_id]);
    }
  }
}
