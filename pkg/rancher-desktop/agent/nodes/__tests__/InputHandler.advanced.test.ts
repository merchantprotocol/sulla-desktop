/**
 * Advanced Test for InputHandler - Real Service Integration
 * Testing actual InputHandler with real ConversationSummaryService and ObservationalSummaryService
 */

import { InputHandlerNode } from '../InputHandlerNode';
import { ConversationSummaryService } from '../../services/ConversationSummaryService';
import { ObservationalSummaryService } from '../../services/ObservationalSummaryService';
import type { BaseThreadState } from '../Graph';
import type { ChatMessage } from '../../languagemodels/BaseLanguageModel';

// Mock SullaSettingsModel to avoid database dependencies for now
jest.mock('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    getSetting: jest.fn((key: string, defaultValue: any) => {
      // Return realistic default values for InputHandler settings
      const defaults: Record<string, any> = {
        'inputHandler.maxMessages':          85,
        'inputHandler.summaryPercent':       0.6,
        'inputHandler.tokenBudget':          25000,
        'inputHandler.rateLimitWindow':      60000,
        'inputHandler.maxRequestsPerWindow': 10,
      };
      return Promise.resolve(defaults[key] || defaultValue);
    }),
    setSetting: jest.fn(() => Promise.resolve()),
  },
}));

// Use real services but mock their external dependencies
jest.mock('../../database/RedisClient', () => ({
  redisClient: {
    get:  jest.fn(() => Promise.resolve(null)),
    set:  jest.fn(() => Promise.resolve()),
    hget: jest.fn(() => Promise.resolve(null)),
    hset: jest.fn(() => Promise.resolve()),
    del:  jest.fn(() => Promise.resolve(1)),
  },
}));

// Mock any language model dependencies that the services might need
// We'll let the real services handle their own language model interactions

describe('InputHandler Advanced Tests - Real Service Integration', () => {
  test('should integrate with real ConversationSummaryService for background summarization', async() => {
    const inputHandler = new InputHandlerNode();

    // Create a realistic large conversation that should trigger summarization
    const largeConversation: ChatMessage[] = [];

    // Add system message
    largeConversation.push({ role: 'system', content: 'You are a helpful AI assistant.' });

    // Add 90 realistic messages to exceed the 85-message threshold
    for (let i = 0; i < 90; i++) {
      largeConversation.push(
        { role: 'user', content: `User message ${ i + 1 }: This is a realistic user question about various topics.` },
        { role: 'assistant', content: `Assistant response ${ i + 1 }: Here's a helpful response to the user's question.` },
      );
    }

    const state: any = {
      messages: largeConversation,
      metadata: {
        action:               'direct_answer',
        threadId:             'advanced_test_thread',
        wsChannel:            'test',
        llmModel:             'claude-3-haiku',
        llmLocal:             false,
        cycleComplete:        false,
        waitingForUser:       false,
        options:              {},
        currentNodeId:        'input_handler',
        consecutiveSameNode:  0,
        iterations:           0,
        revisionCount:        0,
        maxIterationsReached: false,
        memory:               {
          knowledgeBaseContext: '',
          chatSummariesContext: '',
        },
        subGraph: {
          state:    'completed',
          name:     'hierarchical',
          prompt:   '',
          response: '',
        },
        finalSummary: '',
        finalState:   'running',
        returnTo:     null,
      },
    };

    // Execute InputHandler - should trigger real ConversationSummaryService
    const result = await inputHandler.execute(state);

    // Should complete successfully
    expect(result.decision.type).toBe('next');

    // Check that input handler diagnostics show large conversation was processed
    const metadata = result.state.metadata as any;
    expect(metadata.inputHandler).toBeDefined();
    expect(metadata.inputHandler.diagnostics.messageCount).toBe(181); // 1 system + 180 user/assistant
    expect(metadata.inputHandler.diagnostics.largeConversationDetected).toBe(true);
    expect(metadata.inputHandler.diagnostics.backgroundSummarizationTriggered).toBe(true);
  });

  test('should integrate with real ObservationalSummaryService for background trimming', async() => {
    const inputHandler = new InputHandlerNode();

    // Create conversation with user input that should trigger background trimming
    const state: any = {
      messages: [
        { role: 'system', content: 'You are a helpful AI assistant.' },
        { role: 'user', content: 'This is a user message that should trigger background observational trimming.' },
      ],
      metadata: {
        action:               'direct_answer',
        threadId:             'trimming_test_thread',
        wsChannel:            'test',
        llmModel:             'claude-3-haiku',
        llmLocal:             false,
        cycleComplete:        false,
        waitingForUser:       false,
        options:              {},
        currentNodeId:        'input_handler',
        consecutiveSameNode:  0,
        iterations:           0,
        revisionCount:        0,
        maxIterationsReached: false,
        memory:               {
          knowledgeBaseContext: '',
          chatSummariesContext: '',
        },
        subGraph: {
          state:    'completed',
          name:     'hierarchical',
          prompt:   '',
          response: '',
        },
        finalSummary: '',
        finalState:   'running',
        returnTo:     null,
      },
    };

    // Execute InputHandler - should trigger real ObservationalSummaryService
    const result = await inputHandler.execute(state);

    // Should complete successfully
    expect(result.decision.type).toBe('next');

    // Check that background trimming was triggered
    const metadata = result.state.metadata as any;
    expect(metadata.inputHandler).toBeDefined();
    expect(metadata.inputHandler.diagnostics.backgroundTrimmingTriggered).toBe(true);
  });

  test('should handle real service failures gracefully', async() => {
    const inputHandler = new InputHandlerNode();

    // Mock ConversationSummaryService to throw an error
    const originalTrigger = ConversationSummaryService.triggerBackgroundSummarization;
    ConversationSummaryService.triggerBackgroundSummarization = jest.fn().mockRejectedValue(
      new Error('ConversationSummaryService is temporarily unavailable'),
    );

    // Create large conversation that would normally trigger summarization
    const largeConversation: ChatMessage[] = [];
    for (let i = 0; i < 90; i++) {
      largeConversation.push(
        { role: 'user', content: `Message ${ i }` },
        { role: 'assistant', content: `Response ${ i }` },
      );
    }

    const state: any = {
      messages: largeConversation,
      metadata: {
        action:               'direct_answer',
        threadId:             'service_failure_test',
        wsChannel:            'test',
        llmModel:             'claude-3-haiku',
        llmLocal:             false,
        cycleComplete:        false,
        waitingForUser:       false,
        options:              {},
        currentNodeId:        'input_handler',
        consecutiveSameNode:  0,
        iterations:           0,
        revisionCount:        0,
        maxIterationsReached: false,
        memory:               {
          knowledgeBaseContext: '',
          chatSummariesContext: '',
        },
        subGraph: {
          state:    'completed',
          name:     'hierarchical',
          prompt:   '',
          response: '',
        },
        finalSummary: '',
        finalState:   'running',
        returnTo:     null,
      },
    };

    // Execute - should handle service failure gracefully
    const result = await inputHandler.execute(state);

    // Should still complete successfully despite service failure
    expect(result.decision.type).toBe('next');

    // Should have attempted to trigger summarization but handled failure
    const metadata = result.state.metadata as any;
    expect(metadata.inputHandler).toBeDefined();
    expect(metadata.inputHandler.diagnostics.backgroundSummarizationTriggered).toBe(true);

    // Restore original method
    ConversationSummaryService.triggerBackgroundSummarization = originalTrigger;
  });
});

console.log('🔥 ADVANCED INPUT HANDLER TEST - Real service integration');
