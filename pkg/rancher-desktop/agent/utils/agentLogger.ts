/**
 * Topic-based loggers for the agent / chat / WebSocket subsystem.
 *
 * Thin re-export layer over SullaLogger.topic() — each named export is a
 * console-compatible logger that writes to ~/sulla/logs/{topic}.log.
 *
 * Usage — drop-in replacement for `console`:
 *
 *   import { wsLogger as console } from '@pkg/agent/utils/agentLogger';
 *   console.log('works like before, but persisted to disk');
 */

import { SullaLogger } from '../services/SullaLogger';

/** WebSocket connection lifecycle, reconnects, heartbeat, message queue */
export const wsLogger = SullaLogger.topic('websocket');

/** Chat interface — user message sends, localStorage restore, stop signals */
export const chatLogger = SullaLogger.topic('chat');

/** FrontendGraphWebSocketService — message routing, graph execution */
export const frontendGraphLogger = SullaLogger.topic('frontend-graph');

/** AgentPersonaModel — persona subscriptions, message delivery */
export const personaLogger = SullaLogger.topic('persona');

/** MessageDispatcher — message validation, dispatch, asset lifecycle */
export const dispatchLogger = SullaLogger.topic('dispatcher');
