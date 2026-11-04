// SPDX-License-Identifier: GPL-2.0-or-later
import type { InjectionKey } from 'vue';
import type { AgentStateClient } from './AgentStateClient';
export const AGENT_STATE_CLIENT_KEY: InjectionKey<AgentStateClient> = Symbol('AgentStateClient');
