import type Redis from 'ioredis';

import { redisClient } from '../database/RedisClient';

import { getWebSocketClientService } from './WebSocketClientService';

const CHANNEL = 'sulla:workflow:events';

export class WorkflowContainerEventBridge {
  private subscriber: Redis | null = null;

  async initialize(): Promise<void> {
    if (this.subscriber) return;
    await redisClient.initialize();
    this.subscriber = redisClient.getClient().duplicate();
    this.subscriber.on('message', (_channel, message) => {
      try {
        const data = JSON.parse(message);
        getWebSocketClientService().send('sulla-desktop', {
          type: 'workflow_execution_event',
          data,
          timestamp: Date.now(),
        });
      } catch (error) {
        console.warn('[WorkflowContainerEventBridge] Invalid workflow event:', error);
      }
    });
    await this.subscriber.subscribe(CHANNEL);
    console.log(`[WorkflowContainerEventBridge] Subscribed to ${ CHANNEL }`);
  }

  async shutdown(): Promise<void> {
    if (!this.subscriber) return;
    await this.subscriber.unsubscribe(CHANNEL);
    this.subscriber.disconnect();
    this.subscriber = null;
  }
}

let instance: WorkflowContainerEventBridge | null = null;
export function getWorkflowContainerEventBridge(): WorkflowContainerEventBridge {
  instance ??= new WorkflowContainerEventBridge();
  return instance;
}
