import crypto from 'node:crypto';

import express from 'express';
import Redis from 'ioredis';
import { Pool } from 'pg';

import { executeCatalogTool, initializeCatalog, listTools, resolveTool } from './catalog.js';
import { config, validateConfig } from './config.js';
import { RedisRevocationStore, RequestStore } from './stores.js';
import { CapabilityTokenError, verifyCapabilityToken } from '../../../pkg/rancher-desktop/runtime/capabilityToken.js';
import { HttpDesktopExecutor } from '../../../pkg/rancher-desktop/runtime/desktopExecutor.js';

import type { ToolExecutionContext } from '../../../pkg/rancher-desktop/agent/tools/executionContext.js';

validateConfig();
process.env.SULLA_DATABASE_URL = config.databaseUrl;
process.env.SULLA_REDIS_URL = config.redisUrl;

const app = express();
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
const pool = new Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 2_000 });
const revocations = new RedisRevocationStore(redis);
const requests = new RequestStore(redis, pool);
const desktop = new HttpDesktopExecutor(config.desktopExecutorUrl, config.desktopExecutorToken);

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.get('/healthz', async(_request, response) => {
  try {
    await Promise.all([redis.ping(), pool.query('SELECT 1')]);
    response.json({ status: 'ok' });
  } catch {
    response.status(503).json({ status: 'unhealthy' });
  }
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
  } catch (error) {
    const auth = error instanceof CapabilityTokenError ? error : new CapabilityTokenError('invalid', 'Capability verification failed');
    const status = auth.code === 'scope' ? 403 : 401;
    return response.status(status).json({ success: false, error: { code: auth.code, message: auth.message }, request_id: requestId });
  }

  const args = request.body?.params && typeof request.body.params === 'object' ? request.body.params : (request.body ?? {});
  const idempotencyKey = request.header('Idempotency-Key');
  if (idempotencyKey && !await requests.reserveIdempotency(`${ ctx.sub }:${ idempotencyKey }`)) {
    return response.status(409).json({ success: false, error: { code: 'duplicate_request', message: 'Idempotency key was already used' }, request_id: requestId });
  }

  let status = 200;
  try {
    const result = tool.executionTarget === 'catalog'
      ? await Promise.race([
        executeCatalogTool(ctx, tool, args),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Tool deadline exceeded')), config.requestTimeoutMs)),
      ])
      : await desktop.execute(ctx, category, requested, args, { deadlineMs: config.requestTimeoutMs });
    if (tool.executionTarget !== 'catalog') {
      const forwarded = result as Awaited<ReturnType<typeof desktop.execute>>;
      if (!forwarded.success) status = forwarded.error?.code === 'deadline_exceeded' ? 504 : 503;
      return response.status(status).json({ ...forwarded, request_id: requestId });
    }
    response.json({ success: true, result, request_id: requestId });
  } catch (error) {
    status = 500;
    response.status(status).json({ success: false, error: { code: 'tool_execution_failed', message: error instanceof Error ? error.message : String(error) }, request_id: requestId });
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
  app.listen(config.port, '0.0.0.0', () => console.log(`[sulla-tools] listening on :${ config.port }`));
}

main().catch(error => {
  console.error('[sulla-tools] fatal', error);
  process.exitCode = 1;
});
