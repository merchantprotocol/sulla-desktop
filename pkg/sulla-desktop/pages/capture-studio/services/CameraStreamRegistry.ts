// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { CameraStreamService } from '../effects/CameraStreamService';

/** Owns an independent effect/acquisition lifecycle for every camera source ID. */
export class CameraStreamRegistry {
  private readonly services = new Map<string, CameraStreamService>();

  constructor(private readonly create: (sourceId: string) => CameraStreamService) {}

  get(sourceId: string): CameraStreamService {
    let service = this.services.get(sourceId);
    if (!service) {
      service = this.create(sourceId);
      this.services.set(sourceId, service);
    }
    return service;
  }

  values(): CameraStreamService[] { return [...this.services.values()] }

  async disposeAll(): Promise<void> {
    const results = await Promise.allSettled(this.values().map(service => service.dispose()));
    this.services.clear();
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
