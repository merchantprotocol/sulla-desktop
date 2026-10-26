// SPDX-License-Identifier: LicenseRef-Sulla-Fair-Code
import { randomUUID } from 'node:crypto';

import { Router, type NextFunction, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';

import { getBearer, verifyOidcToken } from './auth.js';
import { base64url, digest } from './crypto.js';
import { object, string } from './http.js';

import type { AccountsConfig } from './config.js';
import type { Database } from './db.js';

type AsyncRoute = (request: Request, response: Response, next: NextFunction) => Promise<void>;
const route =
  (handler: AsyncRoute) =>
  (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response, next).catch(next);
  };
class DeviceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(value: unknown, name: string): string {
  const result = string(value, name, 36);
  if (!UUID.test(result)) throw new DeviceError(400, `${name} is invalid`);
  return result;
}
function body(request: Request): Record<string, unknown> {
  try {
    return object(request.body);
  } catch {
    throw new DeviceError(400, 'JSON object body is required');
  }
}

async function desktopIdentity(db: Database, config: AccountsConfig, request: Request, organizationId: string) {
  const authority = await db.query('SELECT issuer,jwks_uri FROM accounts.authorities WHERE id=$1', [
    config.keycloakAuthorityId,
  ]);
  if (!authority.rows[0] || !config.keycloakNativeClientId)
    throw new DeviceError(503, 'desktop enrollment is unavailable');
  let identity;
  try {
    identity = await verifyOidcToken(
      getBearer(request) ?? '',
      authority.rows[0].issuer,
      config.keycloakNativeClientId,
      authority.rows[0].jwks_uri,
    );
  } catch {
    throw new DeviceError(401, 'invalid_token');
  }
  const member = await db.query(
    'SELECT 1 FROM accounts.memberships WHERE issuer=$1 AND subject=$2 AND organization_id=$3 AND revoked_at IS NULL',
    [identity.issuer, identity.subject, organizationId],
  );
  if (!member.rowCount) throw new DeviceError(403, 'organization membership is not active');
  return identity;
}

function deviceSession(
  config: AccountsConfig,
  device: Record<string, unknown>,
  audience = 'sulla-desktop-enrollment',
  expiresIn = 300,
): string {
  return jwt.sign(
    { organization_id: device.organization_id, server_id: config.serverId, device_id: device.id },
    config.sessionSecret,
    {
      algorithm: 'HS256',
      issuer: config.publicUrl,
      audience,
      subject: String(device.subject),
      jwtid: randomUUID(),
      expiresIn,
    },
  );
}

async function authenticatedDevice(
  db: Database,
  config: AccountsConfig,
  request: Request,
): Promise<Record<string, unknown>> {
  let payload;
  try {
    payload = jwt.verify(getBearer(request) ?? '', config.sessionSecret, {
      algorithms: ['HS256'],
      issuer: config.publicUrl,
      audience: 'sulla-desktop-enrollment',
    });
  } catch {
    throw new DeviceError(401, 'invalid_device_session');
  }
  if (typeof payload === 'string' || typeof payload.device_id !== 'string' || payload.server_id !== config.serverId)
    throw new DeviceError(401, 'invalid_device_session');
  const found = await db.query('SELECT * FROM accounts.desktop_devices WHERE id=$1 AND status=$2', [
    payload.device_id,
    'active',
  ]);
  if (!found.rows[0]) throw new DeviceError(401, 'device_revoked');
  return found.rows[0];
}

export function serverDiscoveryRoutes(config: AccountsConfig): Router {
  const router = Router();
  router.get('/.well-known/sulla-server', (_request, response) => {
    const publicUrl = new URL(config.publicUrl);
    const relay = new URL('/relay/v1/tunnel', publicUrl);
    relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:';
    response.set('cache-control', 'public, max-age=300').json({
      protocolVersion: 1,
      serverId: config.serverId,
      displayName: config.serverDisplayName,
      authority: config.keycloakIssuer,
      accounts: new URL('/accounts-api', publicUrl).href.replace(/\/$/, ''),
      desktopApi: new URL('/desktop/v1', publicUrl).href.replace(/\/$/, ''),
      relay: relay.href,
      resourceAudiences: [...config.keycloakResourceAudiences],
    });
  });
  return router;
}

export function desktopRoutes(db: Database, config: AccountsConfig): Router {
  const router = Router();
  router.post(
    '/enrollments',
    route(async (request, response) => {
      const input = body(request);
      const organizationId = uuid(input.organizationId, 'organizationId');
      const identity = await desktopIdentity(db, config, request, organizationId);
      const deviceId = string(input.deviceId, 'deviceId', 128);
      const publicKey = string(input.publicKey, 'publicKey', 4096);
      const metadata = input.metadata === undefined ? {} : object(input.metadata);
      const id = randomUUID();
      const pollToken = base64url(32);
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      const saved = await db.query(
        `INSERT INTO accounts.desktop_enrollments(id,organization_id,issuer,subject,device_id,public_key,metadata,poll_token_digest,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(organization_id,device_id) DO UPDATE SET issuer=EXCLUDED.issuer,subject=EXCLUDED.subject,public_key=EXCLUDED.public_key,
         metadata=EXCLUDED.metadata,poll_token_digest=EXCLUDED.poll_token_digest,status='pending',expires_at=EXCLUDED.expires_at,decided_at=NULL
       RETURNING id,status,expires_at`,
        [
          id,
          organizationId,
          identity.issuer,
          identity.subject,
          deviceId,
          publicKey,
          metadata,
          digest(pollToken),
          expiresAt,
        ],
      );
      response.status(202).json({ enrollment: saved.rows[0], pollToken });
    }),
  );
  router.get(
    '/enrollments/:id',
    route(async (request, response) => {
      const id = uuid(request.params.id, 'enrollment id');
      const token = getBearer(request);
      const found = token
        ? await db.query('SELECT * FROM accounts.desktop_enrollments WHERE id=$1 AND poll_token_digest=$2', [
            id,
            digest(token),
          ])
        : { rows: [] };
      const enrollment = found.rows[0];
      if (!enrollment) throw new DeviceError(404, 'enrollment not found');
      if (enrollment.status === 'pending' && new Date(enrollment.expires_at) <= new Date()) {
        await db.query("UPDATE accounts.desktop_enrollments SET status='expired' WHERE id=$1", [id]);
        enrollment.status = 'expired';
      }
      let deviceSessionToken;
      if (enrollment.status === 'approved') {
        const device = await db.query(
          'SELECT * FROM accounts.desktop_devices WHERE organization_id=$1 AND device_id=$2 AND status=$3',
          [enrollment.organization_id, enrollment.device_id, 'active'],
        );
        if (device.rows[0]) deviceSessionToken = deviceSession(config, device.rows[0]);
      }
      response.json({
        id: enrollment.id,
        status: enrollment.status,
        expiresAt: enrollment.expires_at,
        deviceSessionToken,
      });
    }),
  );
  router.post(
    '/devices/:id/heartbeat',
    route(async (request, response) => {
      const device = await authenticatedDevice(db, config, request);
      if (device.id !== uuid(request.params.id, 'device id')) throw new DeviceError(403, 'device mismatch');
      const input = body(request);
      const metadata = input.metadata === undefined ? {} : object(input.metadata);
      await db.query(
        'UPDATE accounts.desktop_devices SET metadata=metadata || $2::jsonb,last_heartbeat_at=now(),updated_at=now() WHERE id=$1',
        [device.id, metadata],
      );
      response.json({ ok: true, serverTime: new Date().toISOString() });
    }),
  );
  router.post(
    '/devices/:id/tickets/relay',
    route(async (request, response) => {
      const device = await authenticatedDevice(db, config, request);
      if (device.id !== uuid(request.params.id, 'device id')) throw new DeviceError(403, 'device mismatch');
      const jti = randomUUID();
      const expiresAt = new Date(Date.now() + 60_000);
      await db.query('INSERT INTO accounts.desktop_relay_tickets(jti_digest,device_id,expires_at) VALUES($1,$2,$3)', [
        digest(jti),
        device.id,
        expiresAt,
      ]);
      const token = jwt.sign(
        { organization_id: device.organization_id, server_id: config.serverId, device_id: device.id },
        config.sessionSecret,
        {
          algorithm: 'HS256',
          issuer: config.publicUrl,
          audience: 'sulla-relay-device',
          subject: String(device.subject),
          jwtid: jti,
          expiresIn: 60,
        },
      );
      response.json({ token, expiresAt: expiresAt.toISOString() });
    }),
  );
  router.post(
    '/devices/:id/token',
    route(async (request, response) => {
      const device = await authenticatedDevice(db, config, request);
      if (device.id !== uuid(request.params.id, 'device id')) throw new DeviceError(403, 'device mismatch');
      const audience = string(body(request).audience, 'audience', 300);
      if (!config.keycloakResourceAudiences.has(audience)) throw new DeviceError(403, 'audience is not allowed');
      response.json({ token: deviceSession(config, device, audience), expiresIn: 300, audience });
    }),
  );
  router.delete(
    '/devices/:id',
    route(async (request, response) => {
      const device = await authenticatedDevice(db, config, request);
      if (device.id !== uuid(request.params.id, 'device id')) throw new DeviceError(403, 'device mismatch');
      await revokeDevice(db, String(device.id));
      response.status(204).end();
    }),
  );
  return router;
}

export async function revokeDevice(db: Database, id: string): Promise<void> {
  await db.query("UPDATE accounts.desktop_devices SET status='revoked',revoked_at=now(),updated_at=now() WHERE id=$1", [
    id,
  ]);
  await db.query('UPDATE accounts.desktop_relay_tickets SET revoked_at=COALESCE(revoked_at,now()) WHERE device_id=$1', [
    id,
  ]);
}

export function deviceAdminRoutes(db: Database): Router {
  const router = Router();
  router.get(
    '/devices',
    route(async (_request, response) => {
      const pending = await db.query(
        "SELECT id,organization_id,subject,device_id,metadata,status,expires_at,created_at FROM accounts.desktop_enrollments WHERE status='pending' ORDER BY created_at",
      );
      const devices = await db.query(
        'SELECT id,organization_id,subject,device_id,name,metadata,status,last_heartbeat_at,created_at,updated_at FROM accounts.desktop_devices ORDER BY created_at',
      );
      response.json({ pending: pending.rows, devices: devices.rows });
    }),
  );
  router.post(
    '/devices/enrollments/:id/approve',
    route(async (request, response) => {
      const id = uuid(request.params.id, 'enrollment id');
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query(
          "SELECT * FROM accounts.desktop_enrollments WHERE id=$1 AND status='pending' AND expires_at>now() FOR UPDATE",
          [id],
        );
        const enrollment = found.rows[0];
        if (!enrollment) throw new DeviceError(404, 'pending enrollment not found');
        const existing = await client.query(
          "SELECT subject FROM accounts.desktop_devices WHERE organization_id=$1 AND device_id=$2 AND status='active' FOR UPDATE",
          [enrollment.organization_id, enrollment.device_id],
        );
        if (existing.rows[0] && existing.rows[0].subject !== enrollment.subject) {
          throw new DeviceError(409, 'device_id_in_use');
        }
        const device = await client.query(
          `INSERT INTO accounts.desktop_devices(id,organization_id,issuer,subject,device_id,public_key,metadata,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'active') ON CONFLICT(organization_id,device_id) DO UPDATE SET issuer=EXCLUDED.issuer,subject=EXCLUDED.subject,public_key=EXCLUDED.public_key,metadata=EXCLUDED.metadata,status='active',revoked_at=NULL,updated_at=now() RETURNING *`,
          [
            randomUUID(),
            enrollment.organization_id,
            enrollment.issuer,
            enrollment.subject,
            enrollment.device_id,
            enrollment.public_key,
            enrollment.metadata,
          ],
        );
        await client.query("UPDATE accounts.desktop_enrollments SET status='approved',decided_at=now() WHERE id=$1", [
          id,
        ]);
        await client.query('COMMIT');
        response.json({ device: device.rows[0] });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }),
  );
  router.post(
    '/devices/enrollments/:id/deny',
    route(async (request, response) => {
      const changed = await db.query(
        "UPDATE accounts.desktop_enrollments SET status='denied',decided_at=now() WHERE id=$1 AND status='pending' RETURNING id",
        [uuid(request.params.id, 'enrollment id')],
      );
      if (!changed.rowCount) throw new DeviceError(404, 'pending enrollment not found');
      response.status(204).end();
    }),
  );
  router.post(
    '/devices/:id/revoke',
    route(async (request, response) => {
      await revokeDevice(db, uuid(request.params.id, 'device id'));
      response.status(204).end();
    }),
  );
  return router;
}

export function deviceErrorHandler(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (!(error instanceof DeviceError)) {
    next(error);
    return;
  }
  response.status(error.status).json({ error: error.message.replaceAll(' ', '_') });
}
