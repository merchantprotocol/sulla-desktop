import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

export interface DeviceTokenClaims extends jwt.JwtPayload {
  sub:       string;
  device_id: string;
  aud:       'sulla-relay-device';
}

export function verifyDeviceToken(token: string, secret: string): DeviceTokenClaims {
  const payload = jwt.verify(token, secret, {
    algorithms: ['HS256'],
    audience:   'sulla-relay-device',
  });
  if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.device_id !== 'string') {
    throw new Error('Invalid device token claims');
  }
  return payload as DeviceTokenClaims;
}

export function bearerToken(value: string | undefined): string {
  return value?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
}

export function tokenMatches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
