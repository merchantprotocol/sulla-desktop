// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Outcome normaliser for the E9 equivalence specs. Delete in final cleanup.

/** Normalises a settled promise so legacy and new implementations can be compared field by field. */
export class E9Outcome {
  static async of(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      const failure = error as { constructor?: { name?: string }; name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
      return {
        ok:         false,
        type:       failure?.constructor?.name,
        name:       failure?.name,
        code:       failure?.code,
        status:     failure?.status,
        statusCode: failure?.statusCode,
        message:    failure?.message,
      };
    }
  }

  static sync(run: () => unknown): Record<string, unknown> {
    try {
      return { ok: true, value: run() };
    } catch (error) {
      const failure = error as { constructor?: { name?: string }; name?: unknown; code?: unknown; status?: unknown; message?: unknown };
      return { ok: false, type: failure?.constructor?.name, name: failure?.name, code: failure?.code, status: failure?.status, message: failure?.message };
    }
  }
}
