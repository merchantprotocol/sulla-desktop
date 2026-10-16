import os from 'node:os';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${ name } is required`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${ name } must be a positive integer`);
  return parsed;
}

export interface RelayConfig {
  port:                 number;
  replicaId:            string;
  redisUrl:             string;
  deviceTokenSecret:    string;
  internalToken:        string;
  maxInFlightPerDevice: number;
  presenceTtlSeconds:   number;
  maxDeadlineMs:        number;
}

export function loadConfig(): RelayConfig {
  return {
    port:                 positiveInteger('PORT', 8790),
    replicaId:            process.env.SULLA_RELAY_REPLICA_ID?.trim() || `${ os.hostname() }-${ process.pid }`,
    redisUrl:             process.env.SULLA_REDIS_URL?.trim() || 'redis://127.0.0.1:6379',
    deviceTokenSecret:    required('SULLA_RELAY_DEVICE_TOKEN_SECRET'),
    internalToken:        required('SULLA_RELAY_INTERNAL_TOKEN'),
    maxInFlightPerDevice: positiveInteger('SULLA_RELAY_MAX_IN_FLIGHT', 16),
    presenceTtlSeconds:   positiveInteger('SULLA_RELAY_PRESENCE_TTL_SECONDS', 45),
    maxDeadlineMs:        positiveInteger('SULLA_RELAY_MAX_DEADLINE_MS', 120_000),
  };
}
