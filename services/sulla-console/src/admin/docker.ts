// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import { DOCKER_PROXY_URL } from './common.js';

interface DockerContainer {
  Id?: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  State?: string;
  Status?: string;
  Created?: number;
  Labels?: Record<string, string>;
}

async function dockerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(new URL(path, DOCKER_PROXY_URL), {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw Object.assign(new Error('docker_proxy_unavailable'), { status: response.status });
  return response;
}

export async function containers(): Promise<DockerContainer[]> {
  const response = await dockerFetch('/containers/json?all=1');
  const body = await response.json();
  return Array.isArray(body) ? body as DockerContainer[] : [];
}

export function serviceName(container: DockerContainer): string {
  return container.Labels?.['com.docker.compose.service']
    ?? container.Names?.[0]?.replace(/^\//, '')
    ?? container.Id?.slice(0, 12)
    ?? 'unknown';
}

export function publicService(container: DockerContainer) {
  const status = container.Status ?? container.State ?? 'unknown';
  const match = status.match(/\((healthy|unhealthy|starting)\)/i);
  return {
    id: container.Id ?? serviceName(container),
    name: serviceName(container),
    container: container.Names?.[0]?.replace(/^\//, '') ?? serviceName(container),
    image: container.Image ?? '',
    state: container.State ?? 'unknown',
    status,
    health: match?.[1]?.toLowerCase() ?? null,
    startedAt: container.Created ? new Date(container.Created * 1_000).toISOString() : null,
  };
}

function stripDockerFrames(data: Uint8Array): string {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset + 8 <= data.length && (data[offset] === 1 || data[offset] === 2)) {
    const size = new DataView(data.buffer, data.byteOffset + offset + 4, 4).getUint32(0);
    if (offset + 8 + size > data.length) break;
    chunks.push(data.slice(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  if (!chunks.length) return new TextDecoder().decode(data);
  return chunks.map(chunk => new TextDecoder().decode(chunk)).join('');
}

export async function containerLogs(id: string, tail: number): Promise<string[]> {
  const params = new URLSearchParams({ stdout: '1', stderr: '1', timestamps: '1', tail: String(tail) });
  const response = await dockerFetch(`/containers/${encodeURIComponent(id)}/logs?${params}`);
  const text = stripDockerFrames(new Uint8Array(await response.arrayBuffer()));
  return text.split(/\r?\n/).filter(Boolean);
}

export async function startBackup(): Promise<void> {
  const all = await containers();
  const backup = all.find(container => serviceName(container) === 'backup');
  if (!backup?.Id) throw Object.assign(new Error('backup_service_unavailable'), { status: 503 });
  await dockerFetch(`/containers/${encodeURIComponent(backup.Id)}/start`, { method: 'POST' });
}
