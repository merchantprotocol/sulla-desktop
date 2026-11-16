// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Applies Preferences → AI models → Request settings ("Retries per provider"
 * and "Request timeout") to the model services that make HTTP requests.
 *
 * A value only applies once the owner has saved one. Until then every
 * provider keeps its built-in default (for example 180 s for OpenAI-compatible
 * providers), so untouched installs behave exactly as before.
 */

export const RETRY_COUNT_KEY = 'remoteRetryCount';
export const TIMEOUT_SECONDS_KEY = 'remoteTimeoutSeconds';

/** The same limits the Preferences inputs enforce. */
export const RETRY_LIMITS = { min: 0, max: 10 } as const;
export const TIMEOUT_LIMITS = { min: 5, max: 600 } as const;

export interface RequestSettingsReader {
  get(property: string, defaultValue?: unknown): Promise<unknown>;
}

/** Services that support these settings expose one or both setters. CLI agents expose neither. */
export interface RequestTunableService {
  setRetryCount?: (count: number) => void;
  setDefaultTimeoutSeconds?: (seconds: number) => void;
}

export interface ResolvedRequestSettings {
  retries?:        number;
  timeoutSeconds?: number;
}

export class ModelRequestSettings {
  constructor(private readonly reader: RequestSettingsReader) {}

  /** The owner's saved values, or undefined for any that are unset or out of range. */
  async read(): Promise<ResolvedRequestSettings> {
    const [retries, timeout] = await Promise.all([
      this.reader.get(RETRY_COUNT_KEY, null),
      this.reader.get(TIMEOUT_SECONDS_KEY, null),
    ]);

    return {
      retries:        ModelRequestSettings.whole(retries, RETRY_LIMITS),
      timeoutSeconds: ModelRequestSettings.whole(timeout, TIMEOUT_LIMITS),
    };
  }

  async applyTo(service: RequestTunableService): Promise<ResolvedRequestSettings> {
    const resolved = await this.read();

    if (resolved.retries !== undefined && typeof service.setRetryCount === 'function') {
      service.setRetryCount(resolved.retries);
    }
    if (resolved.timeoutSeconds !== undefined && typeof service.setDefaultTimeoutSeconds === 'function') {
      service.setDefaultTimeoutSeconds(resolved.timeoutSeconds);
    }

    return resolved;
  }

  private static whole(raw: unknown, limits: { min: number, max: number }): number | undefined {
    if (raw === null || raw === undefined || raw === '') {
      return undefined;
    }
    const n = Number(raw);

    if (!Number.isInteger(n) || n < limits.min || n > limits.max) {
      return undefined;
    }

    return n;
  }
}
