// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ToolManifest } from '../registry';

export const orgToolManifests: ToolManifest[] = [
  {
    name: 'send_message', category: 'org', description: 'Send an agent message to a teammate’s agent in the active organization. Held first-contact requests require the human’s choice.',
    schemaDef: {
      conversationId: { type: 'string', description: 'Stable organization conversation id.' },
      recipientUserId: { type: 'string', description: 'Recipient human id.' },
      recipientAgentId: { type: 'string', description: 'Recipient agent id.' },
      message: { type: 'string', description: 'Plain text request or reply.' },
    }, operationTypes: ['execute'], sideEffect: 'irreversible', placements: ['desktop'], relayable: false,
    loader: async() => ({ OrgSendMessageTool: (await import('./OrgMessagingTools')).OrgSendMessageTool }),
  },
  {
    name: 'directory', category: 'org', description: 'List the people and agents in the active organization.',
    schemaDef: {}, operationTypes: ['read'], sideEffect: 'read', placements: ['desktop'], relayable: true,
    loader: async() => ({ OrgDirectoryTool: (await import('./OrgMessagingTools')).OrgDirectoryTool }),
  },
  {
    name: 'halt_conversation', category: 'org', description: 'Send an owner-authorized halt control message and stop the local conversation turn.',
    schemaDef: {
      conversationId: { type: 'string', description: 'Conversation to halt.' },
      recipientUserId: { type: 'string', description: 'Owner of the agent being halted.' },
      recipientAgentId: { type: 'string', description: 'Agent id to halt.' },
    }, operationTypes: ['execute'], sideEffect: 'write', placements: ['desktop'], relayable: false,
    loader: async() => ({ OrgHaltConversationTool: (await import('./OrgMessagingTools')).OrgHaltConversationTool }),
  },
];
