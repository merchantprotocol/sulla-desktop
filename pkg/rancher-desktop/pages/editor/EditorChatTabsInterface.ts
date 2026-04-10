// EditorChatTabsInterface.ts — Manages multiple chat tabs for the workbench
// Each tab has its own EditorChatInterface with isolated messages and thread
import { ref, computed, watch } from 'vue';
import { EditorChatInterface } from './EditorChatInterface';
import type { WorkflowExecutionEventHandler } from './EditorChatInterface';

const TABS_STORAGE_KEY = 'chat_tabs_workbench';
const CHAT_HISTORY_KEY = 'chat_history_workbench';
const MAX_TABS = 10;
const MAX_HISTORY_ITEMS = 50;

export interface ChatTabInfo {
  id: string;
  label: string;
  messageCount: number;
  isActive: boolean;
}

export interface ChatHistoryItem {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  lastMessageAt: number;
  createdAt: number;
}

interface TabData {
  id: string;
  label: string;
  createdAt: number;
}

interface StoredTabsState {
  tabs: TabData[];
  activeTabId: string;
}

interface StoredHistoryState {
  items: ChatHistoryItem[];
}

export class EditorChatTabsInterface {
  // Tab metadata (reactive)
  private tabData = ref<TabData[]>([]);
  private activeTabId = ref<string>('');
  
  // Track which tabs have been auto-named to avoid overwriting manual renames
  private autoNamedTabs = new Set<string>();
  
  // Chat history (reactive)
  private chatHistory = ref<ChatHistoryItem[]>([]);
  
  // Interface instances (not reactive - stored in a Map)
  private interfaces = new Map<string, EditorChatInterface>();

  readonly activeTabIdComputed = computed(() => this.activeTabId.value);
  
  readonly allTabs = computed<ChatTabInfo[]>(() => 
    this.tabData.value.map(t => ({
      id: t.id,
      label: t.label,
      messageCount: this.interfaces.get(t.id)?.messages.value.length || 0,
      isActive: t.id === this.activeTabId.value,
    }))
  );

  readonly hasTabs = computed(() => this.tabData.value.length > 0);
  
  // Expose chat history as readonly computed
  readonly history = computed<ChatHistoryItem[]>(() => this.chatHistory.value);
  
  /**
   * Generate a short title from the first user message
   * Similar to Windsurf: uses the first few words of the conversation
   */
  private generateTabTitle(firstMessage: string): string {
    // Remove extra whitespace and normalize
    const normalized = firstMessage.trim().replace(/\s+/g, ' ');
    
    // Extract first 3-4 words or up to 25 chars
    const words = normalized.split(' ');
    let title = '';
    
    for (const word of words.slice(0, 4)) {
      if ((title + word).length > 25) break;
      title += (title ? ' ' : '') + word;
    }
    
    // If title is too short but message is long, take first 25 chars
    if (title.length < 10 && normalized.length > 25) {
      title = normalized.slice(0, 25).trim();
    }
    
    // Add ellipsis if truncated
    if (normalized.length > title.length) {
      title += '...';
    }
    
    // Fallback for empty or very short messages
    if (title.length < 3) {
      title = 'New Chat';
    }
    
    return title;
  }

  /**
   * Setup auto-naming watcher for a tab based on its messages
   * Updates tab name when context changes (new user message)
   */
  private setupAutoNaming(tabId: string, chatInterface: EditorChatInterface): void {
    // Watch for changes in messages - update tab name on every new user message
    watch(
      () => chatInterface.messages.value.length,
      (newLength, oldLength) => {
        // Only proceed if we have messages and it's a new message (not restore)
        if (newLength > 0 && (!oldLength || newLength > oldLength)) {
          // Skip if tab was manually renamed
          if (this.autoNamedTabs.has(tabId)) return;
          
          // Get the most recent user message to reflect current context
          const userMessages = chatInterface.messages.value.filter(m => m.role === 'user');
          const latestUserMessage = userMessages[userMessages.length - 1];
          
          if (latestUserMessage?.content) {
            const newTitle = this.generateTabTitle(latestUserMessage.content);
            this.renameTab(tabId, newTitle);
            // Don't add to autoNamedTabs - we want to keep updating on context changes
          }
        }
      },
      { immediate: true }
    );
  }
  
  readonly activeInterface = computed<EditorChatInterface | null>(() => {
    const id = this.activeTabId.value;
    return id ? this.interfaces.get(id) || null : null;
  });

  constructor() {
    this.restoreTabs();
    this.restoreHistory();

    // Watch for changes and persist tab metadata
    watch(
      () => this.tabData.value.map(t => ({ id: t.id, label: t.label })),
      () => this.persistTabs(),
      { deep: true }
    );

    // Watch for changes and persist history
    watch(
      () => this.chatHistory.value,
      () => this.persistHistory(),
      { deep: true }
    );
  }

  /**
   * Create a new chat tab
   */
  createTab(label?: string): EditorChatInterface {
    if (this.tabData.value.length >= MAX_TABS) {
      console.warn('[EditorChatTabsInterface] Max tabs reached');
      return this.activeInterface.value!;
    }

    const id = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tabLabel = label || 'New Chat';
    
    // Create a new EditorChatInterface with a unique channel for this tab
    const chatInterface = new EditorChatInterface(id);
    
    // Setup auto-naming based on first user message
    this.setupAutoNaming(id, chatInterface);
    
    // Store the interface
    this.interfaces.set(id, chatInterface);
    
    // Store tab metadata
    this.tabData.value.push({
      id,
      label: tabLabel,
      createdAt: Date.now(),
    });
    
    this.activeTabId.value = id;
    
    console.log(`[EditorChatTabsInterface] Created tab: ${id} (${tabLabel})`);
    this.persistTabs();
    
    return chatInterface;
  }

  /**
   * Switch to an existing tab
   */
  switchTab(tabId: string): boolean {
    const tab = this.tabData.value.find(t => t.id === tabId);
    if (!tab) return false;
    
    this.activeTabId.value = tabId;
    console.log(`[EditorChatTabsInterface] Switched to tab: ${tabId}`);
    this.persistTabs();
    return true;
  }

  /**
   * Close a tab
   */
  closeTab(tabId: string): boolean {
    const index = this.tabData.value.findIndex(t => t.id === tabId);
    if (index === -1) return false;
    
    const chatInterface = this.interfaces.get(tabId);
    if (chatInterface) {
      chatInterface.dispose();
      this.interfaces.delete(tabId);
    }
    
    // Remove from tab data
    this.tabData.value.splice(index, 1);
    
    // Clear persisted data for this tab
    this.clearTabStorage(tabId);
    
    // Update active tab if we closed the active one
    if (this.activeTabId.value === tabId) {
      if (this.tabData.value.length > 0) {
        this.activeTabId.value = this.tabData.value[Math.min(index, this.tabData.value.length - 1)].id;
      } else {
        this.activeTabId.value = '';
      }
    }
    
    console.log(`[EditorChatTabsInterface] Closed tab: ${tabId}`);
    this.persistTabs();
    
    return true;
  }

  /**
   * Rename a tab (marks as manually named so auto-naming won't overwrite)
   */
  renameTab(tabId: string, newLabel: string): boolean {
    const tab = this.tabData.value.find(t => t.id === tabId);
    if (!tab) return false;
    
    tab.label = newLabel;
    this.autoNamedTabs.add(tabId); // Mark as manually named
    this.persistTabs();
    return true;
  }

  /**
   * Register a workflow event handler on all tabs
   */
  onWorkflowEvent(handler: WorkflowExecutionEventHandler): void {
    this.interfaces.forEach(chatInterface => {
      chatInterface.onWorkflowEvent(handler);
    });
  }

  /**
   * Persist tab metadata to localStorage
   */
  private persistTabs(): void {
    try {
      const state: StoredTabsState = {
        tabs: this.tabData.value,
        activeTabId: this.activeTabId.value,
      };
      localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(state));
    } catch { /* ignore storage errors */ }
  }

  /**
   * Restore tabs from localStorage
   */
  private restoreTabs(): void {
    try {
      const raw = localStorage.getItem(TABS_STORAGE_KEY);
      console.log(`[EditorChatTabsInterface] restoreTabs - TABS_STORAGE_KEY has data: ${!!raw}`);
      if (!raw) {
        // Create default tab if no saved state
        console.log('[EditorChatTabsInterface] No saved tabs, creating default tab');
        this.createTab('New Chat');
        return;
      }

      const parsed: StoredTabsState = JSON.parse(raw);
      const savedTabs: TabData[] = parsed.tabs || [];
      console.log(`[EditorChatTabsInterface] Found ${savedTabs.length} saved tabs:`, savedTabs.map(t => t.id));

      if (savedTabs.length === 0) {
        this.createTab('New Chat');
        return;
      }

      // Restore each tab by creating new interfaces
      for (const data of savedTabs) {
        console.log(`[EditorChatTabsInterface] Restoring tab ${data.id}...`);
        const chatInterface = new EditorChatInterface(data.id);
        this.interfaces.set(data.id, chatInterface);
        console.log(`[EditorChatTabsInterface] Tab ${data.id} restored with ${chatInterface.messages.value.length} messages`);

        // Mark as auto-named if it has messages (to prevent re-naming)
        if (chatInterface.messages.value.length > 0) {
          this.autoNamedTabs.add(data.id);
        }

        // Setup auto-naming watcher for restored tabs (in case they have no messages yet)
        this.setupAutoNaming(data.id, chatInterface);

        this.tabData.value.push({
          id: data.id,
          label: data.label,
          createdAt: data.createdAt,
        });
      }

      // Restore active tab or default to first
      const validActiveId = this.interfaces.has(parsed.activeTabId) ? parsed.activeTabId : null;
      this.activeTabId.value = validActiveId || this.tabData.value[0]?.id || '';

      console.log(`[EditorChatTabsInterface] Restored ${this.tabData.value.length} tabs, active: ${this.activeTabId.value}`);
    } catch (err) {
      console.error('[EditorChatTabsInterface] Failed to restore tabs:', err);
      // Create default tab on error
      this.createTab('New Chat');
    }
  }

  /**
   * Clear localStorage for a specific tab
   */
  private clearTabStorage(tabId: string): void {
    try {
      // Clear messages storage for this tab
      localStorage.removeItem(`chat_messages_${tabId}`);
      localStorage.removeItem(`chat_thread_${tabId}`);
    } catch { /* ignore */ }
  }

  /**
   * Persist chat history to localStorage
   */
  private persistHistory(): void {
    try {
      const state: StoredHistoryState = {
        items: this.chatHistory.value,
      };
      localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(state));
    } catch { /* ignore storage errors */ }
  }

  /**
   * Restore chat history from localStorage
   */
  private restoreHistory(): void {
    try {
      const raw = localStorage.getItem(CHAT_HISTORY_KEY);
      if (!raw) return;
      
      const parsed: StoredHistoryState = JSON.parse(raw);
      const savedItems: ChatHistoryItem[] = parsed.items || [];
      
      // Sort by last message date (newest first)
      savedItems.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      
      this.chatHistory.value = savedItems.slice(0, MAX_HISTORY_ITEMS);
      console.log(`[EditorChatTabsInterface] Restored ${this.chatHistory.value.length} history items`);
    } catch (err) {
      console.error('[EditorChatTabsInterface] Failed to restore history:', err);
    }
  }

  /**
   * Add current tab to history when closing or archiving
   */
  addToHistory(tabId: string): boolean {
    const tab = this.tabData.value.find(t => t.id === tabId);
    const chatInterface = this.interfaces.get(tabId);
    if (!tab || !chatInterface) return false;

    const messages = chatInterface.messages.value;
    if (messages.length === 0) return false; // Don't save empty chats

    // Get first user message for preview
    const firstUserMessage = messages.find(m => m.role === 'user');
    const lastMessage = messages[messages.length - 1];

    const historyItem: ChatHistoryItem = {
      id: tabId,
      title: tab.label,
      preview: firstUserMessage?.content?.slice(0, 100) || 'Chat session',
      messageCount: messages.length,
      lastMessageAt: Date.now(),
      createdAt: tab.createdAt,
    };

    // Remove existing item with same ID if present
    const existingIndex = this.chatHistory.value.findIndex(h => h.id === tabId);
    if (existingIndex !== -1) {
      this.chatHistory.value.splice(existingIndex, 1);
    }

    // Add to beginning (newest first)
    this.chatHistory.value.unshift(historyItem);

    // Keep only max items
    if (this.chatHistory.value.length > MAX_HISTORY_ITEMS) {
      this.chatHistory.value = this.chatHistory.value.slice(0, MAX_HISTORY_ITEMS);
    }

    // Copy messages to history-specific storage so they survive tab close
    this.persistHistoryMessages(tabId, messages);

    console.log(`[EditorChatTabsInterface] Added tab ${tabId} to history`);
    return true;
  }

  /**
   * Persist messages to history-specific storage key
   */
  private persistHistoryMessages(tabId: string, messages: ChatMessage[]): void {
    try {
      const MAX_PERSISTED_MESSAGES = 200;
      // Strip image dataUrls and truncate large HTML to avoid blowing localStorage limits
      const toStore = messages.slice(-MAX_PERSISTED_MESSAGES).map((m) => {
        if (m.image) {
          return { ...m, image: { ...m.image, dataUrl: '' } };
        }
        if (m.kind === 'html' && m.content.length > 50_000) {
          return { ...m, content: '[HTML content too large to persist]' };
        }
        return m;
      });
      localStorage.setItem(`chat_history_messages_${tabId}`, JSON.stringify(toStore));
    } catch { /* storage full — silently degrade */ }
  }

  /**
   * Restore messages from history-specific storage key
   */
  private restoreHistoryMessages(tabId: string): ChatMessage[] | null {
    try {
      const raw = localStorage.getItem(`chat_history_messages_${tabId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ChatMessage[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Mark any stale running tool cards as failed
        for (const m of parsed) {
          if (m.toolCard && m.toolCard.status === 'running') {
            m.toolCard.status = 'failed';
            m.toolCard.error = 'Interrupted';
          }
        }
        return parsed;
      }
    } catch { /* corrupt data */ }
    return null;
  }

  /**
   * Load a history item into a new tab
   */
  loadHistoryIntoTab(historyId: string): EditorChatInterface | null {
    const historyItem = this.chatHistory.value.find(h => h.id === historyId);
    if (!historyItem) return null;

    // Check if tab already exists (restored from storage)
    const existingInterface = this.interfaces.get(historyId);
    if (existingInterface) {
      // Switch to existing tab
      this.switchTab(historyId);
      return existingInterface;
    }

    // Create new tab with history ID to load its messages
    if (this.tabData.value.length >= MAX_TABS) {
      console.warn('[EditorChatTabsInterface] Max tabs reached, cannot load history');
      return null;
    }

    // Create interface which will auto-restore messages from storage
    const chatInterface = new EditorChatInterface(historyId);
    
    // Restore messages from history-specific storage if the regular storage was cleared
    const historyMessages = this.restoreHistoryMessages(historyId);
    if (historyMessages && historyMessages.length > 0 && chatInterface.messages.value.length === 0) {
      // Need to access the persona's messages directly since they're protected
      const persona = (chatInterface as any).persona;
      if (persona && persona.messages.length === 0) {
        persona.messages.push(...historyMessages);
        console.log(`[EditorChatTabsInterface] Restored ${historyMessages.length} messages from history storage`);
      }
    }
    
    // Setup auto-naming
    this.setupAutoNaming(historyId, chatInterface);
    
    // Store the interface
    this.interfaces.set(historyId, chatInterface);
    
    // Store tab metadata
    this.tabData.value.push({
      id: historyId,
      label: historyItem.title,
      createdAt: historyItem.createdAt,
    });
    
    this.activeTabId.value = historyId;
    this.autoNamedTabs.add(historyId); // Mark as named
    
    console.log(`[EditorChatTabsInterface] Loaded history ${historyId} into new tab`);
    this.persistTabs();
    
    return chatInterface;
  }

  /**
   * Remove an item from history
   */
  removeFromHistory(historyId: string): boolean {
    const index = this.chatHistory.value.findIndex(h => h.id === historyId);
    if (index === -1) return false;
    
    this.chatHistory.value.splice(index, 1);
    
    // Also clear the message storage for this history item
    try {
      localStorage.removeItem(`chat_messages_${historyId}`);
      localStorage.removeItem(`chat_thread_${historyId}`);
      localStorage.removeItem(`chat_history_messages_${historyId}`); // History-specific storage
    } catch { /* ignore */ }
    
    console.log(`[EditorChatTabsInterface] Removed history item ${historyId}`);
    return true;
  }

  /**
   * Clear all history
   */
  clearHistory(): void {
    // Clear all message storage for history items
    for (const item of this.chatHistory.value) {
      try {
        localStorage.removeItem(`chat_messages_${item.id}`);
        localStorage.removeItem(`chat_thread_${item.id}`);
        localStorage.removeItem(`chat_history_messages_${item.id}`); // History-specific storage
      } catch { /* ignore */ }
    }
    
    this.chatHistory.value = [];
    console.log('[EditorChatTabsInterface] Cleared all history');
  }

  /**
   * Dispose all tabs
   */
  dispose(): void {
    this.interfaces.forEach(chatInterface => chatInterface.dispose());
    this.interfaces.clear();
  }
}

/**
 * Factory function to create a reactive tabs interface
 */
export function createEditorChatTabsInterface(): EditorChatTabsInterface {
  return new EditorChatTabsInterface();
}
