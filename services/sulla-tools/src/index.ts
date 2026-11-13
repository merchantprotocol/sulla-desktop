// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';

import express from 'express';
import Redis from 'ioredis';
import { Pool } from 'pg';

import { executeCatalogTool, initializeCatalog, listTools, resolveTool, scopeToolExecutionContext } from './catalog.js';
import { config, validateConfig } from './config.js';
import { RedisRevocationStore, RequestStore } from './stores.js';
import { ProcessGuard } from './ProcessGuard.js';
import { RedisHealthProbe } from './RedisHealthProbe.js';
import { DatabaseHealthRepository } from './Repositories/DatabaseHealthRepository.js';
import { CapabilityTokenError, verifyCapabilityToken } from '../../../packages/runtime-protocol/src/capabilityToken.js';
import { HttpDesktopExecutor } from '../../../packages/runtime-protocol/src/desktopExecutor.js';
import { RelayDesktopExecutor } from '../../../packages/relay-protocol/src/relayDesktopExecutor.js';

import type { ToolExecutionContext } from '../../../packages/runtime-protocol/src/executionContext.js';
import type { DesktopExecutor } from '../../../packages/runtime-protocol/src/desktopExecutor.js';
import { ToolRequestArguments } from '../../../packages/runtime-protocol/src/toolRequestArguments.js';
import { ToolDeadlinePolicy } from '../../../packages/runtime-protocol/src/toolDeadlinePolicy.js';
import { LateToolResultStore } from '../../../pkg/sulla-desktop/runtime/LateToolResultStore.js';

validateConfig();
const toolDeadlines = new ToolDeadlinePolicy();
const lateToolResults = new LateToolResultStore();
process.env.SULLA_DATABASE_URL = config.databaseUrl;
process.env.SULLA_REDIS_URL = config.redisUrl;

const guard = new ProcessGuard({ name: 'sulla-tools' }).catchCrashes();
const app = express();
// ioredis reconnects with backoff on its own; the listener keeps a dropped connection from
// being reported as an unhandled error and /healthz reports it until Redis is back.
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
redis.on('error', error => console.warn('[sulla-tools] Redis connection error; reconnecting:', error.message));
const pool = new Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 2_000 });
// An idle client dropped by Postgres is discarded and the next query reconnects.
pool.on('error', error => console.warn('[sulla-tools] idle database connection lost; reconnecting on next use:', error.message));
const databaseHealth = new DatabaseHealthRepository(pool);
const redisHealth = new RedisHealthProbe(redis);
const revocations = new RedisRevocationStore(redis);
const requests = new RequestStore(redis, pool);
const desktop: DesktopExecutor = config.relayUrl && config.relayToken
  ? new RelayDesktopExecutor({ relayUrl: config.relayUrl, serviceToken: config.relayToken, deviceId: config.relayDeviceId || undefined })
  : config.desktopExecutorUrl && config.desktopExecutorToken
    ? new HttpDesktopExecutor(config.desktopExecutorUrl, config.desktopExecutorToken)
    : { execute: async() => ({ success: false, error: { code: 'executor_unconfigured', message: 'This tool requires a configured Desktop executor or relay' } }) };

function normalizedAddress(value: string | undefined): string {
  return String(value ?? '').replace(/^::ffff:/, '');
}

async function assertAgentContainerCaller(request: express.Request, ctx: ToolExecutionContext): Promise<void> {
  const pod = String(ctx.pod_id ?? '');
  if (!/^sulla-agent-[a-zA-Z0-9_.-]+$/.test(pod)) throw new Error('Agent-local capability is not bound to a valid container');
  const callers = new Set((await lookup(pod, { all: true })).map(result => normalizedAddress(result.address)));
  const source = normalizedAddress(request.socket.remoteAddress);
  if (!source || !callers.has(source)) throw new Error('Agent-local capability does not belong to the calling container');
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
// Unhealthy while Redis or Postgres is unreachable; Desktop restarts the container if it stays that way.
app.get('/healthz', async(_request, response) => {
  const [redisUp, databaseUp] = await Promise.all([redisHealth.reachable(), databaseHealth.reachable()]);

  if (redisUp && databaseUp) response.json({ status: 'ok' });
  else response.status(503).json({ status: 'unhealthy', redis: redisUp, database: databaseUp });
});

function help(category?: string): string {
  const selected = listTools(category);
  if (category) {
    return `\n## ${ category }\n${ selected.map(tool => `  ${ tool.name }\n    ${ tool.description }\n    Target: ${ tool.executionTarget }`).join('\n') }\n`;
  }
  const counts = new Map<string, number>();
  for (const tool of selected) counts.set(tool.category, (counts.get(tool.category) ?? 0) + 1);
  return `\nsulla — unified CLI for Sulla Desktop\n${ '═'.repeat(60) }\n\nCategories:\n${ [...counts].map(([name, count]) => `  ${ name.padEnd(22) } (${ count } tools)`).join('\n') }\n`;
}

app.get('/v1/tools/help', (_request, response) => response.type('text/plain').send(help()));
app.get('/v1/tools/help/:category', (request, response) => {
  const category = String(request.params.category);
  if (listTools(category).length === 0) return response.status(404).json({ success: false, error: { code: 'category_not_found', message: `Category ${ category } was not found` } });
  response.type('text/plain').send(help(category));
});

app.post('/v1/tools/internal/:category/:tool/call', async(request, response) => {
  const requestId = String(request.header('X-Request-Id') ?? crypto.randomUUID());
  response.setHeader('X-Request-Id', requestId);
  const category = String(request.params.category);
  const requested = String(request.params.tool);
  const tool = resolveTool(category, requested);
  if (!tool) return response.status(404).json({ success: false, error: { code: 'tool_not_found', message: `Tool ${ category }/${ requested } was not found` }, request_id: requestId });
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  let ctx: ToolExecutionContext;
  try {
    const claims = await verifyCapabilityToken(bearer, config.signingKey, { category, tool: tool.name, revocations });
    ctx = { ...claims, request_id: requestId };
    if (tool.executionTarget === 'agent-local') await assertAgentContainerCaller(request, ctx);
  } catch (error) {
    const auth = error instanceof CapabilityTokenError ? error : new CapabilityTokenError('invalid', 'Capability verification failed');
    const status = auth.code === 'scope' ? 403 : 401;
    return response.status(status).json({ success: false, error: { code: auth.code, message: auth.message }, request_id: requestId });
  }

  const args = ToolRequestArguments.normalize(request.body);
  try {
    ctx = await scopeToolExecutionContext(ctx, tool, args);
  } catch (error) {
    return response.status(403).json({
      success: false,
      error:   { code: 'credential_scope', message: error instanceof Error ? error.message : 'Credential scope denied' },
      request_id: requestId,
    });
  }
  const idempotencyKey = request.header('Idempotency-Key');
  if (idempotencyKey && !await requests.reserveIdempotency(`${ ctx.sub }:${ idempotencyKey }`)) {
    return response.status(409).json({ success: false, error: { code: 'duplicate_request', message: 'Idempotency key was already used' }, request_id: requestId });
  }

  let status = 200;
  const deadlineMs = toolDeadlines.deadlineMs(tool.name, tool.operationTypes);
  const startedAt = Date.now();
  try {
    const result = tool.executionTarget === 'catalog'
      ? await (async() => {
        let timedOut = false;
        const execution = executeCatalogTool(ctx, tool, args);
        execution.then(value => {
          if (!timedOut) return;
          const late = lateToolResults.record(requestId, { success: true, result: value });
          console.warn(`[sulla-tools] Late tool result for ${ requestId }: ${ late.outcome }`);
        }, error => {
          if (!timedOut) return;
          const late = lateToolResults.record(requestId, undefined, error);
          console.warn(`[sulla-tools] Late tool result for ${ requestId }: ${ late.outcome }`);
        });
        let timer!: ReturnType<typeof setTimeout>;
        try {
          return await Promise.race([
            execution,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error('Tool deadline exceeded'));
              }, deadlineMs);
            }),
          ]);
        } finally {
          clearTimeout(timer!);
        }
      })()
      : await desktop.execute(ctx, category, requested, args, { deadlineMs, operationTypes: tool.operationTypes });
    if (tool.executionTarget !== 'catalog') {
      const forwarded = result as Awaited<ReturnType<typeof desktop.execute>>;
      if (!forwarded.success) status = forwarded.error?.code === 'deadline_exceeded' ? 504 : 503;
      return response.status(status).json({ ...forwarded, request_id: requestId });
    }
    response.json({ success: true, result, request_id: requestId });
  } catch (error) {
    const timedOut = error instanceof Error && /deadline exceeded/i.test(error.message);
    status = timedOut ? 504 : 500;
    response.status(status).json({
      success: false,
      error: {
        code: timedOut ? 'deadline_exceeded' : 'tool_execution_failed',
        message: error instanceof Error ? error.message : String(error),
        ...(timedOut ? { details: toolDeadlines.timeoutDetails(tool.name, deadlineMs, Date.now() - startedAt, tool.operationTypes) } : {}),
      },
      request_id: requestId,
    });
  } finally {
    await requests.audit({ requestId, jti: ctx.jti, subject: ctx.sub, category, tool: tool.name, target: tool.executionTarget, status }).catch(error => console.error('[sulla-tools] audit failed', error));
  }
});

app.use((error: any, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(error?.type === 'entity.parse.failed' ? 400 : 500).json({ success: false, error: { code: 'bad_request', message: error instanceof Error ? error.message : String(error) } });
});

async function main(): Promise<void> {
  await initializeCatalog();
  await requests.initialize();
  const server = app.listen(config.port, '0.0.0.0', () => console.log(`[sulla-tools] listening on :${ config.port }`));
  guard.handleSignals(async() => {
    server.closeIdleConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    // Redis may already be gone; a hard disconnect still lets shutdown finish.
    await redis.quit().catch(() => redis.disconnect());
    await pool.end();
  });
}

// A failed start must end the process so Docker restarts it.
main().catch(error => guard.fatal('startup failed', error));
