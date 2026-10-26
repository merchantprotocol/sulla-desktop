// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import { statfs } from 'node:fs/promises';

import type { Router } from 'express';

import { adminRoute, number, record } from './common.js';
import { containers, publicService } from './docker.js';
import type { RouteContext } from '../routes/helpers.js';

function gb(bytes: number): number {
  return Math.round((bytes / 1_073_741_824) * 10) / 10;
}

async function disk() {
  try {
    const info = await statfs(process.env.SULLA_SERVER_DATA_DIR ?? '/var/lib/sulla-server');
    const total = Number(info.blocks) * Number(info.bsize);
    const free = Number(info.bavail) * Number(info.bsize);
    return { totalGb: gb(total), usedGb: gb(total - free) };
  } catch {
    return { totalGb: 0, usedGb: 0, available: false };
  }
}

export function registerOverviewRoutes(router: Router, context: RouteContext): void {
  router.get('/server/v1/overview', adminRoute(async(_request, response) => {
    const [dockerResult, limitsResult, storage] = await Promise.allSettled([
      containers(),
      context.clients.accounts.admin('/limits'),
      disk(),
    ]);
    const limits = limitsResult.status === 'fulfilled' ? record(limitsResult.value) : {};
    const listed = dockerResult.status === 'fulfilled' ? dockerResult.value.map(publicService) : [];
    const edition = context.license.status().edition;
    response.json({
      host: hostname(),
      edition,
      version: runningVersion(listed),
      seats: {
        used: number(limits.seatsUsed),
        total: limits.seatLimit == null ? null : number(limits.seatLimit),
      },
      storage: storage.status === 'fulfilled' ? storage.value : { totalGb: 0, usedGb: 0, available: false },
      services: listed,
      machine: { available: false, cpuPct: 0, memUsedGb: 0, memoryGb: 0, diskUsedGb: 0, diskTotalGb: 0 },
      updateAvailable: false,
    });
  }));
}

export function hostname(): string {
  const configured = process.env.SULLA_PUBLIC_URL ?? process.env.SULLA_CONSOLE_PUBLIC_URL;
  if (!configured) return '';
  try {
    return new URL(configured).host;
  } catch {
    return configured;
  }
}

function runningVersion(services: ReturnType<typeof publicService>[]): string {
  const console = services.find(service => service.name === 'console');
  const image = String(console?.image ?? '');
  const tag = image.match(/:([^/:]+)$/)?.[1];
  return tag && tag !== 'latest' ? tag : process.env.SULLA_IMAGE_TAG ?? 'unknown';
}
