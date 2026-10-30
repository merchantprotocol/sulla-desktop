// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import paths from '@pkg/utils/paths';

export const SERVICE_DEFAULT_PORTS = Object.freeze({
  chat: 3000, command: 6107, terminal: 6108,
  postgres: 30116, redis: 30117, 'runtime-python': 30118,
  'runtime-shell': 30119, 'runtime-node': 30120, secrets: 30121,
  workflows: 30122, tools: 30123, files: 30124, relay: 30126,
  vault: 30135, accounts: 3020,
} as const);
export const SERVICE_CONTAINER_PORTS = Object.freeze({ accounts: 3020 } as const);

export type ServiceName = keyof typeof SERVICE_DEFAULT_PORTS | string;
export type ServiceChange = { service: string; port: number; previousPort?: number };
type PortState = { version: 1; ports: Record<string, number> };

const stateFile = () => path.join(paths.appHome, 'ports.json');
const listeners = new Set<(change: ServiceChange) => void>();
let loaded = false;
let state: PortState = { version: 1, ports: {} };
const logged = new Map<string, number>();

function logResolution(service: ServiceName, port: number, source: 'persisted' | 'default' | 'reassigned'): void {
  if (logged.get(String(service)) === port && source !== 'reassigned') return;
  logged.set(String(service), port);
  console.log(`[ports] ${ service }=${ port } (${ source })`);
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<PortState>;
    if (parsed.version === 1 && parsed.ports && typeof parsed.ports === 'object') state = parsed as PortState;
  } catch { /* first launch or a recoverable corrupt file */ }
}

function persist(): void {
  fs.mkdirSync(paths.appHome, { recursive: true });
  const file = stateFile();
  const temp = `${ file }.${ process.pid }.tmp`;
  fs.writeFileSync(temp, `${ JSON.stringify(state, null, 2) }\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  const envFile = path.join(paths.appHome, 'ports.env');
  const envTemp = `${ envFile }.${ process.pid }.tmp`;
  const env = Object.entries(state.ports).sort(([a], [b]) => a.localeCompare(b))
    .map(([service, port]) => `SULLA_SERVICE_${ service.toUpperCase().replaceAll('-', '_') }_PORT=${ port }`).join('\n');
  fs.writeFileSync(envTemp, `${ env }\n`, { mode: 0o600 });
  fs.renameSync(envTemp, envFile);
}

export function servicePort(service: ServiceName): number {
  load();
  const persisted = state.ports[service];
  if (Number.isInteger(persisted) && persisted > 0 && persisted < 65536) return persisted;
  const fallback = SERVICE_DEFAULT_PORTS[service as keyof typeof SERVICE_DEFAULT_PORTS];
  if (!fallback) throw new Error(`Unknown local service: ${ service }`);
  state.ports[service] = fallback;
  persist();
  logResolution(service, fallback, 'default');
  return fallback;
}

export function serviceOrigin(service: ServiceName, protocol = 'http'): string {
  return `${ protocol }://127.0.0.1:${ servicePort(service) }`;
}

export function listServices(): Record<string, number> {
  load();
  for (const service of Object.keys(SERVICE_DEFAULT_PORTS)) servicePort(service);
  return { ...state.ports };
}

export function onServiceChange(callback: (change: ServiceChange) => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function canListen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export async function resolveServicePort(service: ServiceName, ownedPort?: number): Promise<number> {
  const wanted = servicePort(service);
  if (wanted === ownedPort || await canListen(wanted)) {
    logResolution(service, wanted, 'persisted');
    return wanted;
  }
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const assigned = typeof address === 'object' && address ? address.port : 0;
      server.close(() => assigned ? resolve(assigned) : reject(new Error('No ephemeral port assigned')));
    });
  });
  state.ports[service] = port;
  persist();
  logResolution(service, port, 'reassigned');
  const change = { service: String(service), port, previousPort: wanted };
  for (const callback of listeners) callback(change);
  return port;
}
