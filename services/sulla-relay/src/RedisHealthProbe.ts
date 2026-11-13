// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Answers /healthz's "can this service still reach Redis?" within a short timeout, so a
 * dropped connection reports unhealthy instead of hanging the probe. ioredis reconnects
 * with backoff on its own, so the probe recovers as soon as Redis does.
 */
export class RedisHealthProbe {
  constructor(
    private readonly redis: { ping(): Promise<string> },
    private readonly timeoutMs = 2_000,
  ) {}

  async reachable(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        this.redis.ping().then(reply => reply === 'PONG'),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), this.timeoutMs) }),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
