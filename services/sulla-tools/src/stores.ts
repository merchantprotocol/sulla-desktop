import Redis from 'ioredis';
import { Pool } from 'pg';

import type { CapabilityRevocationStore } from '../../../pkg/rancher-desktop/runtime/capabilityToken.js';

export class RedisRevocationStore implements CapabilityRevocationStore {
  constructor(private readonly redis: Redis) {}

  async isRevoked(jti: string): Promise<boolean> {
    return await this.redis.exists(`sulla:capability:revoked:${ jti }`) === 1;
  }

  async revoke(jti: string, expiresAt: number): Promise<void> {
    const ttl = Math.max(1, expiresAt - Math.floor(Date.now() / 1000));
    await this.redis.set(`sulla:capability:revoked:${ jti }`, '1', 'EX', ttl);
  }
}

export class RequestStore {
  constructor(private readonly redis: Redis, private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS tool_api_audit (
      request_id text PRIMARY KEY, jti text NOT NULL, subject_id text NOT NULL,
      category text NOT NULL, tool text NOT NULL, target text NOT NULL,
      status integer NOT NULL, created_at timestamptz NOT NULL DEFAULT NOW()
    )`);
  }

  async reserveIdempotency(key: string, ttlSeconds = 86_400): Promise<boolean> {
    return await this.redis.set(`sulla:tools:idempotency:${ key }`, '1', 'EX', ttlSeconds, 'NX') === 'OK';
  }

  async audit(row: { requestId: string; jti: string; subject: string; category: string; tool: string; target: string; status: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO tool_api_audit(request_id,jti,subject_id,category,tool,target,status)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(request_id) DO NOTHING`,
      [row.requestId, row.jti, row.subject, row.category, row.tool, row.target, row.status],
    );
  }
}
