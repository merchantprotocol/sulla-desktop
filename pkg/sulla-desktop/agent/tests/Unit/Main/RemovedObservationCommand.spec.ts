// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// Old observation commands must fail with one clear message. The first block checks the class;
// the second sends each old `sulla <category>/<tool>` call through the real internal-tool route
// handler (ChatCompletionsServer.handleIntegrationCall) with the real tool registry.
// @vitest-environment node
import '../../Support/TestHomeEnv';

import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { ChatCompletionsServer } from '../../../../main/chatCompletionsServer';
import { REMOVED_OBSERVATION_MEMORY_MESSAGE, RemovedObservationCommand } from '../../../../main/RemovedObservationCommand';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {}, ipcMain: { handle() {}, on() {} }, BrowserWindow: class {} }));

const REMOVED_COMMANDS = [
  'add_observational_memory',
  'search_observations',
  'list_observations',
  'remove_observational_memory',
  'add_identity_observation',
  'search_identity_observations',
  'list_identity_observations',
  'remove_identity_observation',
  'update_identity_section',
];

/** Captures the HTTP status and JSON body the route handler writes. */
class RecordedResponse {
  statusCode = 200;
  body: any = null;
  status(code: number): this { this.statusCode = code; return this }
  json(body: unknown): this { this.body = body; return this }
}

/** Sends one `sulla <category>/<tool>` call to the real internal-tool route handler. */
class InternalToolRoute {
  constructor(private readonly removedObservationCommand = new RemovedObservationCommand()) {}

  async call(category: string, tool: string): Promise<RecordedResponse> {
    const response = new RecordedResponse();
    const request = { params: { accountId: 'internal', slug: category, endpoint: tool }, body: {}, headers: {}, get: () => undefined };
    await (ChatCompletionsServer.prototype as any).handleIntegrationCall.call({ removedObservationCommand: this.removedObservationCommand }, request, response);
    return response;
  }
}

describe('RemovedObservationCommand', () => {
  it('returns the retirement error for every legacy observation CLI path', () => {
    // risk: stale agents can still invoke removed commands through either old namespace.
    const handler = new RemovedObservationCommand();

    for (const category of ['observation', 'meta', 'memory']) {
      for (const command of REMOVED_COMMANDS) {
        expect(handler.errorFor(category, command), `${ category }/${ command }`)
          .toBe(REMOVED_OBSERVATION_MEMORY_MESSAGE);
      }
    }
  });

  it('does not mask unrelated unknown CLI commands', () => {
    const handler = new RemovedObservationCommand();

    expect(handler.errorFor('observation', 'search_conversation_keywords')).toBeNull();
    expect(handler.errorFor('meta', 'exec')).toBeNull();
    expect(handler.errorFor('memory', 'search_observations')).toBe(REMOVED_OBSERVATION_MEMORY_MESSAGE);
    expect(handler.errorFor('memory', 'no_such_tool_ever')).toBeNull();
  });
});

describe('old observation commands through the sulla CLI tool route', () => {
  it('answers every removed command with the removed-from-Sulla error', async() => {
    // risk: an agent following old instructions gets a vague "not found" and keeps retrying, or the tool still runs
    const route = new InternalToolRoute();

    expect(REMOVED_OBSERVATION_MEMORY_MESSAGE).toBe('Observation memory has been removed from Sulla.');
    for (const category of ['observation', 'meta', 'memory']) {
      for (const command of REMOVED_COMMANDS) {
        const response = await route.call(category, command);
        expect(response.statusCode, `${ category }/${ command }`).toBe(404);
        expect(response.body, `${ category }/${ command }`).toMatchObject({ success: false, error: REMOVED_OBSERVATION_MEMORY_MESSAGE });
      }
    }
  });

  it('uses the constructor-injected retirement command in the real route handler', async() => {
    // risk: route handling bypasses its injected command instance and creates one per request
    const command = new RemovedObservationCommand();
    const errorFor = vi.spyOn(command, 'errorFor');
    const response = await new InternalToolRoute(command).call('memory', 'add_observational_memory');

    expect(errorFor).toHaveBeenCalledOnce();
    expect(response.body.error).toBe(REMOVED_OBSERVATION_MEMORY_MESSAGE);
  });

  it('keeps the normal not-found answer for a command that never existed', async() => {
    // risk: the removal message hides real typos in unrelated commands
    const response = await new InternalToolRoute().call('observation', 'no_such_tool_ever');

    expect(response.statusCode).toBe(404);
    expect(response.body.error).toContain('not found');
    expect(response.body.error).not.toContain(REMOVED_OBSERVATION_MEMORY_MESSAGE);
  });
});
