// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentStateClient } from './AgentStateClient';
import type { InjectionKey } from 'vue';
export const AGENT_STATE_CLIENT_KEY: InjectionKey<AgentStateClient> = Symbol('AgentStateClient');
