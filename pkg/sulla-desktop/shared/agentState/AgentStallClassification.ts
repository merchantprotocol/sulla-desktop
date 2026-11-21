// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Live agent state contract shared by the main process (AgentStateService)
 * and the renderer (Live Agents, sub-agent drawer). Types only: no runtime

/** Unknown liveness is not proof of failure, but it cannot explain prolonged silence. */
export class AgentStallClassification {
  static isStalled(state: string, runtimeAlive: boolean | null | undefined): boolean {
    return state === 'quiet' && runtimeAlive !== true;
  }
}
