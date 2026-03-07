<template>
  <div class="h-screen overflow-hidden font-sans flex flex-col page-root" :class="{ dark: isDark }">
    <PostHogTracker page-name="AgentFilesystem" />
    <EditorHeader
      :is-dark="isDark"
      :toggle-theme="toggleTheme"
      :left-pane-visible="leftPaneVisible"
      :bottom-pane-visible="bottomPaneVisible"
      :right-pane-visible="rightPaneVisible"
      @toggle-left-pane="leftPaneVisible = !leftPaneVisible"
      @toggle-bottom-pane="bottomPaneVisible = !bottomPaneVisible"
      @toggle-right-pane="rightPaneVisible = !rightPaneVisible"
    />

    <div class="flex h-full min-h-0 overflow-hidden">
        <div class="main-content">
        <!-- Icon Panel -->
        <IconPanel
          :is-dark="isDark"
          :left-pane-visible="leftPaneVisible"
          :search-mode="searchMode"
          :git-mode="gitMode"
          :docker-mode="dockerMode"
          :agent-mode="agentMode"
          :integrations-mode="integrationsMode"
          :workflow-mode="workflowMode"
          @toggle-file-tree="toggleFileTree"
          @toggle-search="toggleSearch"
          @toggle-git="toggleGit"
          @toggle-docker="toggleDocker"
          @toggle-integrations="toggleIntegrations"
          @toggle-agent="toggleAgent"
          @toggle-workflow="toggleWorkflow"
        />
        </div>

        <!-- Left sidebar: File tree -->
        <div class="left-pane" v-show="leftPaneVisible" :class="{ dark: isDark }" :style="{ width: leftPaneWidth + 'px' }">
          <div class="file-tree-wrapper">
            <!-- Search -->
            <FileSearch
              v-show="searchMode"
              v-model="searchQuery"
              v-model:search-path="searchPath"
              :is-dark="isDark"
              :results="searchResults"
              :indexing="qmdIndexing"
              :searching="qmdSearching"
              @file-selected="onFileSelected"
              @close="leftPaneVisible = false"
            />

            <!-- Git pane -->
            <GitPane
              v-show="gitMode"
              :root-path="rootPath"
              :is-dark="isDark"
              @file-selected="onFileSelected"
              @open-diff="onOpenDiff"
              @close="leftPaneVisible = false"
            />

            <!-- Docker pane -->
            <DockerPane
              v-show="dockerMode"
              :is-dark="isDark"
              @open-container-port="openContainerPort"
              @docker-logs="openDockerLogs"
              @docker-exec="openDockerExec"
              @close="leftPaneVisible = false"
            />

            <!-- Agent pane -->
            <AgentPane
              ref="agentPaneRef"
              v-show="agentMode"
              :is-dark="isDark"
              @close="leftPaneVisible = false"
              @file-selected="onFileSelected"
              @open-new-agent-tab="onNewAgentTab"
              @edit-agent="onEditAgent"
            />

            <!-- Integrations pane -->
            <IntegrationsPane
              v-show="integrationsMode"
              :is-dark="isDark"
              @file-selected="onFileSelected"
              @open-api-test="openApiTest"
              @close="leftPaneVisible = false"
            />

            <!-- Workflow pane -->
            <WorkflowPane
              ref="workflowPaneRef"
              v-show="workflowMode"
              :is-dark="isDark"
              @close="leftPaneVisible = false"
              @workflow-activated="onWorkflowActivated"
              @workflow-closed="onWorkflowClosed"
              @workflow-created="onWorkflowCreated"
              @workflow-deleted="onWorkflowDeleted"
            />

            <!-- File tree -->
            <FileTreeSidebar
              ref="fileTreeRef"
              v-show="!searchMode && !gitMode && !dockerMode && !agentMode && !integrationsMode && !workflowMode"
              :root-path="rootPath"
              :highlight-path="highlightPath"
              :is-dark="isDark"
              @file-selected="onFileSelected"
              @close="leftPaneVisible = false"
            />
          </div>
        </div>

        <!-- Resize handle: left pane -->
        <div
          v-show="leftPaneVisible"
          class="resize-handle resize-handle-v"
          :class="{ dark: isDark }"
          @mousedown="startResize('left', $event)"
        ></div>

        <!-- Right content: Editor area -->
        <div class="editor-panel" v-show="centerPaneVisible" :class="{ dark: isDark }">
          <!-- Workflow canvas (replaces tabbed editor when workflow mode is active) -->
          <WorkflowEditor v-if="workflowMode" ref="workflowEditorRef" :is-dark="isDark" :workflow-data="activeWorkflowData" @node-selected="onWorkflowNodeSelected" @workflow-changed="onWorkflowChanged" />
          <!-- Workflow save toolbar -->
          <div v-if="workflowMode && activeWorkflowData" class="workflow-save-bar" :class="{ dark: isDark }">
            <span v-if="workflowSaveStatus === 'saving'" class="workflow-save-status saving">
              <svg class="workflow-save-spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              Saving…
            </span>
            <span v-else-if="workflowSaveStatus === 'saved'" class="workflow-save-status saved">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Saved
            </span>
            <span v-else-if="workflowSaveStatus === 'unsaved'" class="workflow-save-status unsaved">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
              Unsaved
            </span>
            <button class="workflow-save-btn" :class="{ dark: isDark }" title="Save workflow (⌘S)" @click="saveWorkflowNow">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
                <polyline points="7 3 7 8 15 8"/>
              </svg>
              Save
            </button>
            <button class="workflow-save-btn" :class="{ dark: isDark }" title="Workflow settings" @click="toggleWorkflowSettings">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
            <button
              class="workflow-enable-btn"
              :class="{ dark: isDark, enabled: activeWorkflowData?.enabled }"
              :title="activeWorkflowData?.enabled ? 'Disable workflow (live)' : 'Enable workflow (go live)'"
              @click="toggleWorkflowEnabled"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>
                <line x1="12" y1="2" x2="12" y2="12"/>
              </svg>
              {{ activeWorkflowData?.enabled ? 'Live' : 'Disabled' }}
            </button>
            <div class="workflow-save-divider" :class="{ dark: isDark }"></div>
            <button
              v-if="!workflowExecutionId"
              class="workflow-run-btn"
              :class="{ dark: isDark }"
              title="Run workflow"
              @click="runWorkflow"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              Run
            </button>
            <button
              v-else
              class="workflow-stop-btn"
              :class="{ dark: isDark }"
              title="Stop workflow"
              @click="stopWorkflow"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="6" y="6" width="12" height="12" rx="1"/>
              </svg>
              Stop
            </button>
          </div>

          <!-- Top editor area -->
          <div class="editor-top" v-show="!workflowMode">
            <!-- Tab bar (always visible) -->
            <div class="tab-bar" :class="{ dark: isDark, empty: openTabs.length === 0 }">
              <div class="tab-bar-tabs">
                <div
                  v-for="tab in openTabs"
                  :key="`${tab.path}-${tab.editorType || 'code'}`"
                  class="tab"
                  :class="{ active: activeTabKey === `${tab.path}-${tab.editorType || 'code'}`, dark: isDark }"
                  @click="switchTab(tab)"
                  @contextmenu.prevent="$emit('tab-context-menu', $event, tab)"
                >
                  <span class="tab-icon">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M3.5 1C2.94772 1 2.5 1.44772 2.5 2V14C2.5 14.5523 2.94772 15 3.5 15H12.5C13.0523 15 13.5 14.5523 13.5 14V5L9.5 1H3.5Z" :fill="getIconColor(tab.ext)" stroke-width="0.5" :stroke="getIconColor(tab.ext)"/>
                      <path d="M9.5 1V5H13.5" :stroke="getIconColor(tab.ext)" stroke-width="0.8" fill="none"/>
                    </svg>
                  </span>
                  <span class="tab-label">{{ tab.name }}{{ tab.editorType === 'diff' ? ' (diff)' : '' }}</span>
                  <span v-if="tab.dirty" class="tab-dirty-dot"></span>
                  <span class="tab-close" @click.stop="closeTab(tab)">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.707L8 8.707z"/>
                    </svg>
                  </span>
                </div>
              </div>
              <!-- Tab bar actions (right side) -->
              <div class="tab-bar-actions">
                <button class="tab-bar-action-btn" :class="{ dark: isDark }" title="More actions" @click.stop="editorMenu.visible = !editorMenu.visible">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="2"/>
                    <circle cx="12" cy="12" r="2"/>
                    <circle cx="12" cy="19" r="2"/>
                  </svg>
                </button>
              </div>
              <!-- Editor dropdown menu -->
              <div v-if="editorMenu.visible" ref="editorDropdownRef" class="editor-dropdown" :class="{ dark: isDark }">
                <button class="editor-dropdown-item" :class="{ dark: isDark }" @click="createNewUntitledTab">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="12" y1="18" x2="12" y2="12"/>
                    <line x1="9" y1="15" x2="15" y2="15"/>
                  </svg>
                  <span>New File</span>
                </button>
              </div>
            </div>

            <!-- Empty state (no tabs open) -->
            <div v-if="openTabs.length === 0" class="empty-state">
              <img :src="sullaMutedIconUrl" alt="Sulla" class="empty-icon-img">
              <p class="empty-text">Agent Workbench</p>
              <p class="empty-hint">an editor built for vibe coders</p>
            </div>

            <!-- Active tab content -->
            <template v-if="activeTab">
              <!-- Loading state -->
              <div v-if="activeTab?.loading" class="empty-state">
                <div class="loading-spinner"></div>
                <p class="empty-text">Loading {{ activeTab?.name }}…</p>
              </div>

              <!-- Error state -->
              <div v-else-if="activeTab?.error" class="empty-state">
                <p class="error-text">{{ activeTab?.error }}</p>
              </div>

              <!-- Editor content -->
              <template v-else>
                <!-- Breadcrumb and Save Button Row -->
                <div class="editor-header" :class="{ dark: isDark }">
                  <div class="breadcrumb-bar" :class="{ dark: isDark }">
                    <span
                      v-for="(segment, idx) in activeBreadcrumbs"
                      :key="idx"
                      class="breadcrumb-segment"
                    >
                      <span v-if="idx > 0" class="breadcrumb-sep">›</span>
                      {{ segment }}
                    </span>
                  </div>
                  <span v-if="agentMode && activeTab && !activeTab.loading" class="token-estimate" :class="{ dark: isDark }">
                    ~{{ estimatedTokens }} tokens
                  </span>
                  <button
                    v-if="activeTab?.dirty"
                    class="save-button"
                    :class="{ dark: isDark }"
                    @click="saveActiveTab"
                    :disabled="activeTab?.loading"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                      <polyline points="17,21 17,13 7,13 7,21"/>
                      <polyline points="7,3 7,8 15,8"/>
                    </svg>
                    Save
                  </button>
                </div>

                <!-- Editor content -->
                <div class="editor-content" @contextmenu="onEditorContextMenu">
                  <component
                    :is="activeEditorComponent"
                    :key="activeTab?.path || ''"
                    ref="editorRef"
                    :content="activeTab?.content || ''"
                    :original-content="activeTab?.originalContent || ''"
                    :file-path="activeTab?.path || ''"
                    :file-ext="activeTab?.ext || ''"
                    :is-dark="isDark"
                    :read-only="activeTab?.editorType === 'preview' || activeTab?.editorType === 'diff' || activeTab?.editorType === 'terminal'"
                    @dirty="markActiveTabDirty"
                    @saved="onAgentFormSaved"
                  />
                </div>

                <!-- Inject Variable context menu -->
                <Teleport to="body">
                  <div
                    v-if="injectMenu.visible"
                    class="inject-menu"
                    :class="{ dark: isDark }"
                    :style="{ top: injectMenu.y + 'px', left: injectMenu.x + 'px' }"
                    @contextmenu.prevent
                  >
                    <div class="inject-menu-header">Inject Variable</div>
                    <button
                      v-for="v in injectMenu.variables"
                      :key="v.key"
                      class="inject-menu-item"
                      :class="{ dark: isDark }"
                      @click="doInjectVariable(v.key)"
                    >
                      <span class="inject-var-label">{{ v.label }}</span>
                      <span class="inject-var-key">{{ v.key }}</span>
                    </button>
                  </div>
                </Teleport>
              </template>
            </template>
          </div>

          <!-- Resize handle: bottom pane -->
          <div
            v-show="bottomPaneVisible"
            class="resize-handle resize-handle-h"
            :class="{ dark: isDark }"
            @mousedown="startResize('bottom', $event)"
          ></div>

          <!-- Bottom center pane -->
          <div v-show="bottomPaneVisible" class="editor-bottom" :class="{ dark: isDark }" :style="{ height: bottomPaneHeight + 'px' }">
            <!-- Terminal tabs header -->
            <div class="terminal-tabs-header" :class="{ dark: isDark }">
              <div class="terminal-tabs">
                <div
                  v-for="tab in terminalTabs"
                  :key="tab.id"
                  class="terminal-tab"
                  :class="{ active: bottomPaneTab === 'terminal' && activeTerminalTab === tab.id, dark: isDark }"
                  @click="bottomPaneTab = 'terminal'; switchTerminalTab(tab.id)"
                >
                  <span>{{ tab.name }}</span>
                  <button
                    v-if="terminalTabs.length > 1"
                    class="terminal-tab-close"
                    :class="{ dark: isDark }"
                    @click.stop="closeTerminalTab(tab.id)"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                </div>
              </div>
              <!-- API Test tabs -->
              <div
                v-for="atab in apiTabs"
                :key="atab.id"
                class="terminal-tab"
                :class="{ active: bottomPaneTab === 'api' && activeApiTab === atab.id, dark: isDark }"
                @click="bottomPaneTab = 'api'; activeApiTab = atab.id"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 3px; flex-shrink: 0;">
                  <path d="M4 6h16M4 12h16M4 18h16"/>
                </svg>
                <span>API:{{ atab.slug }}</span>
                <button
                  class="terminal-tab-close"
                  :class="{ dark: isDark }"
                  @click.stop="closeApiTab(atab.id)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
              <button
                class="terminal-tab-add"
                :class="{ dark: isDark }"
                @click="createNewTerminalTab"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>
              <div style="flex:1"></div>
              <button class="pane-close-btn" :class="{ dark: isDark }" title="Close" @click="bottomPaneVisible = false">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            
            <!-- Terminal content -->
            <div v-show="bottomPaneTab === 'terminal'" class="terminal-content">
              <div
                v-for="tab in terminalTabs"
                :key="tab.id"
                v-show="activeTerminalTab === tab.id"
                class="terminal-pane"
              >
                <XTermTerminal :is-dark="isDark" :session-id="tab.sessionId" :command="tab.command || ''" :read-only="tab.readOnly || false" />
              </div>
            </div>

            <!-- API Test Panels -->
            <div v-show="bottomPaneTab === 'api'" class="terminal-content">
              <div
                v-for="atab in apiTabs"
                :key="atab.id"
                v-show="activeApiTab === atab.id"
                style="height: 100%"
              >
                <ApiTestPanel :is-dark="isDark" :initial-slug="atab.slug" />
              </div>
            </div>
          </div>
        </div>

        <!-- Resize handle: right pane -->
        <div
          v-show="rightPaneVisible"
          class="resize-handle resize-handle-v"
          :class="{ dark: isDark }"
          @mousedown="startResize('right', $event)"
        ></div>

        <!-- Right pane -->
        <div class="right-pane" v-show="rightPaneVisible" :class="{ dark: isDark }" :style="{ width: rightPaneWidth + 'px' }">
          <!-- Workflow settings panel -->
          <div v-if="workflowMode && workflowSettingsOpen && activeWorkflowData" class="workflow-settings-panel" :class="{ dark: isDark }">
            <div class="workflow-settings-header">
              <span class="workflow-settings-title">Workflow Settings</span>
              <button class="workflow-settings-close" @click="onWorkflowSettingsClose" title="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div class="workflow-settings-body">
              <label class="workflow-settings-label">Name</label>
              <input
                class="workflow-settings-input"
                :class="{ dark: isDark }"
                type="text"
                :value="activeWorkflowData.name"
                @input="onWorkflowNameUpdate(($event.target as HTMLInputElement).value)"
                placeholder="Workflow name"
              />
              <label class="workflow-settings-label">Description</label>
              <textarea
                class="workflow-settings-textarea"
                :class="{ dark: isDark }"
                :value="activeWorkflowData.description"
                @input="onWorkflowDescriptionUpdate(($event.target as HTMLTextAreaElement).value)"
                placeholder="Describe what this workflow does…"
                rows="4"
              />
              <div class="workflow-settings-danger-zone">
                <button
                  class="workflow-delete-btn"
                  :class="{ dark: isDark }"
                  @click="deleteActiveWorkflow"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                  Delete Workflow
                </button>
              </div>
            </div>
          </div>
          <!-- Workflow node properties panel -->
          <WorkflowNodePanel
            v-else-if="workflowMode && selectedWorkflowNode"
            :is-dark="isDark"
            :node="selectedWorkflowNode"
            :upstream-nodes="selectedNodeUpstream"
            @close="onWorkflowNodePanelClose"
            @update-label="onWorkflowNodeLabelUpdate"
            @update-trigger="() => {}"
            @update-node-config="onWorkflowNodeConfigUpdate"
          />
          <!-- Chat (default / workflow mode) -->
          <EditorChat
            v-else
            :is-dark="isDark"
            :messages="chatMessages"
            :query="chatQuery"
            :loading="chatLoading"
            :graph-running="chatGraphRunning || !!workflowExecutionId"
            :model-selector="modelSelector"
            :agent-registry="agentRegistry"
            :hide-agent-selector="workflowChatMode"
            :total-tokens-used="chatTotalTokensUsed"
            @update:query="chatUpdateQuery"
            @send="workflowChatMode ? workflowChatSend() : chatSend()"
            @stop="workflowExecutionId ? stopWorkflow() : chatStop()"
            @close="rightPaneVisible = false"
          />
        </div>
      </div>
    </div>

  <!-- Tab Context Menu -->
  <TabContextMenu
    :visible="tabContextMenu.visible"
    :x="tabContextMenu.x"
    :y="tabContextMenu.y"
    :tab="tabContextMenu.tab"
    :is-dark="isDark"
    @view-in-finder="viewInFinder"
    @open-with-editor="openWithEditor"
    @save-tab="saveTab"
    @close-tab="closeTab"
    @close-others="closeOtherTabs"
    @close-all="closeAllTabs"
  />

</template>

<script lang="ts">
import { defineComponent, ref, computed, reactive, markRaw, onMounted, onBeforeUnmount, watch, type Component } from 'vue';
import { ipcRenderer } from 'electron';

import PostHogTracker from '@pkg/components/PostHogTracker.vue';
import EditorHeader from './editor/EditorHeader.vue';
import FileTreeSidebar from './filesystem/FileTreeSidebar.vue';
import CodeEditor from './filesystem/CodeEditor.vue';
import DiffEditor from './filesystem/DiffEditor.vue';
import XTermTerminal from './editor/XTermTerminal.vue';
import TabContextMenu from './editor/TabContextMenu.vue';
import IconPanel from './editor/IconPanel.vue';
import FileSearch from './editor/FileSearch.vue';
import GitPane from './editor/GitPane.vue';
import DockerPane from './editor/DockerPane.vue';
import AgentPane from './editor/AgentPane.vue';
import IntegrationsPane from './editor/IntegrationsPane.vue';
import ApiTestPanel from './editor/ApiTestPanel.vue';
import AgentFormTab from './editor/AgentFormTab.vue';
import WorkflowPane from './editor/WorkflowPane.vue';
import WorkflowEditor from './editor/WorkflowEditor.vue';
import WorkflowNodePanel from './editor/WorkflowNodePanel.vue';
import WebViewTab from './editor/WebViewTab.vue';
import TerminalTab from './editor/TerminalTab.vue';
import EditorChat from './editor/EditorChat.vue';
import { EditorChatInterface } from './editor/EditorChatInterface';
import { FrontendGraphWebSocketService } from '@pkg/agent/services/FrontendGraphWebSocketService';
import { AgentModelSelectorController } from './agent/AgentModelSelectorController';
import { getAgentPersonaRegistry } from '@pkg/agent';

import type { FileEntry } from './filesystem/FileTreeSidebar.vue';

interface TabState {
  path: string;
  name: string;
  ext: string;
  content: string;
  loading: boolean;
  error: string;
  dirty: boolean;
  editorType?: 'code' | 'preview' | 'webview' | 'terminal' | 'diff' | 'agent-form';
  originalContent?: string; // For diff editor: the HEAD version
}

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx']);

const EXT_ICON_COLORS: Record<string, string> = {
  '.ts':   '#3178c6',
  '.tsx':  '#3178c6',
  '.js':   '#f0db4f',
  '.jsx':  '#f0db4f',
  '.vue':  '#41b883',
  '.json': '#f0db4f',
  '.md':   '#519aba',
  '.py':   '#3572A5',
  '.yaml': '#cb171e',
  '.yml':  '#cb171e',
  '.sh':   '#89e051',
  '.css':  '#563d7c',
  '.html': '#e34c26',
};

/**
 * Editor registry — maps editor type keys to Vue components.
 * Extensible: add new entries here to support more file types.
 */
const editorRegistry: Record<string, Component> = {
  code:      markRaw(CodeEditor),
  webview:   markRaw(WebViewTab),
  terminal:  markRaw(TerminalTab),
  diff:         markRaw(DiffEditor),
  'agent-form': markRaw(AgentFormTab),
};

function resolveEditorType(_ext: string): NonNullable<TabState['editorType']> {
  return 'code';
}

export default defineComponent({
  name: 'AgentFilesystem',

  components: {
    PostHogTracker,
    EditorHeader,
    FileTreeSidebar,
    CodeEditor,
    XTermTerminal,
    TabContextMenu,
    IconPanel,
    FileSearch,
    GitPane,
    DockerPane,
    AgentPane,
    IntegrationsPane,
    ApiTestPanel,
    AgentFormTab,
    WorkflowPane,
    WorkflowEditor,
    WorkflowNodePanel,
    EditorChat,
    DiffEditor,
  },

  setup(props, { emit }) {
    const isDark = ref(false);
    const THEME_STORAGE_KEY = 'agentTheme';
    const sullaMutedIconUrl = new URL('../../../resources/icons/sulla-muted-icon.png', import.meta.url).toString();
    const rootPath = ref('');
    const openTabs = ref<TabState[]>([]);
    const activeTabKey = ref('');
    const leftPaneVisible = ref(true);
    const centerPaneVisible = ref(true);
    const rightPaneVisible = ref(true);
    const bottomPaneVisible = ref(true);
    const bottomPaneTab = ref<'terminal' | 'api'>('terminal');
    const apiTabs = ref<Array<{ id: string; slug: string }>>([]);
    const activeApiTab = ref('');
    let apiTabCounter = 0;

    function openApiTest(slug: string) {
      // Check if a tab for this slug already exists
      const existing = apiTabs.value.find(t => t.slug === slug);
      if (existing) {
        activeApiTab.value = existing.id;
        bottomPaneVisible.value = true;
        bottomPaneTab.value = 'api';
        return;
      }
      apiTabCounter++;
      const newTab = { id: `api-${apiTabCounter}`, slug };
      apiTabs.value.push(newTab);
      activeApiTab.value = newTab.id;
      bottomPaneVisible.value = true;
      bottomPaneTab.value = 'api';
    }

    // Agent registry for agent selector
    const agentRegistry = getAgentPersonaRegistry();

    // Editor chat (uses active agent from registry)
    const editorCurrentThreadId = ref<string | null>(null);
    // Don't connect to 'sulla-desktop' — BackendGraphWebSocketService handles that channel in the main process.
    // The graph WS will be created lazily when the user switches to a non-default agent.
    let editorGraphWs: FrontendGraphWebSocketService | null = null;
    const editorChat = new EditorChatInterface();
    const chatMessages = editorChat.messages;
    const chatQuery = editorChat.query;
    const chatLoading = editorChat.loading;
    const chatGraphRunning = editorChat.graphRunning;
    const chatSend = () => editorChat.send();
    const chatStop = () => editorChat.stop();
    const chatUpdateQuery = (val: string) => { editorChat.query.value = val; };

    // Channels owned by BackendGraphWebSocketService in the main process.
    // The editor must NOT create a FrontendGraphWebSocketService for these.
    const BACKEND_CHANNELS = new Set(['sulla-desktop', 'heartbeat']);

    // When the active agent changes, create or switch the graph WS to the new channel.
    watch(() => agentRegistry.state.activeAgentId, (newAgentId) => {
      if (BACKEND_CHANNELS.has(newAgentId)) {
        return;
      }
      editorCurrentThreadId.value = null;
      if (!editorGraphWs) {
        editorGraphWs = new FrontendGraphWebSocketService({ currentThreadId: editorCurrentThreadId }, newAgentId);
      } else {
        editorGraphWs.switchChannel(newAgentId);
      }
    });

    // Model selector for editor chat
    const editorModelName = ref('');
    const editorModelMode = ref<'local' | 'remote'>('local');
    const editorSystemReady = ref(true);
    const editorModelLoading = ref(false);
    const editorIsRunning = chatGraphRunning;

    const modelSelector = new AgentModelSelectorController({
      systemReady: editorSystemReady,
      loading:     editorModelLoading,
      isRunning:   editorIsRunning,
      modelName:   editorModelName,
      modelMode:   editorModelMode,
    });

    // Token usage from the active agent persona
    const chatTotalTokensUsed = computed(() => {
      const persona = agentRegistry.getActivePersonaService();
      return persona?.state.totalTokensUsed ?? 0;
    });

    // Resizable pane sizes (persisted to localStorage)
    const PANE_STORAGE_KEY = 'agentEditorPaneSizes';
    const savedSizes = (() => {
      try {
        return JSON.parse(localStorage.getItem(PANE_STORAGE_KEY) || '{}');
      } catch { return {}; }
    })();
    const leftPaneWidth = ref<number>(savedSizes.left ?? 280);
    const rightPaneWidth = ref<number>(savedSizes.right ?? 280);
    const bottomPaneHeight = ref<number>(savedSizes.bottom ?? 200);

    function savePaneSizes() {
      localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify({
        left:   leftPaneWidth.value,
        right:  rightPaneWidth.value,
        bottom: bottomPaneHeight.value,
      }));
    }

    type ResizeTarget = 'left' | 'right' | 'bottom';
    let resizeTarget: ResizeTarget | null = null;
    let resizeStartPos = 0;
    let resizeStartSize = 0;

    function startResize(target: ResizeTarget, e: MouseEvent) {
      e.preventDefault();
      resizeTarget = target;
      if (target === 'bottom') {
        resizeStartPos = e.clientY;
        resizeStartSize = bottomPaneHeight.value;
      } else if (target === 'left') {
        resizeStartPos = e.clientX;
        resizeStartSize = leftPaneWidth.value;
      } else {
        resizeStartPos = e.clientX;
        resizeStartSize = rightPaneWidth.value;
      }
      document.addEventListener('mousemove', onResizeMove);
      document.addEventListener('mouseup', onResizeEnd);
      document.body.style.cursor = target === 'bottom' ? 'row-resize' : 'col-resize';
      document.body.style.userSelect = 'none';
    }

    function onResizeMove(e: MouseEvent) {
      if (!resizeTarget) return;
      if (resizeTarget === 'bottom') {
        const delta = resizeStartPos - e.clientY;
        bottomPaneHeight.value = Math.max(100, Math.min(600, resizeStartSize + delta));
      } else if (resizeTarget === 'left') {
        const delta = e.clientX - resizeStartPos;
        leftPaneWidth.value = Math.max(150, Math.min(600, resizeStartSize + delta));
      } else {
        const delta = resizeStartPos - e.clientX;
        rightPaneWidth.value = Math.max(150, Math.min(600, resizeStartSize + delta));
      }
    }

    function onResizeEnd() {
      resizeTarget = null;
      document.removeEventListener('mousemove', onResizeMove);
      document.removeEventListener('mouseup', onResizeEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      savePaneSizes();
    }
    const searchMode = ref(false);
    const gitMode = ref(false);
    const dockerMode = ref(false);
    const agentMode = ref(false);
    const integrationsMode = ref(false);
    const workflowMode = ref(false);
    const selectedWorkflowNode = ref<{ id: string; label: string; type?: string; data?: any } | null>(null);
    const workflowEditorRef = ref<InstanceType<typeof WorkflowEditor> | null>(null);
    const workflowPaneRef = ref<InstanceType<typeof WorkflowPane> | null>(null);
    const activeWorkflowData = ref<any>(null);
    const workflowSaveStatus = ref<'idle' | 'unsaved' | 'saving' | 'saved'>('idle');
    const workflowSettingsOpen = ref(false);
    const workflowExecutionId = ref<string | null>(null);
    const workflowChatMode = ref(false);
    let workflowExecUnsubscribe: (() => void) | null = null;
    let workflowSaveTimer: ReturnType<typeof setTimeout> | null = null;
    let workflowSavedResetTimer: ReturnType<typeof setTimeout> | null = null;
    const searchQuery = ref('');
    const searchPath = ref('');
    const searchResults = ref<Array<{ path: string; name: string; line: number; preview: string; score: number; source: 'fts' | 'filename' }>>([]);
    const qmdIndexing = ref(false);
    const qmdSearching = ref(false);

    // Terminal tabs state
    const terminalTabs = ref<Array<{ id: string; name: string; sessionId: string; command?: string; readOnly?: boolean }>>([
      { id: 'terminal-1', name: 'Terminal 1', sessionId: '' }
    ]);
    const activeTerminalTab = ref('terminal-1');
    let terminalCounter = 1;

    // Terminal tab functions
    function createNewTerminalTab() {
      terminalCounter++;
      const newTab = {
        id: `terminal-${terminalCounter}`,
        name: `Terminal ${terminalCounter}`,
        sessionId: ''
      };
      terminalTabs.value.push(newTab);
      activeTerminalTab.value = newTab.id;
    }

    function closeTerminalTab(tabId: string) {
      if (terminalTabs.value.length <= 1) return; // Don't close last tab
      
      const index = terminalTabs.value.findIndex(tab => tab.id === tabId);
      if (index === -1) return;
      
      const wasActive = activeTerminalTab.value === tabId;
      terminalTabs.value.splice(index, 1);
      
      if (wasActive) {
        // Switch to the last tab
        const lastTab = terminalTabs.value[terminalTabs.value.length - 1];
        activeTerminalTab.value = lastTab.id;
      }
    }

    function closeApiTab(tabId: string) {
      const index = apiTabs.value.findIndex(t => t.id === tabId);
      if (index === -1) return;
      const wasActive = activeApiTab.value === tabId;
      apiTabs.value.splice(index, 1);
      if (wasActive) {
        if (apiTabs.value.length > 0) {
          const last = apiTabs.value[apiTabs.value.length - 1];
          activeApiTab.value = last.id;
        } else {
          activeApiTab.value = '';
          bottomPaneTab.value = 'terminal';
        }
      }
    }

    function switchTerminalTab(tabId: string) {
      activeTerminalTab.value = tabId;
    }

    onMounted(async () => {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);

      if (stored === 'dark') {
        isDark.value = true;
      } else if (stored === 'light') {
        isDark.value = false;
      } else {
        isDark.value = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
      }

      await modelSelector.start();
      window.addEventListener('keydown', onKeyDown);
      document.addEventListener('mousedown', onEditorMenuOutsideClick);
      document.addEventListener('click', onInjectMenuOutsideClick);
    });

    function toggleTheme() {
      isDark.value = !isDark.value;
      localStorage.setItem(THEME_STORAGE_KEY, isDark.value ? 'dark' : 'light');
    }

    // Saved pane states to restore when exiting workflow mode
    let savedBottomPaneVisible = false;
    let savedRightPaneVisible = false;

    function clearModes() {
      // Restore panes if leaving workflow mode
      if (workflowMode.value) {
        bottomPaneVisible.value = savedBottomPaneVisible;
        rightPaneVisible.value = savedRightPaneVisible;
      }
      searchMode.value = false;
      gitMode.value = false;
      dockerMode.value = false;
      agentMode.value = false;
      integrationsMode.value = false;
      workflowMode.value = false;
    }

    function toggleFileTree() {
      if (!leftPaneVisible.value) {
        leftPaneVisible.value = true;
        clearModes();
      } else if (searchMode.value || gitMode.value || dockerMode.value || agentMode.value || integrationsMode.value || workflowMode.value) {
        clearModes();
      } else {
        leftPaneVisible.value = false;
      }
    }

    function toggleSearch() {
      if (!leftPaneVisible.value) {
        leftPaneVisible.value = true;
        clearModes();
        searchMode.value = true;
      } else if (!searchMode.value) {
        clearModes();
        searchMode.value = true;
      } else {
        leftPaneVisible.value = false;
      }
    }

    function toggleGit() {
      if (!leftPaneVisible.value) {
        leftPaneVisible.value = true;
        clearModes();
        gitMode.value = true;
      } else if (!gitMode.value) {
        clearModes();
        gitMode.value = true;
      } else {
        leftPaneVisible.value = false;
      }
    }

    function toggleDocker() {
      if (!leftPaneVisible.value) {
        leftPaneVisible.value = true;
        clearModes();
        dockerMode.value = true;
      } else if (!dockerMode.value) {
        clearModes();
        dockerMode.value = true;
      } else {
        leftPaneVisible.value = false;
      }
    }

    function toggleAgent() {
      if (!leftPaneVisible.value) {
        leftPaneVisible.value = true;
        clearModes();
        agentMode.value = true;
      } else if (!agentMode.value) {
        clearModes();
        agentMode.value = true;
      } else {
        leftPaneVisible.value = false;
      }
    }

    function toggleIntegrations() {
      if (!leftPaneVisible.value) {
        leftPaneVisible.value = true;
        clearModes();
        integrationsMode.value = true;
      } else if (!integrationsMode.value) {
        clearModes();
        integrationsMode.value = true;
      } else {
        leftPaneVisible.value = false;
      }
    }

    function toggleWorkflow() {
      if (!leftPaneVisible.value) {
        leftPaneVisible.value = true;
        clearModes();
        workflowMode.value = true;
        savedBottomPaneVisible = bottomPaneVisible.value;
        savedRightPaneVisible = rightPaneVisible.value;
        bottomPaneVisible.value = false;
        rightPaneVisible.value = false;
      } else if (!workflowMode.value) {
        clearModes();
        workflowMode.value = true;
        savedBottomPaneVisible = bottomPaneVisible.value;
        savedRightPaneVisible = rightPaneVisible.value;
        bottomPaneVisible.value = false;
        rightPaneVisible.value = false;
      } else {
        leftPaneVisible.value = false;
        workflowMode.value = false;
        bottomPaneVisible.value = savedBottomPaneVisible;
        rightPaneVisible.value = savedRightPaneVisible;
      }
    }

    function onWorkflowNodeSelected(node: { id: string; label: string; type?: string; data?: any } | null) {
      selectedWorkflowNode.value = node;
      if (node) {
        workflowSettingsOpen.value = false;
        rightPaneVisible.value = true;
      } else {
        rightPaneVisible.value = false;
      }
    }

    function onWorkflowNodeLabelUpdate(nodeId: string, label: string) {
      workflowEditorRef.value?.updateNodeLabel(nodeId, label);
      if (selectedWorkflowNode.value && selectedWorkflowNode.value.id === nodeId) {
        selectedWorkflowNode.value = { ...selectedWorkflowNode.value, label };
      }
    }

    function onWorkflowNodeConfigUpdate(nodeId: string, config: Record<string, any>) {
      workflowEditorRef.value?.updateNodeConfig(nodeId, config);
    }

    function onWorkflowNodePanelClose() {
      selectedWorkflowNode.value = null;
      rightPaneVisible.value = false;
    }

    /** Walk edges backward to collect all upstream nodes for the selected node */
    const selectedNodeUpstream = computed(() => {
      const node = selectedWorkflowNode.value;
      if (!node || !workflowEditorRef.value) return [];

      const allNodes = workflowEditorRef.value.getNodes();
      const allEdges = workflowEditorRef.value.getEdges();
      if (!allNodes || !allEdges) return [];

      const visited = new Set<string>();
      const queue: string[] = [];

      // Seed with direct upstream of the selected node
      for (const edge of allEdges) {
        if (edge.target === node.id && !visited.has(edge.source)) {
          visited.add(edge.source);
          queue.push(edge.source);
        }
      }

      // BFS backward through all edges
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const edge of allEdges) {
          if (edge.target === current && !visited.has(edge.source)) {
            visited.add(edge.source);
            queue.push(edge.source);
          }
        }
      }

      // Map to UpstreamNodeInfo
      return allNodes
        .filter((n: any) => visited.has(n.id))
        .map((n: any) => ({
          nodeId:   n.id,
          label:    n.data?.label || n.id,
          subtype:  n.data?.subtype || '',
          category: n.data?.category || '',
        }));
    });

    /**
     * Snapshot current canvas state into activeWorkflowData before metadata changes.
     * This prevents the WorkflowEditor watch from resetting nodes/edges to stale data
     * when activeWorkflowData is reassigned with a new object reference.
     */
    function snapshotCanvasIntoWorkflowData(): void {
      const serialized = workflowEditorRef.value?.serialize();
      if (serialized && activeWorkflowData.value) {
        activeWorkflowData.value.nodes = serialized.nodes;
        activeWorkflowData.value.edges = serialized.edges;
        activeWorkflowData.value.viewport = serialized.viewport;
      }
    }

    function toggleWorkflowSettings() {
      if (workflowSettingsOpen.value) {
        workflowSettingsOpen.value = false;
        rightPaneVisible.value = false;
      } else {
        selectedWorkflowNode.value = null;
        workflowSettingsOpen.value = true;
        rightPaneVisible.value = true;
      }
    }

    function toggleWorkflowEnabled() {
      if (!activeWorkflowData.value) return;
      snapshotCanvasIntoWorkflowData();
      activeWorkflowData.value = { ...activeWorkflowData.value, enabled: !activeWorkflowData.value.enabled };
      onWorkflowChanged();
      saveWorkflowNow();
    }

    function onWorkflowSettingsClose() {
      workflowSettingsOpen.value = false;
      rightPaneVisible.value = false;
    }

    function onWorkflowNameUpdate(name: string) {
      if (activeWorkflowData.value) {
        snapshotCanvasIntoWorkflowData();
        activeWorkflowData.value = { ...activeWorkflowData.value, name };
        onWorkflowChanged();
        // Sync tab name in WorkflowPane
        workflowPaneRef.value?.updateTabName(activeWorkflowData.value.id, name);
      }
    }

    function onWorkflowDeleted(workflowId: string) {
      // If the deleted workflow is currently active, clear it
      if (activeWorkflowData.value?.id === workflowId) {
        activeWorkflowData.value = null;
        workflowSettingsOpen.value = false;
        rightPaneVisible.value = false;
      }
    }

    async function deleteActiveWorkflow() {
      if (!activeWorkflowData.value) return;
      const wfId = activeWorkflowData.value.id;
      const wfName = activeWorkflowData.value.name;

      // Close settings
      workflowSettingsOpen.value = false;
      rightPaneVisible.value = false;
      activeWorkflowData.value = null;

      // Delete via IPC
      try {
        await ipcRenderer.invoke('workflow-delete', wfId);
        console.log(`[AgentEditor] Deleted workflow: ${wfName} (${wfId})`);
      } catch (err) {
        console.error('[AgentEditor] Failed to delete workflow:', err);
      }

      // Close the tab and refresh the list
      workflowPaneRef.value?.closeTab(wfId);
      workflowPaneRef.value?.loadWorkflowList();
    }

    function onWorkflowDescriptionUpdate(description: string) {
      if (activeWorkflowData.value) {
        snapshotCanvasIntoWorkflowData();
        activeWorkflowData.value = { ...activeWorkflowData.value, description };
        onWorkflowChanged();
      }
    }

    async function runWorkflow() {
      if (!activeWorkflowData.value) return;

      // If already in workflow chat mode, just ensure the pane is visible
      if (workflowChatMode.value) {
        rightPaneVisible.value = true;
        return;
      }

      // Save first to ensure latest version is on disk
      saveWorkflowNow();

      // Open the chat pane so the user can send a message to trigger the workflow
      selectedWorkflowNode.value = null;
      workflowSettingsOpen.value = false;
      workflowChatMode.value = true;
      rightPaneVisible.value = true;

      // Clear previous execution state from nodes
      workflowEditorRef.value?.clearAllExecution();
    }

    /**
     * Called when the user sends a message in chat while in workflow mode.
     * Dispatches the message to the active workflow via the registry.
     */
    async function workflowChatSend() {
      if (!activeWorkflowData.value || !chatQuery.value.trim()) return;

      const message = chatQuery.value.trim();
      chatUpdateQuery('');

      // Add the user message to chat
      chatMessages.value = [
        ...chatMessages.value,
        {
          id:        `wf-user-${Date.now()}`,
          channelId: 'workflow',
          role:      'user' as const,
          content:   message,
        },
      ];

      try {
        const { executionId } = await ipcRenderer.invoke(
          'workflow-execute',
          activeWorkflowData.value.id,
          message,
        );
        workflowExecutionId.value = executionId;

        // Subscribe to execution events via IPC
        const handler = (_ev: any, event: any) => {
          handleWorkflowExecutionEvent(event);
        };
        ipcRenderer.on(`workflow-execution-event-${executionId}`, handler);
        workflowExecUnsubscribe = () => {
          ipcRenderer.removeListener(`workflow-execution-event-${executionId}`, handler);
        };

        // Add a system message showing execution started
        chatMessages.value = [
          ...chatMessages.value,
          {
            id:        `wf-sys-${Date.now()}`,
            channelId: 'workflow',
            role:      'system' as const,
            content:   `Workflow "${activeWorkflowData.value.name}" started...`,
          },
        ];

        startExecutionPolling(executionId);
      } catch (err: any) {
        console.error('Failed to execute workflow:', err);
        chatMessages.value = [
          ...chatMessages.value,
          {
            id:        `wf-err-${Date.now()}`,
            channelId: 'workflow',
            role:      'error' as const,
            content:   `Failed to start workflow: ${err.message}`,
          },
        ];
      }
    }

    function stopWorkflow() {
      if (!workflowExecutionId.value) return;
      ipcRenderer.invoke('workflow-execution-abort', workflowExecutionId.value).catch(() => {});
      cleanupExecution();
    }

    function cleanupExecution() {
      if (workflowExecUnsubscribe) {
        workflowExecUnsubscribe();
        workflowExecUnsubscribe = null;
      }
      workflowExecutionId.value = null;
    }

    let executionPollTimer: ReturnType<typeof setTimeout> | null = null;

    function startExecutionPolling(executionId: string) {
      if (executionPollTimer) clearTimeout(executionPollTimer);

      const poll = async() => {
        if (workflowExecutionId.value !== executionId) return;
        try {
          const status = await ipcRenderer.invoke('workflow-execution-status', executionId);
          if (status && (status.status === 'completed' || status.status === 'failed' || status.status === 'aborted')) {
            // Execution finished — keep the visual state but allow re-run
            workflowExecutionId.value = null;
            if (workflowExecUnsubscribe) {
              workflowExecUnsubscribe();
              workflowExecUnsubscribe = null;
            }
            return;
          }
        } catch { /* ignore */ }
        executionPollTimer = setTimeout(poll, 1000);
      };
      executionPollTimer = setTimeout(poll, 1000);
    }

    function handleWorkflowExecutionEvent(event: any) {
      if (!event || !workflowEditorRef.value) return;

      const nodeId = event.nodeId;

      switch (event.type) {
        case 'node_started':
          workflowEditorRef.value.updateNodeExecution(nodeId, {
            status:    'running',
            startedAt: event.timestamp,
          });
          break;

        case 'node_completed':
          workflowEditorRef.value.updateNodeExecution(nodeId, {
            status:      'completed',
            threadId:    event.threadId,
            output:      event.output,
            completedAt: event.timestamp,
          });
          // Push output to chat if in workflow chat mode
          if (workflowChatMode.value && event.output) {
            const outputStr = typeof event.output === 'string' ? event.output : JSON.stringify(event.output);
            if (outputStr && outputStr !== '{}' && outputStr !== 'null') {
              chatMessages.value = [
                ...chatMessages.value,
                {
                  id:        `wf-node-${Date.now()}-${nodeId}`,
                  channelId: 'workflow',
                  role:      'assistant' as const,
                  content:   `**${event.nodeLabel || nodeId}:** ${outputStr}`,
                },
              ];
            }
          }
          break;

        case 'node_failed':
          workflowEditorRef.value.updateNodeExecution(nodeId, {
            status:      'failed',
            error:       event.error,
            completedAt: event.timestamp,
          });
          if (workflowChatMode.value && event.error) {
            chatMessages.value = [
              ...chatMessages.value,
              {
                id:        `wf-err-${Date.now()}-${nodeId}`,
                channelId: 'workflow',
                role:      'error' as const,
                content:   `**${event.nodeLabel || nodeId}** failed: ${event.error}`,
              },
            ];
          }
          break;

        case 'node_skipped':
          workflowEditorRef.value.updateNodeExecution(nodeId, { status: 'skipped' });
          break;

        case 'node_waiting':
          workflowEditorRef.value.updateNodeExecution(nodeId, {
            status: 'waiting',
            output: event.output,
          });
          break;

        case 'workflow_completed':
          workflowExecutionId.value = null;
          if (workflowExecUnsubscribe) { workflowExecUnsubscribe(); workflowExecUnsubscribe = null; }
          if (workflowChatMode.value) {
            chatMessages.value = [
              ...chatMessages.value,
              { id: `wf-done-${Date.now()}`, channelId: 'workflow', role: 'system' as const, content: 'Workflow completed.' },
            ];
          }
          break;

        case 'workflow_failed':
          workflowExecutionId.value = null;
          if (workflowExecUnsubscribe) { workflowExecUnsubscribe(); workflowExecUnsubscribe = null; }
          if (workflowChatMode.value) {
            chatMessages.value = [
              ...chatMessages.value,
              { id: `wf-fail-${Date.now()}`, channelId: 'workflow', role: 'error' as const, content: `Workflow failed: ${event.error || 'Unknown error'}` },
            ];
          }
          break;

        case 'workflow_aborted':
          workflowExecutionId.value = null;
          if (workflowExecUnsubscribe) { workflowExecUnsubscribe(); workflowExecUnsubscribe = null; }
          if (workflowChatMode.value) {
            chatMessages.value = [
              ...chatMessages.value,
              { id: `wf-abort-${Date.now()}`, channelId: 'workflow', role: 'system' as const, content: 'Workflow aborted.' },
            ];
          }
          break;
      }
    }

    async function onWorkflowActivated(workflowId: string) {
      workflowSaveStatus.value = 'idle';
      try {
        const data = await ipcRenderer.invoke('workflow-get', workflowId);
        activeWorkflowData.value = data;
      } catch {
        // New workflow not yet saved — start with empty canvas
        activeWorkflowData.value = {
          id: workflowId, name: workflowId, description: '', version: 1,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          nodes: [], edges: [],
        };
      }
    }

    function onWorkflowClosed(_workflowId: string) {
      if (workflowExecutionId.value) {
        stopWorkflow();
      }
      activeWorkflowData.value = null;
      selectedWorkflowNode.value = null;
      workflowSettingsOpen.value = false;
      workflowChatMode.value = false;
      workflowSaveStatus.value = 'idle';
      rightPaneVisible.value = false;
    }

    async function onWorkflowCreated(workflowId: string, workflowName: string) {
      const newWorkflow = {
        id: workflowId, name: workflowName, description: '', version: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [], edges: [],
      };
      try {
        await ipcRenderer.invoke('workflow-save', newWorkflow);
      } catch (err) {
        console.error('Failed to save new workflow:', err);
      }
      activeWorkflowData.value = newWorkflow;
      workflowPaneRef.value?.loadWorkflowList();
    }

    function doWorkflowSave() {
      const serialized = workflowEditorRef.value?.serialize();
      if (serialized && activeWorkflowData.value) {
        workflowSaveStatus.value = 'saving';
        const toSave = {
          ...activeWorkflowData.value,
          nodes:    serialized.nodes,
          edges:    serialized.edges,
          viewport: serialized.viewport,
          updatedAt: new Date().toISOString(),
        };
        ipcRenderer.invoke('workflow-save', toSave).then(() => {
          workflowSaveStatus.value = 'saved';
          if (workflowSavedResetTimer) clearTimeout(workflowSavedResetTimer);
          workflowSavedResetTimer = setTimeout(() => {
            if (workflowSaveStatus.value === 'saved') {
              workflowSaveStatus.value = 'idle';
            }
          }, 2000);
        }).catch((err: any) => {
          console.error('Failed to save workflow:', err);
          workflowSaveStatus.value = 'unsaved';
        });
      }
    }

    function onWorkflowChanged() {
      if (!activeWorkflowData.value) return;
      workflowSaveStatus.value = 'unsaved';
      if (workflowSaveTimer) clearTimeout(workflowSaveTimer);
      workflowSaveTimer = setTimeout(doWorkflowSave, 500);
    }

    function saveWorkflowNow() {
      if (!activeWorkflowData.value) return;
      if (workflowSaveTimer) clearTimeout(workflowSaveTimer);
      doWorkflowSave();
    }

    async function loadRootPath() {
      try {
        rootPath.value = await ipcRenderer.invoke('filesystem-get-root');
        searchPath.value = rootPath.value;
        // Index the root directory in the background for qmd search
        qmdIndexing.value = true;
        ipcRenderer.invoke('qmd-index', rootPath.value).catch(() => {}).finally(() => {
          qmdIndexing.value = false;
        });
      } catch { /* ignore */ }
    }
    loadRootPath();

    // Debounced search via qmd
    let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    watch(searchQuery, (query) => {
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
      }
      if (!query.trim()) {
        searchResults.value = [];
        return;
      }
      searchDebounceTimer = setTimeout(async() => {
        try {
          qmdSearching.value = true;
          const dir = searchPath.value || rootPath.value;
          searchResults.value = await ipcRenderer.invoke('qmd-search', query, dir);
        } catch {
          searchResults.value = [];
        } finally {
          qmdSearching.value = false;
        }
      }, 300);
    });

    // Re-index when the search path changes
    watch(searchPath, (newPath) => {
      if (!newPath.trim()) {
        return;
      }
      qmdIndexing.value = true;
      ipcRenderer.invoke('qmd-index', newPath).catch(() => {}).finally(() => {
        qmdIndexing.value = false;
      });
    });

    const activeTab = computed(() => {
      return openTabs.value.find(t => `${t.path}-${t.editorType || 'code'}` === activeTabKey.value) || null;
    });

    const activeEditorComponent = computed(() => {
      if (!activeTab.value) return null;
      // Use explicit editor type if provided, otherwise resolve by extension
      const editorType = activeTab.value.editorType || resolveEditorType(activeTab.value.ext);
      return editorRegistry[editorType] || editorRegistry.code;
    });

    function getIconColor(ext: string): string {
      return EXT_ICON_COLORS[ext] || '#999';
    }

    const activeBreadcrumbs = computed(() => {
      if (!activeTab.value || !rootPath.value) return [];
      const relative = activeTab.value.path.replace(rootPath.value, '').replace(/^\//, '');
      return relative.split('/');
    });

    const estimatedTokens = computed(() => {
      const content = activeTab.value?.content || '';
      const count = Math.ceil(content.length / 4);
      if (count >= 1000) {
        return `${(count / 1000).toFixed(1)}k`;
      }
      return String(count);
    });

    async function loadTabContent(tab: TabState) {
      try {
        console.log('Loading file content for path:', tab.path);
        tab.content = await ipcRenderer.invoke('filesystem-read-file', tab.path);
        console.log('File content loaded successfully, length:', tab.content?.length);
      } catch (err: any) {
        console.error('Failed to load file content:', err);
        tab.error = err?.message || 'Failed to read file';
      } finally {
        tab.loading = false;
      }
    }

    async function onFileSelected(entry: FileEntry) {
      // Resolve editor type: use explicit type if provided, otherwise auto-detect
      // ('markdown' is no longer supported — treat as code)
      const editorType = entry.editorType === 'markdown' ? 'code' : (entry.editorType || resolveEditorType(entry.ext));

      // Check if tab already open with same path and editorType
      const key = `${entry.path}-${editorType}`;
      const existing = openTabs.value.find(t => `${t.path}-${t.editorType || 'code'}` === key);
      if (existing) {
        activeTabKey.value = key;
        // Reload content from disk if the tab isn't dirty
        if (!existing.dirty) {
          await loadTabContent(existing);
        }
        return;
      }

      // Create new tab
      const tab: TabState = reactive({
        path:       entry.path,
        name:       entry.name,
        ext:        entry.ext,
        content:    '',
        loading:    true,
        error:      '',
        dirty:      false,
        editorType,
      });

      openTabs.value = [...openTabs.value, tab];
      activeTabKey.value = key;

      await loadTabContent(tab);
    }

    async function onOpenDiff(repoRoot: string, file: string, staged: boolean) {
      const fullPath = repoRoot + '/' + file;
      const key = `${fullPath}-diff`;
      const existing = openTabs.value.find(t => `${t.path}-${t.editorType || 'code'}` === key);
      if (existing) {
        activeTabKey.value = key;
        return;
      }

      const name = file.split('/').pop() || file;
      const ext = name.includes('.') ? '.' + name.split('.').pop() : '';

      const tab: TabState = reactive({
        path:            fullPath,
        name:            name,
        ext:             ext,
        content:         '',
        originalContent: '',
        loading:         true,
        error:           '',
        dirty:           false,
        editorType:      'diff',
      });

      openTabs.value = [...openTabs.value, tab];
      activeTabKey.value = key;

      try {
        // For staged files: compare HEAD vs staged (index) version
        // For unstaged files: compare HEAD vs working copy
        const [modifiedContent, originalContent] = await Promise.all([
          staged
            ? ipcRenderer.invoke('git-show-staged', repoRoot, file)
            : ipcRenderer.invoke('filesystem-read-file', fullPath),
          ipcRenderer.invoke('git-show-head', repoRoot, file),
        ]);
        tab.content = modifiedContent || '';
        tab.originalContent = originalContent || '';
      } catch (err: any) {
        tab.error = err?.message || 'Failed to load diff';
      } finally {
        tab.loading = false;
      }
    }

    function switchTab(tab: TabState) {
      activeTabKey.value = `${tab.path}-${tab.editorType || 'code'}`;
    }

    function closeTab(tab: TabState) {
      const index = openTabs.value.findIndex(t => t === tab);
      if (index === -1) return;

      const wasActive = `${tab.path}-${tab.editorType || 'code'}` === activeTabKey.value;
      openTabs.value.splice(index, 1);

      if (wasActive) {
        if (openTabs.value.length === 0) {
          activeTabKey.value = '';
        } else {
          // Switch to the last tab
          const lastTab = openTabs.value[openTabs.value.length - 1];
          activeTabKey.value = `${lastTab.path}-${lastTab.editorType || 'code'}`;
        }
      }
    }

    function closeOtherTabs(tab: TabState) {
      openTabs.value = openTabs.value.filter(t => t === tab);
      activeTabKey.value = `${tab.path}-${tab.editorType || 'code'}`;
    }

    function closeAllTabs() {
      openTabs.value = [];
      activeTabKey.value = '';
    }

    const highlightPath = ref('');

    const tabContextMenu = ref<{
      visible: boolean;
      x: number;
      y: number;
      tab: TabState | null;
    }>({
      visible: false,
      x: 0,
      y: 0,
      tab: null,
    });

    function onTabContextMenu(event: MouseEvent, tab: TabState) {
      tabContextMenu.value = {
        visible: true,
        x: event.clientX,
        y: event.clientY,
        tab,
      };
    }

    function hideTabContextMenu() {
      tabContextMenu.value.visible = false;
    }

    // ─── Editor menu (ellipsis in tab bar) ────────────────────────
    const editorMenu = reactive({ visible: false });
    const editorDropdownRef = ref<HTMLDivElement | null>(null);
    let untitledCounter = 0;

    function createNewUntitledTab() {
      editorMenu.visible = false;
      untitledCounter++;
      const name = `Untitled-${untitledCounter}`;
      const key = `untitled://${name}-code`;

      const tab: TabState = reactive({
        path:       `untitled://${name}`,
        name:       name,
        ext:        '.txt',
        content:    '',
        loading:    false,
        error:      '',
        dirty:      false,
        editorType: 'code',
      });

      openTabs.value = [...openTabs.value, tab];
      activeTabKey.value = key;
    }

    // Close editor menu on outside click
    function onEditorMenuOutsideClick(e: MouseEvent) {
      if (editorMenu.visible && editorDropdownRef.value && !editorDropdownRef.value.contains(e.target as Node)) {
        editorMenu.visible = false;
      }
    }

    // ─── Inject Variable context menu ─────────────────────────
    interface TemplateVar { key: string; label: string; preview: string }
    const injectMenu = reactive({
      visible: false,
      x: 0,
      y: 0,
      variables: [] as TemplateVar[],
    });

    function isAgentFile(): boolean {
      const p = activeTab.value?.path || '';
      return p.includes('/agents/') && !p.startsWith('agent-form://');
    }

    async function onEditorContextMenu(e: MouseEvent) {
      if (!isAgentFile()) return; // let default context menu through
      e.preventDefault();
      try {
        const vars: TemplateVar[] = await ipcRenderer.invoke('agents-get-template-variables');
        injectMenu.variables = vars;
        injectMenu.x = e.clientX;
        injectMenu.y = e.clientY;
        injectMenu.visible = true;
      } catch (err) {
        console.error('Failed to load template variables:', err);
      }
    }

    function doInjectVariable(key: string) {
      injectMenu.visible = false;
      if (editorRef.value?.insertAtCursor) {
        editorRef.value.insertAtCursor(key);
      }
    }

    function onInjectMenuOutsideClick() {
      if (injectMenu.visible) {
        injectMenu.visible = false;
      }
    }

    // Functions needed by FileTree component
    function viewInFinder(tab: TabState) {
      // Set highlight path to highlight the file in the file tree
      highlightPath.value = tab.path;
      // Emit event to file tree to highlight this file (keeping for backward compatibility)
      emit('highlight-file', tab.path);
      hideTabContextMenu();
    }

    function openWithEditor(tab: TabState, editorType: 'code' | 'preview') {
      // Check if tab with same path and editorType already exists
      const key = `${tab.path}-${editorType}`;
      const existing = openTabs.value.find(t => `${t.path}-${t.editorType || 'code'}` === key);
      if (existing) {
        activeTabKey.value = key;
        hideTabContextMenu();
        return;
      }

      // Create new tab with same path but different editor
      const newTab: TabState = reactive({
        path:       tab.path,
        name:       tab.name,
        ext:        tab.ext,
        content:    '',
        loading:    true,
        error:      '',
        dirty:      false,
        editorType: editorType,
      });

      openTabs.value = [...openTabs.value, newTab];
      activeTabKey.value = key;

      // Load content
      loadTabContent(newTab);
      hideTabContextMenu();
    }

    function saveTab(tab: TabState) {
      if (tab.dirty) {
        saveActiveTab();
      }
      hideTabContextMenu();
    }

    // Editor ref for accessing exposed methods (e.g. getContent)
    const editorRef = ref<any>(null);
    const fileTreeRef = ref<any>(null);
    const agentPaneRef = ref<any>(null);

    function onNewAgentTab() {
      const key = 'agent-form://new-agent-form';
      const existing = openTabs.value.find(t => `${t.path}-${t.editorType || 'code'}` === key);
      if (existing) {
        activeTabKey.value = key;
        return;
      }
      const tab: TabState = reactive({
        path:       'agent-form://new',
        name:       'New Agent',
        ext:        '',
        content:    '',
        loading:    false,
        error:      '',
        dirty:      false,
        editorType: 'agent-form',
      });
      openTabs.value = [...openTabs.value, tab];
      activeTabKey.value = key;
    }

    function activateAgentInRegistry(agent: { id: string; name: string; templateId?: string }) {
      // Ensure the agent entry exists in the registry
      if (!agentRegistry.state.agents.some(a => a.agentId === agent.id)) {
        agentRegistry.upsertAgent({
          isRunning:       true,
          agentId:         agent.id,
          agentName:       agent.name,
          templateId:      (agent.templateId || 'glass-core') as any,
          emotion:         'calm',
          status:          'online',
          tokensPerSecond: 0,
          totalTokensUsed: 0,
          temperature:     0.7,
          messages:        [],
          loading:         false,
        } as any);
      }
      // Create persona service (connects WebSocket on this agent's channel)
      agentRegistry.getOrCreatePersonaService(agent.id);
      // Set as active so the chat interface routes to this agent
      agentRegistry.setActiveAgent(agent.id);
    }

    async function onEditAgent(agent: { id: string; name: string; description: string; type: string; templateId?: string; path: string }) {
      // Activate this agent: ensure it exists in registry, connect its WS, and set active
      activateAgentInRegistry(agent);

      const editPath = `agent-form://edit/${agent.id}`;
      const key = `${editPath}-agent-form`;
      const existing = openTabs.value.find(t => `${t.path}-${t.editorType || 'code'}` === key);
      if (existing) {
        activeTabKey.value = key;
        return;
      }

      // Read agent.yaml content so form can pre-fill
      let yamlContent = '';
      try {
        yamlContent = await ipcRenderer.invoke('filesystem-read-file', `${agent.path}/agent.yaml`);
      } catch { /* ignore */ }

      const tab: TabState = reactive({
        path:       editPath,
        name:       `Edit: ${agent.name}`,
        ext:        '',
        content:    yamlContent,
        loading:    false,
        error:      '',
        dirty:      false,
        editorType: 'agent-form',
      });
      openTabs.value = [...openTabs.value, tab];
      activeTabKey.value = key;
    }

    function onAgentFormSaved(_agentPath: string) {
      // Refresh the agent pane listing
      agentPaneRef.value?.refresh();
      // Mark the form tab as clean (no longer dirty)
      const formTab = openTabs.value.find(t => t.editorType === 'agent-form');
      if (formTab) formTab.dirty = false;
    }

    function markActiveTabDirty() {
      const tab = activeTab.value;
      if (tab && !tab.dirty) tab.dirty = true;
    }

    async function saveActiveTab() {
      const tab = activeTab.value;
      if (!tab || !tab.dirty) return;

      try {
        let content = tab.content;

        // Get content from Monaco editor
        if (editorRef.value?.getContent) {
          content = editorRef.value.getContent();
        }

        // Agent-form tabs save via their own handler; skip filesystem write
        if (tab.path.startsWith('agent-form://')) {
          if (editorRef.value?.save) {
            await editorRef.value.save();
          }
          return;
        }

        // Untitled files need a save dialog
        if (tab.path.startsWith('untitled://')) {
          const savePath: string | null = await ipcRenderer.invoke(
            'filesystem-save-dialog',
            tab.name,
            rootPath.value || undefined,
          );
          if (!savePath) return; // User cancelled

          // Update tab identity
          const fileName = savePath.split('/').pop() || tab.name;
          const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : '.txt';
          tab.path = savePath;
          tab.name = fileName;
          tab.ext = ext;
          activeTabKey.value = `${tab.path}-${tab.editorType || 'code'}`;
        }

        await ipcRenderer.invoke('filesystem-write-file', tab.path, content);
        tab.dirty = false;
        tab.content = content;
        tab.originalContent = content;
        fileTreeRef.value?.refresh();

        // Update other open tabs showing the same file
        for (const other of openTabs.value) {
          if (other !== tab && other.path === tab.path && !other.dirty) {
            other.content = content;
            other.originalContent = content;
          }
        }
      } catch (err: any) {
        console.error('Save failed:', err);
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveActiveTab();
      }
    }

    // Tab context menu removed - now in FileTree component

    function openContainerPort({ url, name }: { url: string; name: string }) {
      const key = `${url}-webview`;
      const existing = openTabs.value.find(t => `${t.path}-${t.editorType || 'code'}` === key);
      if (existing) {
        activeTabKey.value = key;
        return;
      }
      const tab: TabState = reactive({
        path:       url,
        name,
        ext:        '',
        content:    url,
        loading:    false,
        error:      '',
        dirty:      false,
        editorType: 'webview',
      });
      openTabs.value = [...openTabs.value, tab];
      activeTabKey.value = key;
    }

    function openDockerTerminalTab(name: string, command: string, readOnly: boolean) {
      terminalCounter++;
      const newTab = {
        id: `terminal-${terminalCounter}`,
        name,
        sessionId: '',
        command,
        readOnly,
      };
      terminalTabs.value.push(newTab);
      activeTerminalTab.value = newTab.id;
      bottomPaneVisible.value = true;
    }

    function openDockerLogs(containerName: string) {
      const command = `docker logs -f ${containerName}`;
      const key = `${command}-terminal`;
      const existing = openTabs.value.find(t => `${t.path}-${t.editorType || 'code'}` === key);
      if (existing) {
        activeTabKey.value = key;
        return;
      }
      const tab: TabState = reactive({
        path:       command,
        name:       `Logs: ${containerName}`,
        ext:        '',
        content:    command,
        loading:    false,
        error:      '',
        dirty:      false,
        editorType: 'terminal',
      });
      openTabs.value = [...openTabs.value, tab];
      activeTabKey.value = key;
    }

    function openDockerExec(containerName: string) {
      openDockerTerminalTab(
        `Shell: ${containerName}`,
        `docker exec -it ${containerName} sh`,
        false,
      );
    }

    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onEditorMenuOutsideClick);
      document.removeEventListener('click', onInjectMenuOutsideClick);
      editorChat.dispose();
      editorGraphWs?.dispose();
      modelSelector.dispose();
    });

    return {
      isDark,
      sullaMutedIconUrl,
      chatMessages,
      chatQuery,
      chatLoading,
      chatGraphRunning,
      chatSend,
      chatStop,
      chatUpdateQuery,
      modelSelector,
      agentRegistry,
      chatTotalTokensUsed,
      toggleTheme,
      toggleFileTree,
      toggleSearch,
      toggleGit,
      toggleDocker,
      dockerMode,
      agentMode,
      integrationsMode,
      toggleIntegrations,
      workflowMode,
      selectedWorkflowNode,
      selectedNodeUpstream,
      workflowEditorRef,
      onWorkflowNodeSelected,
      onWorkflowNodeLabelUpdate,
      onWorkflowNodeConfigUpdate,
      onWorkflowNodePanelClose,
      onWorkflowActivated,
      onWorkflowClosed,
      onWorkflowCreated,
      onWorkflowChanged,
      saveWorkflowNow,
      workflowSaveStatus,
      workflowSettingsOpen,
      activeWorkflowData,
      toggleWorkflowSettings,
      toggleWorkflowEnabled,
      onWorkflowSettingsClose,
      onWorkflowNameUpdate,
      onWorkflowDescriptionUpdate,
      onWorkflowDeleted,
      deleteActiveWorkflow,
      workflowPaneRef,
      workflowExecutionId,
      workflowChatMode,
      runWorkflow,
      stopWorkflow,
      workflowChatSend,
      toggleAgent,
      toggleWorkflow,
      openContainerPort,
      openDockerLogs,
      openDockerExec,
      openTabs,
      activeTabKey,
      activeTab,
      rootPath,
      leftPaneVisible,
      centerPaneVisible,
      rightPaneVisible,
      bottomPaneVisible,
      bottomPaneTab,
      apiTabs,
      activeApiTab,
      openApiTest,
      closeApiTab,
      leftPaneWidth,
      rightPaneWidth,
      bottomPaneHeight,
      startResize,
      searchMode,
      gitMode,
      searchQuery,
      searchPath,
      searchResults,
      qmdIndexing,
      qmdSearching,
      terminalTabs,
      activeTerminalTab,
      createNewTerminalTab,
      closeTerminalTab,
      switchTerminalTab,
      MARKDOWN_EXTS,
      highlightPath,
      loadTabContent,
      switchTab,
      onTabContextMenu,
      getIconColor,
      closeTab,
      closeOtherTabs,
      closeAllTabs,
      activeBreadcrumbs,
      saveActiveTab,
      activeEditorComponent,
      markActiveTabDirty,
      viewInFinder,
      openWithEditor,
      saveTab,
      onFileSelected,
      onOpenDiff,
      editorRef,
      fileTreeRef,
      tabContextMenu,
      editorMenu,
      editorDropdownRef,
      createNewUntitledTab,
      agentPaneRef,
      onNewAgentTab,
      onEditAgent,
      onAgentFormSaved,
      estimatedTokens,
      injectMenu,
      onEditorContextMenu,
      doInjectVariable,
    };
  },
});
</script>

<style scoped>
.page-root {
  background: #ffffff;
  color: #0d0d0d;
}

.page-root.dark {
  background: #0f172a;
  color: #fafafa;
}

.editor-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #ffffff;
  position: relative;
}

.editor-panel.dark {
  background: #1e293b;
}

.editor-top {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.editor-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.editor-bottom {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid #cbd5e1;
  overflow: hidden;
  background: #f8fafc;
}

.editor-bottom.dark {
  border-top-color: #3c3c3c;
  background: #1e293b;
}

.right-pane {
  flex-shrink: 0;
  border-left: 1px solid #cbd5e1;
  border-right: 1px solid #cbd5e1;
  overflow: hidden;
  background: #f8fafc;
}

.right-pane.dark {
  border-left-color: #3c3c3c;
  border-right-color: #3c3c3c;
  background: #1e293b;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #999;
}

.empty-icon {
  opacity: 0.3;
}

.dark .empty-icon {
  opacity: 0.2;
}

.empty-icon-img {
  width: 48px;
  height: 48px;
  object-fit: contain;
}

.empty-text {
  font-size: 14px;
  color: #666;
}

.dark .empty-text {
  color: #888;
}

.empty-hint {
  font-size: 12px;
  color: #999;
}

.error-text {
  font-size: 13px;
  color: #e53e3e;
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid rgba(0, 0, 0, 0.1);
  border-top-color: #0078d4;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.dark .loading-spinner {
  border-color: rgba(255, 255, 255, 0.1);
  border-top-color: #0078d4;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Tab bar */
.tab-bar {
  display: flex;
  align-items: stretch;
  height: 35px;
  background: #f8fafc;
  border-bottom: 1px solid #cbd5e1;
  flex-shrink: 0;
  position: relative;
}

.tab-bar::-webkit-scrollbar {
  height: 0;
}

.tab-bar.empty {
  border-bottom: none;
  background: #ffffff;
}

.tab-bar.empty.dark {
  background: #0f172a;
}

.tab-bar.dark {
  background: #1e293b;
  border-bottom-color: #3c3c3c;
}

.tab-bar-tabs {
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  overflow-y: hidden;
  flex: 1;
  min-width: 0;
}

.tab-bar-tabs::-webkit-scrollbar {
  height: 0;
}

.tab-bar-actions {
  display: flex;
  align-items: center;
  padding: 0 4px;
  flex-shrink: 0;
}

.tab-bar-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: #666;
  border-radius: 4px;
  cursor: pointer;
}

.tab-bar-action-btn:hover {
  background: rgba(0,0,0,0.06);
  color: #333;
}

.tab-bar-action-btn.dark {
  color: #999;
}

.tab-bar-action-btn.dark:hover {
  background: rgba(255,255,255,0.08);
  color: #ccc;
}

.editor-dropdown {
  position: absolute;
  top: 35px;
  right: 4px;
  min-width: 160px;
  background: #fff;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.12);
  z-index: 100;
  padding: 4px 0;
}

.editor-dropdown.dark {
  background: #1e293b;
  border-color: #3c3c3c;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.editor-dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: #333;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.editor-dropdown-item:hover {
  background: #f1f5f9;
}

.editor-dropdown-item.dark {
  color: #ccc;
}

.editor-dropdown-item.dark:hover {
  background: #334155;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  font-size: 13px;
  color: #333;
  border-right: 1px solid #cbd5e1;
  background: #eef2f6;
  cursor: pointer;
  flex-shrink: 0;
  max-width: 200px;
  user-select: none;
}

.tab:hover {
  background: #e8ecf0;
}

.tab.dark {
  color: #999;
  border-right-color: #3c3c3c;
  background: #2d2d2d;
}

.tab.dark:hover {
  background: #323232;
  color: #ccc;
}

.tab.active {
  background: #ffffff;
  color: #333;
  border-bottom: 1px solid #ffffff;
  margin-bottom: -1px;
}

.tab.active.dark {
  background: #0f172a;
  border-bottom-color: #0f172a;
  color: #ccc;
}

.tab-icon {
  display: flex;
  align-items: center;
}

.tab-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-dirty-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #0078d4;
  flex-shrink: 0;
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  color: #999;
  margin-left: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.1s;
}

.tab:hover .tab-close {
  opacity: 1;
}

.tab.active .tab-close {
  opacity: 0.6;
}

.tab.active:hover .tab-close,
.tab-close:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.1);
}

.dark .tab-close:hover {
  background: rgba(255, 255, 255, 0.1);
}

/* Editor header (breadcrumb + save button) */
.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  font-size: 12px;
  color: #888;
  background: #ffffff;
  border-bottom: 1px solid #cbd5e1;
  flex-shrink: 0;
}

.editor-header.dark {
  background: #0f172a;
  color: #888;
  border-bottom-color: #2d2d2d;
}

.save-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: #ffffff;
  background: #0078d4;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.1s;
}

.save-button:hover:not(:disabled) {
  background: #106ebe;
}

.save-button:active:not(:disabled) {
  background: #005a9e;
}

.save-button:disabled {
  background: #cccccc;
  cursor: not-allowed;
}

.save-button.dark {
  color: #ffffff;
  background: #0078d4;
}

.save-button.dark:hover:not(:disabled) {
  background: #106ebe;
}

.save-button.dark:active:not(:disabled) {
  background: #005a9e;
}

.save-button.dark:disabled {
  background: #666666;
  color: #cccccc;
}

.breadcrumb-segment {
  white-space: nowrap;
}

.breadcrumb-sep {
  margin: 0 4px;
  color: #aaa;
}

.token-estimate {
  font-size: 11px;
  color: #94a3b8;
  margin-left: auto;
  margin-right: 8px;
  white-space: nowrap;
  flex-shrink: 0;
}

.token-estimate.dark {
  color: #64748b;
}

<style scoped>
.page-root {
  background: #ffffff;
  color: #0d0d0d;
}

.main-content {
  display: flex;
  height: 100%;
}

/* Resize handles */
.resize-handle {
  flex-shrink: 0;
  background: transparent;
  position: relative;
  z-index: 10;
}

.resize-handle-v {
  width: 5px;
  cursor: col-resize;
  margin: 0 -2px;
}

.resize-handle-h {
  height: 5px;
  cursor: row-resize;
  margin: -2px 0;
}

.resize-handle:hover,
.resize-handle:active {
  background: #0078d4;
  opacity: 0.5;
}

.resize-handle:active {
  opacity: 0.8;
}

.resize-handle.dark:hover,
.resize-handle.dark:active {
  background: #4fa3e0;
}

.pane-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: #94a3b8;
  border-radius: 4px;
  cursor: pointer;
}

.pane-close-btn:hover {
  background: rgba(0,0,0,0.06);
  color: #475569;
}

.pane-close-btn.dark {
  color: #64748b;
}

.pane-close-btn.dark:hover {
  background: rgba(255,255,255,0.08);
  color: #94a3b8;
}

.left-pane {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #cbd5e1;
}

.file-tree-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.git-container {
  padding: 12px;
}

/* Inject Variable context menu */
.inject-menu {
  position: fixed;
  z-index: 10000;
  min-width: 240px;
  max-height: 400px;
  overflow-y: auto;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 4px 0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
}

.inject-menu.dark {
  background: #2d2d2d;
  border-color: #404040;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.inject-menu-header {
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: #64748b;
}

.inject-menu.dark .inject-menu-header {
  color: #94a3b8;
}

.inject-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: none;
  color: #333;
  cursor: pointer;
  text-align: left;
  line-height: 1.3;
}

.inject-menu-item:hover {
  background: #f1f5f9;
}

.inject-menu-item.dark {
  color: #ccc;
}

.inject-menu-item.dark:hover {
  background: #383838;
}

.inject-var-label {
  flex: 1;
  min-width: 0;
}

.inject-var-key {
  font-size: 11px;
  font-family: monospace;
  color: #94a3b8;
  flex-shrink: 0;
}

.inject-menu.dark .inject-var-key {
  color: #64748b;
}

.git-change {
  padding: 4px 0;
  font-size: 13px;
  color: #333;
  cursor: pointer;
}

.dark .git-change {
  color: #ccc;
}

/* ── Workflow save bar ── */
.workflow-save-bar {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(8px);
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  font-size: 11px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.workflow-save-bar.dark {
  background: rgba(30, 41, 59, 0.85);
  border-color: #3c3c5c;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.workflow-save-status {
  display: flex;
  align-items: center;
  gap: 4px;
  font-weight: 500;
  white-space: nowrap;
}

.workflow-save-status.saving {
  color: #6366f1;
}

.workflow-save-status.saved {
  color: #22c55e;
}

.workflow-save-status.unsaved {
  color: #f59e0b;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.workflow-save-spinner {
  animation: spin 0.8s linear infinite;
}

.workflow-save-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  background: #fff;
  color: #475569;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}

.workflow-save-btn:hover {
  background: #f1f5f9;
  border-color: #6366f1;
  color: #6366f1;
}

.workflow-save-btn.dark {
  background: #2d2d44;
  border-color: #3c3c5c;
  color: #94a3b8;
}

.workflow-save-btn.dark:hover {
  background: #33334e;
  border-color: #6366f1;
  color: #818cf8;
}

.workflow-save-divider {
  width: 1px;
  height: 18px;
  background: #e2e8f0;
  margin: 0 2px;
}

.workflow-save-divider.dark {
  background: #3c3c5c;
}

.workflow-enable-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  border: 1px solid #94a3b8;
  background: transparent;
  color: #64748b;
  transition: all 0.15s;
}

.workflow-enable-btn:hover {
  background: rgba(0,0,0,0.04);
  color: #475569;
}

.workflow-enable-btn.dark {
  border-color: #475569;
  color: #94a3b8;
}

.workflow-enable-btn.dark:hover {
  background: rgba(255,255,255,0.06);
  color: #cbd5e1;
}

.workflow-enable-btn.enabled {
  background: #22c55e;
  color: #fff;
  border-color: #16a34a;
}

.workflow-enable-btn.enabled:hover {
  background: #16a34a;
}

.workflow-enable-btn.enabled.dark {
  background: #166534;
  border-color: #22c55e;
  color: #bbf7d0;
}

.workflow-enable-btn.enabled.dark:hover {
  background: #15803d;
}

.workflow-run-btn,
.workflow-stop-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  border: 1px solid transparent;
  transition: all 0.15s;
}

.workflow-run-btn {
  background: #22c55e;
  color: #fff;
  border-color: #16a34a;
}

.workflow-run-btn:hover {
  background: #16a34a;
}

.workflow-run-btn.dark {
  background: #166534;
  border-color: #22c55e;
  color: #bbf7d0;
}

.workflow-run-btn.dark:hover {
  background: #15803d;
}

.workflow-stop-btn {
  background: #ef4444;
  color: #fff;
  border-color: #dc2626;
}

.workflow-stop-btn:hover {
  background: #dc2626;
}

.workflow-stop-btn.dark {
  background: #7f1d1d;
  border-color: #ef4444;
  color: #fecaca;
}

.workflow-stop-btn.dark:hover {
  background: #991b1b;
}

.workflow-settings-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.workflow-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}

.workflow-settings-panel.dark .workflow-settings-header {
  border-bottom-color: #3c3c5c;
}

.workflow-settings-title {
  font-weight: 600;
  font-size: 13px;
  color: #1e293b;
}

.workflow-settings-panel.dark .workflow-settings-title {
  color: #e2e8f0;
}

.workflow-settings-close {
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px;
  color: #64748b;
  border-radius: 4px;
}

.workflow-settings-close:hover {
  background: #f1f5f9;
  color: #334155;
}

.workflow-settings-panel.dark .workflow-settings-close:hover {
  background: #2d2d44;
  color: #e2e8f0;
}

.workflow-settings-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
}

.workflow-settings-label {
  font-size: 12px;
  font-weight: 500;
  color: #475569;
  margin-top: 4px;
}

.workflow-settings-panel.dark .workflow-settings-label {
  color: #94a3b8;
}

.workflow-settings-input,
.workflow-settings-textarea {
  width: 100%;
  padding: 6px 8px;
  font-size: 13px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #fff;
  color: #1e293b;
  outline: none;
  font-family: inherit;
  box-sizing: border-box;
}

.workflow-settings-input:focus,
.workflow-settings-textarea:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

.workflow-settings-input.dark,
.workflow-settings-textarea.dark {
  background: #1e1e2e;
  border-color: #3c3c5c;
  color: #e2e8f0;
}

.workflow-settings-input.dark:focus,
.workflow-settings-textarea.dark:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
}

.workflow-settings-textarea {
  resize: vertical;
  min-height: 60px;
}

.workflow-settings-danger-zone {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid #e2e8f0;
}

.workflow-settings-panel.dark .workflow-settings-danger-zone {
  border-top-color: #3c3c5c;
}

.workflow-delete-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  background: #fef2f2;
  color: #dc2626;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.workflow-delete-btn:hover {
  background: #fee2e2;
  border-color: #f87171;
}

.workflow-delete-btn.dark {
  background: #451a1a;
  border-color: #7f1d1d;
  color: #f87171;
}

.workflow-delete-btn.dark:hover {
  background: #5a2020;
  border-color: #ef4444;
}
</style>

<style scoped>
.terminal-tabs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  height: 35px;
  background: #f8fafc;
  border-bottom: 1px solid #cbd5e1;
  flex-shrink: 0;
}

.terminal-tabs-header.dark {
  background: #1e293b;
  border-bottom-color: #3c3c3c;
}

.terminal-tabs {
  display: flex;
  gap: 4px;
}

.terminal-tab {
  padding: 0 12px;
  height: 28px;
  display: flex;
  align-items: center;
  background: #eef2f6;
  border-radius: 4px 4px 0 0;
  cursor: pointer;
  font-size: 13px;
  color: #333;
}

.terminal-tab:hover {
  background: #e8ecf0;
}

.terminal-tab.active {
  background: #ffffff;
  color: #333;
  border-bottom: 1px solid #ffffff;
  margin-bottom: -1px;
}

.dark .terminal-tab {
  background: #2d2d2d;
  color: #999;
}

.dark .terminal-tab:hover {
  background: #323232;
  color: #ccc;
}

.dark .terminal-tab.active {
  background: #0f172a;
  border-bottom-color: #0f172a;
  color: #ccc;
}

.terminal-tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: 6px;
  padding: 2px;
  border: none;
  background: none;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.1s;
}

.terminal-tab-close:hover {
  opacity: 1;
}

.terminal-tab-close.dark {
  color: #ccc;
}

.terminal-tab-add {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: none;
  background: none;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.1s;
  color: #666;
}

.terminal-tab-add:hover {
  opacity: 1;
}

.terminal-tab-add.dark {
  color: #ccc;
}

.terminal-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.terminal-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.add-terminal-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: #0078d4;
  color: white;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.add-terminal-btn:hover {
  background: #005a9e;
}

.close-tab-btn {
  margin-left: auto;
  border: none;
  background: none;
  color: #999;
  cursor: pointer;
  font-size: 14px;
  padding: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
}

.close-tab-btn:hover {
  color: #fff;
  background: #d32f2f;
}

.terminal-container {
  flex: 1;
  overflow: hidden;
}

.terminal-wrapper {
  width: 100%;
  height: 100%;
}

.terminal-wrapper .xterm {
  height: 100%;
}
</style>
