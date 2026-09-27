/**
 * Browsers/phones the owner approved AT THIS DESKTOP to send it commands
 * over the secure channel. Stored in ~/.sulla/secure-channel-clients.json
 * (0600), outside the settings table the agent tool surface can write.
 */

import fs from 'fs';
import path from 'path';

import paths from '@pkg/utils/paths';

import type { ApprovedClient } from './secureChannelProtocol';

const MAX_CLIENTS = 50;

function filePath(): string {
  return path.join(paths.sullaConfig, 'secure-channel-clients.json');
}

let cache: ApprovedClient[] | null = null;

function read(): ApprovedClient[] {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf-8'));
    cache = Array.isArray(parsed?.clients) ? parsed.clients : [];
  } catch {
    cache = [];
  }
  return cache!;
}

function write(clients: ApprovedClient[]) {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${ file }.${ process.pid }.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, clients }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache = clients;
}

export const ApprovedClients = {
  list(): ApprovedClient[] {
    return [...read()];
  },
  get(clientId: string): ApprovedClient | undefined {
    return read().find(c => c.clientId === clientId);
  },
  add(client: ApprovedClient): void {
    const rest = read().filter(c => c.clientId !== client.clientId);
    write([client, ...rest].slice(0, MAX_CLIENTS));
  },
  touch(clientId: string): void {
    const list = read();
    const c = list.find(x => x.clientId === clientId);
    if (!c) return;
    const now = Date.now();
    // Throttle disk writes to once a minute per client.
    if (c.lastUsedAt && now - Date.parse(c.lastUsedAt) < 60_000) return;
    c.lastUsedAt = new Date(now).toISOString();
    write(list);
  },
  remove(clientId: string): boolean {
    const list = read();
    const next = list.filter(c => c.clientId !== clientId);
    if (next.length === list.length) return false;
    write(next);
    return true;
  },
  removeAll(): void {
    write([]);
  },
  _resetCache(): void {
    cache = null;
  },
};
