// EditorChatTabsInterface.ts — Manages multiple chat tabs for the workbench
// Each tab has its own EditorChatInterface with isolated messages and thread
import { ref, computed, watch } from 'vue';
import { EditorChatInterface } from './EditorChatInterface';
import type { WorkflowExecutionEventHandler } from './EditorChatInterface';

const TABS_STORAGE_KEY = 'chat_tabs_workbench';
const MAX_TABS = 10;

export interface ChatTabInfo {
  id: string;
  label: string;
  messageCount: number;
  isActive: boolean;
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

export class EditorChatTabsInterface {
  // Tab metadata (reactive)
  private tabData = ref<TabData[]>([]);
  private activeTabId = ref<string>('');
  
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
  
  readonly activeInterface = computed<EditorChatInterface | null>(() => {
    const id = this.activeTabId.value;
    return id ? this.interfaces.get(id) || null : null;
  });

  constructor() {
    this.restoreTabs();

    // Watch for changes and persist tab metadata
    watch(
      () => this.tabData.value.map(t => ({ id: t.id, label: t.label })),
      () => this.persistTabs(),
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
    const tabLabel = label || `Chat ${this.tabData.value.length + 1}`;
    
    // Create a new EditorChatInterface with a unique channel for this tab
    const chatInterface = new EditorChatInterface(id);
    
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
   * Rename a tab
   */
  renameTab(tabId: string, newLabel: string): boolean {
    const tab = this.tabData.value.find(t => t.id === tabId);
    if (!tab) return false;
    
    tab.label = newLabel;
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
      if (!raw) {
        // Create default tab if no saved state
        this.createTab('Chat');
        return;
      }
      
      const parsed: StoredTabsState = JSON.parse(raw);
      const savedTabs: TabData[] = parsed.tabs || [];
      
      if (savedTabs.length === 0) {
        this.createTab('Chat');
        return;
      }
      
      // Restore each tab by creating new interfaces
      for (const data of savedTabs) {
        const chatInterface = new EditorChatInterface(data.id);
        this.interfaces.set(data.id, chatInterface);
        
        this.tabData.value.push({
          id: data.id,
          label: data.label,
          createdAt: data.createdAt,
        });
      }
      
      // Restore active tab or default to first
      const validActiveId = this.interfaces.has(parsed.activeTabId) ? parsed.activeTabId : null;
      this.activeTabId.value = validActiveId || this.tabData.value[0]?.id || '';
      
      console.log(`[EditorChatTabsInterface] Restored ${this.tabData.value.length} tabs`);
    } catch (err) {
      console.error('[EditorChatTabsInterface] Failed to restore tabs:', err);
      // Create default tab on error
      this.createTab('Chat');
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
