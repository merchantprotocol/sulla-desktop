import { deriveCapabilitySigningKey } from '../../../pkg/rancher-desktop/runtime/capabilityToken.js';

const configuredKey = process.env.SULLA_CAPABILITY_SIGNING_KEY ?? '';
const installationSecret = process.env.SULLA_API_TOKEN ?? '';

export const config = {
  port:                 Number(process.env.PORT ?? 3000),
  databaseUrl:          process.env.SULLA_DATABASE_URL ?? 'postgresql://sulla:sulla_dev_password@postgres:5432/sulla',
  redisUrl:             process.env.SULLA_REDIS_URL ?? 'redis://redis:6379',
  signingKey:           configuredKey || (installationSecret ? deriveCapabilitySigningKey(installationSecret) : ''),
  desktopExecutorUrl:   process.env.SULLA_DESKTOP_EXECUTOR_URL ?? 'http://host.docker.internal:3000',
  desktopExecutorToken: process.env.SULLA_DESKTOP_EXECUTOR_TOKEN ?? installationSecret,
  relayUrl:              process.env.SULLA_RELAY_URL ?? '',
  relayToken:            process.env.SULLA_RELAY_TOKEN ?? '',
  relayDeviceId:         process.env.SULLA_RELAY_DEVICE_ID ?? '',
  requestTimeoutMs:     Math.max(100, Number(process.env.SULLA_TOOL_TIMEOUT_MS ?? 30_000)),
};

export function validateConfig(): void {
  if (Buffer.byteLength(config.signingKey) < 32) throw new Error('SULLA_CAPABILITY_SIGNING_KEY or SULLA_API_TOKEN is required');
  if (Boolean(config.relayUrl) !== Boolean(config.relayToken)) throw new Error('SULLA_RELAY_URL and SULLA_RELAY_TOKEN must be configured together');
  if (!config.relayUrl && !config.desktopExecutorToken) throw new Error('SULLA_DESKTOP_EXECUTOR_TOKEN is required when relay forwarding is disabled');
}
