// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/agent/services/WebSocketClientService', () => ({ getWebSocketClientService: vi.fn(() => ({ send: vi.fn() })) }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({ postgresClient: { query: vi.fn(() => Promise.resolve([])) } }));

import { decisionService } from '@pkg/agent/services/DecisionService';
import { toolDecisionPort, ToolDecisionPortRegistry, UnavailableToolDecisionPort } from '@pkg/agent/tools/toolDecisionPort';

import { registerDesktopToolDecisionPort } from './toolDecisionPortRegistration';

describe('Desktop main tool approval port registration', () => {
  it('registers the real DecisionService on import so approval-gated tool calls reach the Desktop inbox', () => {
    // risk: if registration never runs, every approval-gated tool in Desktop is refused as "unavailable".
    expect(toolDecisionPort.resolve()).toBe(decisionService);
  });

  it('replaces the fail-closed default with the real port when registered explicitly', () => {
    // risk: a registry that keeps the unavailable default would silently refuse approved Desktop tool calls.
    const registry = new ToolDecisionPortRegistry();
    expect(registry.resolve()).toBeInstanceOf(UnavailableToolDecisionPort);
    registerDesktopToolDecisionPort(registry);
    expect(registry.resolve()).toBe(decisionService);
  });

  it('is imported by the Electron main entry before any agent code loads', () => {
    // risk: a lazy or indirect-only load leaves the port unregistered until some other module happens to import it.
    const entry = readFileSync(new URL('../../../background.ts', import.meta.url), 'utf8');
    expect(entry).toContain("import '@pkg/main/toolDecisionPortRegistration';");
  });
});
