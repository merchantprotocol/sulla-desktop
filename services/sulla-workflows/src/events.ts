import { createClient, type RedisClientType } from 'redis';

import { config } from './config.js';
import { pool } from './db.js';

let redis: RedisClientType | null = null;

async function publisher(): Promise<RedisClientType> {
  if (!redis) {
    redis = createClient({ url: config.redisUrl });
    redis.on('error', error => console.warn('[workflow-events] Redis publish failed:', error));
    await redis.connect();
  }
  return redis;
}

export async function emitEvent(
  executionId: string,
  workflowId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
  nodeId?: string,
): Promise<void> {
  const event = {
    type: eventType,
    executionId,
    workflowId,
    nodeId,
    timestamp: new Date().toISOString(),
    ...payload,
  };
  await pool.query(
    `INSERT INTO workflow_execution_events
       (execution_id, workflow_id, event_type, node_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [executionId, workflowId, eventType, nodeId ?? null, JSON.stringify(event)],
  );
  try {
    await (await publisher()).publish('sulla:workflow:events', JSON.stringify(event));
  } catch (error) {
    console.warn('[workflow-events] Redis unavailable; event remains durable in Postgres:', error);
  }
}

export async function closeEvents(): Promise<void> {
  if (redis) await redis.quit();
  redis = null;
}
