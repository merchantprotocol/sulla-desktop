import type { ToolManifest } from '../registry';

export const bridgeToolManifests: ToolManifest[] = [
  {
    name:        'send_channel_message',
    description: 'Send a message to any WebSocket channel and wait up to 5 seconds for a reply. If the receiver responds in time, the reply is returned inline. Otherwise a "no reply" result is returned and any late reply will arrive on your channel as an incoming message. Every agent runs on a channel (e.g. "sulla-desktop" for the frontend, "heartbeat" for the heartbeat). Your sender identity is auto-populated from your channel state.',
    category:    'bridge',
    schemaDef:   {
      target_channel: { type: 'string', description: 'The target WebSocket channel to send to (e.g. "sulla-desktop", "heartbeat", "workbook").' },
      message:        { type: 'string', description: 'The message content to send. Supports markdown.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./send_channel_message'),
  },
  {
    name:        'update_human_presence',
    description: 'Update the human presence state in Redis. Call this to inform other agents about what the human is currently viewing, doing, or whether they are available.',
    category:    'bridge',
    schemaDef:   {
      available:        { type: 'boolean', optional: true, default: true, description: 'Whether the human is currently available for interaction.' },
      current_view:     { type: 'string', optional: true, description: 'What the human is currently viewing (e.g., "Agent Chat", "Settings", "Integrations", "Extensions").' },
      current_activity: { type: 'string', optional: true, description: 'What the human is currently doing (e.g., "chatting with agent", "configuring integrations", "idle").' },
      active_channel:   { type: 'string', optional: true, description: 'The channel the human is currently listening on.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./update_human_presence'),
  },
  {
    name:           'get_human_presence',
    description:    'Read the current human presence state from Redis. Returns whether the human is available, what they are viewing, their activity, and how long since they were last seen.',
    category:       'bridge',
    schemaDef:      {},
    operationTypes: ['read'],
    loader:         () => import('./get_human_presence'),
  },
  {
    name:        'emit_html_message',
    description: 'Send rich HTML content with embedded CSS and JavaScript to the chat UI. The HTML is rendered inside an isolated Shadow DOM container. Use this when the response benefits from interactive elements, charts, dashboards, styled tables, forms, or any rich formatting that markdown cannot express. Include all CSS in <style> tags and JavaScript in <script> tags within the content.',
    category:    'bridge',
    schemaDef:   {
      content: { type: 'string', description: 'Full HTML content including <style> and <script> tags. Rendered in an isolated Shadow DOM container.' },
      title:   { type: 'string', optional: true, description: 'Optional brief label describing the HTML content.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./emit_html_message'),
  },
];
