<template>
  <div class="git-pane" :class="{ dark: isDark }">
    <!-- Header -->
    <div class="git-header" :class="{ dark: isDark }">
      <span class="git-header-title">Source Control</span>
      <div class="git-header-actions">
        <button class="git-header-btn" :class="{ dark: isDark, active: treeView }" @click="treeView = !treeView" title="Toggle Tree View">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            <line x1="10" y1="12" x2="10" y2="18"/>
            <line x1="10" y1="18" x2="16" y2="18"/>
            <line x1="10" y1="15" x2="16" y2="15"/>
          </svg>
        </button>
        <button class="git-header-btn" :class="{ dark: isDark }" @click="discoverAndRefresh" title="Refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- No repos found -->
    <div v-if="!loading && repoStates.length === 0" class="git-empty">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
        <circle cx="12" cy="12" r="10"/>
        <line x1="15" y1="9" x2="9" y2="15"/>
        <line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
      <span class="git-empty-text">No Git repositories found</span>
    </div>

    <!-- Scanning -->
    <div v-else-if="loading && repoStates.length === 0" class="git-empty">
      <span class="git-empty-text">Scanning for repositories...</span>
    </div>

    <!-- Repo trees -->
    <div v-else class="git-repos-list">
      <div v-for="repo in repoStates" :key="repo.root" class="git-repo-node">
        <!-- Repo root row (collapsible) -->
        <button class="git-repo-header" :class="{ dark: isDark }" @click="repo.open = !repo.open">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" :class="{ rotated: repo.open }">
            <path d="M3 1l4 4-4 4z"/>
          </svg>
          <!-- Git logo -->
          <svg width="14" height="14" viewBox="0 0 92 92" class="git-repo-icon">
            <path d="M90.156 41.965 50.036 1.848a5.913 5.913 0 0 0-8.368 0l-8.332 8.332 10.566 10.566a7.03 7.03 0 0 1 7.23 1.684 7.043 7.043 0 0 1 1.673 7.277l10.183 10.184a7.026 7.026 0 0 1 7.278 1.672 7.04 7.04 0 0 1 0 9.957 7.045 7.045 0 0 1-9.961 0 7.06 7.06 0 0 1-1.496-7.665l-9.5-9.497V55.57a7.078 7.078 0 0 1 1.91 1.318 7.044 7.044 0 0 1 0 9.957 7.045 7.045 0 0 1-9.961 0 7.04 7.04 0 0 1 0-9.957 7.09 7.09 0 0 1 2.188-1.529V34.14a7.044 7.044 0 0 1-3.821-11.593L29.242 12.17 1.73 39.678a5.918 5.918 0 0 0 0 8.371l40.12 40.116a5.916 5.916 0 0 0 8.369 0l39.937-39.829a5.917 5.917 0 0 0 0-8.371z" fill="#F05032"/>
          </svg>
          <span class="git-repo-name">{{ repo.name }}</span>
          <span class="git-repo-branch-inline" :class="{ dark: isDark }" @click.stop="openBranchModal(repo)">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="6" y1="3" x2="6" y2="15"/>
              <circle cx="18" cy="6" r="3"/>
              <circle cx="6" cy="18" r="3"/>
              <path d="M18 9a9 9 0 0 1-9 9"/>
            </svg>
            {{ repo.branch || '...' }}
          </span>
          <span class="git-repo-actions" @click.stop>
            <button class="git-repo-action-btn" :class="{ dark: isDark }" title="Refresh" @click="refreshRepo(repo)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="23 4 23 10 17 10"/>
                <polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </button>
            <button class="git-repo-action-btn" :class="{ dark: isDark }" title="More actions" @click="toggleRepoMenu(repo)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="2"/>
                <circle cx="12" cy="12" r="2"/>
                <circle cx="12" cy="19" r="2"/>
              </svg>
            </button>
          </span>
        </button>

        <!-- Repo action menu dropdown -->
        <div v-if="repoMenu.visible && repoMenu.repo === repo" class="git-repo-menu" :class="{ dark: isDark }">
          <button class="git-repo-menu-item" :class="{ dark: isDark }" @click="repoAction(repo, 'pull')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="8 17 12 21 16 17"/>
              <line x1="12" y1="12" x2="12" y2="21"/>
              <path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/>
            </svg>
            <span>Pull</span>
          </button>
          <button class="git-repo-menu-item" :class="{ dark: isDark }" @click="repoAction(repo, 'push')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="16 16 12 12 8 16"/>
              <line x1="12" y1="12" x2="12" y2="21"/>
              <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
            </svg>
            <span>Push</span>
          </button>
          <button class="git-repo-menu-item" :class="{ dark: isDark }" @click="repoAction(repo, 'fetch')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>Fetch</span>
          </button>
          <div class="git-repo-menu-divider" :class="{ dark: isDark }"></div>
          <button class="git-repo-menu-item" :class="{ dark: isDark }" @click="repoAction(repo, 'stash')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <polyline points="17 21 17 13 7 13 7 21"/>
              <polyline points="7 3 7 8 15 8"/>
            </svg>
            <span>Stash</span>
          </button>
          <button class="git-repo-menu-item" :class="{ dark: isDark }" @click="repoAction(repo, 'stash-pop')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <line x1="9" y1="15" x2="15" y2="15"/>
            </svg>
            <span>Stash Pop</span>
          </button>
          <div class="git-repo-menu-divider" :class="{ dark: isDark }"></div>
          <button class="git-repo-menu-item danger" :class="{ dark: isDark }" @click="repoAction(repo, 'discard-all')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            <span>Discard All Changes</span>
          </button>
        </div>

        <!-- Expanded repo content -->
        <div v-show="repo.open" class="git-repo-content">
          <!-- Commit input -->
          <div v-if="repoStaged(repo).length > 0" class="git-commit-bar" :class="{ dark: isDark }">
            <input
              v-model="repo.commitMessage"
              class="git-commit-input"
              :class="{ dark: isDark }"
              placeholder="Commit message"
              @keydown.enter="doCommit(repo)"
            />
            <button
              class="git-commit-btn"
              :class="{ dark: isDark }"
              :disabled="!repo.commitMessage.trim()"
              @click="doCommit(repo)"
              title="Commit staged changes"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </button>
          </div>

          <!-- Staged Changes -->
          <template v-if="repoStaged(repo).length > 0">
            <button class="git-section-header" :class="{ dark: isDark }" @click="repo.stagedOpen = !repo.stagedOpen">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" :class="{ rotated: repo.stagedOpen }">
                <path d="M3 1l4 4-4 4z"/>
              </svg>
              <span>Staged Changes</span>
              <span class="git-section-count">{{ repoStaged(repo).length }}</span>
            </button>
            <div v-show="repo.stagedOpen" class="git-file-list">
              <!-- List view -->
              <template v-if="!treeView">
                <div
                  v-for="f in repoStaged(repo)"
                  :key="'s-' + repo.root + f.file"
                  class="git-file-row"
                  :class="{ dark: isDark }"
                  @click="openFile(repo, f.file, true)"
                  @contextmenu.prevent="showFileContextMenu($event, repo, f.file, true)"
                >
                  <span class="git-status-badge staged">{{ f.index }}</span>
                  <span class="git-file-name">{{ basename(f.file) }}</span>
                  <span class="git-file-path">{{ dirname(f.file) }}</span>
                  <button class="git-file-action" :class="{ dark: isDark }" title="Unstage" @click.stop="unstage(repo, f.file)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                  </button>
                </div>
              </template>
              <!-- Tree view -->
              <template v-else>
                <git-tree-nodes
                  :nodes="buildTree(repoStaged(repo))"
                  :repo="repo"
                  section="staged"
                  badge-type="staged"
                  action-type="unstage"
                  :depth="0"
                  :is-dark="isDark"
                  @open-file="openFile(repo, $event, true)"
                  @stage="stage(repo, $event)"
                  @unstage="unstage(repo, $event)"
                  @contextmenu="(ev: MouseEvent, file: string) => showFileContextMenu(ev, repo, file, true)"
                />
              </template>
            </div>
          </template>

          <!-- Changes (modified/deleted) -->
          <template v-if="repoChanged(repo).length > 0">
            <button class="git-section-header" :class="{ dark: isDark }" @click="repo.changesOpen = !repo.changesOpen">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" :class="{ rotated: repo.changesOpen }">
                <path d="M3 1l4 4-4 4z"/>
              </svg>
              <span>Changes</span>
              <span class="git-section-count">{{ repoChanged(repo).length }}</span>
            </button>
            <div v-show="repo.changesOpen" class="git-file-list">
              <!-- List view -->
              <template v-if="!treeView">
                <div
                  v-for="f in repoChanged(repo)"
                  :key="'c-' + repo.root + f.file"
                  class="git-file-row"
                  :class="{ dark: isDark }"
                  @click="openFile(repo, f.file)"
                  @contextmenu.prevent="showFileContextMenu($event, repo, f.file, false)"
                >
                  <span class="git-status-badge" :class="statusClass(f.worktree)">{{ f.worktree }}</span>
                  <span class="git-file-name">{{ basename(f.file) }}</span>
                  <span class="git-file-path">{{ dirname(f.file) }}</span>
                  <button class="git-file-action" :class="{ dark: isDark }" title="Stage" @click.stop="stage(repo, f.file)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                  </button>
                </div>
              </template>
              <!-- Tree view -->
              <template v-else>
                <git-tree-nodes
                  :nodes="buildTree(repoChanged(repo))"
                  :repo="repo"
                  section="changes"
                  badge-type="worktree"
                  action-type="stage"
                  :depth="0"
                  :is-dark="isDark"
                  @open-file="openFile(repo, $event)"
                  @stage="stage(repo, $event)"
                  @unstage="unstage(repo, $event)"
                  @contextmenu="(ev: MouseEvent, file: string) => showFileContextMenu(ev, repo, file, false)"
                />
              </template>
            </div>
          </template>

          <!-- Untracked Files -->
          <template v-if="repoUntracked(repo).length > 0">
            <button class="git-section-header" :class="{ dark: isDark }" @click="repo.untrackedOpen = !repo.untrackedOpen">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" :class="{ rotated: repo.untrackedOpen }">
                <path d="M3 1l4 4-4 4z"/>
              </svg>
              <span>Untracked Files</span>
              <span class="git-section-count">{{ repoUntracked(repo).length }}</span>
            </button>
            <div v-show="repo.untrackedOpen" class="git-file-list">
              <!-- List view -->
              <template v-if="!treeView">
                <div
                  v-for="f in repoUntracked(repo)"
                  :key="'u-' + repo.root + f.file"
                  class="git-file-row"
                  :class="{ dark: isDark }"
                  @click="openFile(repo, f.file)"
                  @contextmenu.prevent="showFileContextMenu($event, repo, f.file, false)"
                >
                  <span class="git-status-badge untracked">?</span>
                  <span class="git-file-name">{{ basename(f.file) }}</span>
                  <span class="git-file-path">{{ dirname(f.file) }}</span>
                  <button class="git-file-action" :class="{ dark: isDark }" title="Stage" @click.stop="stage(repo, f.file)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                  </button>
                </div>
              </template>
              <!-- Tree view -->
              <template v-else>
                <git-tree-nodes
                  :nodes="buildTree(repoUntracked(repo))"
                  :repo="repo"
                  section="untracked"
                  badge-type="untracked"
                  action-type="stage"
                  :depth="0"
                  :is-dark="isDark"
                  @open-file="openFile(repo, $event)"
                  @stage="stage(repo, $event)"
                  @unstage="unstage(repo, $event)"
                  @contextmenu="(ev: MouseEvent, file: string) => showFileContextMenu(ev, repo, file, false)"
                />
              </template>
            </div>
          </template>

          <!-- Clean state for this repo -->
          <div v-if="totalChanges(repo) === 0" class="git-repo-clean" :class="{ dark: isDark }">
            <span>No changes</span>
          </div>
        </div>
      </div>
    </div>
    <!-- File context menu -->
    <teleport to="body">
      <div
        v-if="fileCtx.visible"
        class="git-file-ctx-overlay"
        @click="closeFileContextMenu"
        @contextmenu.prevent="closeFileContextMenu"
      >
        <div
          class="git-file-ctx-menu"
          :class="{ dark: isDark }"
          :style="{ left: fileCtx.x + 'px', top: fileCtx.y + 'px' }"
        >
          <button class="git-file-ctx-item" :class="{ dark: isDark }" @click="ctxOpen">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span>Open</span>
          </button>
          <button class="git-file-ctx-item" :class="{ dark: isDark }" @click="ctxOpenChanges">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="3" width="8" height="18" rx="1"/>
              <rect x="14" y="3" width="8" height="18" rx="1"/>
            </svg>
            <span>Open Changes</span>
          </button>
          <div class="git-file-ctx-divider" :class="{ dark: isDark }"></div>
          <button class="git-file-ctx-item" :class="{ dark: isDark }" @click="ctxReveal">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span>Reveal in Explorer</span>
          </button>
          <div class="git-file-ctx-divider" :class="{ dark: isDark }"></div>
          <button class="git-file-ctx-item" :class="{ dark: isDark }" @click="ctxAddGitignore">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
            </svg>
            <span>Add to .gitignore</span>
          </button>
        </div>
      </div>
    </teleport>

    <!-- Branch modal overlay -->
    <teleport to="body">
      <div v-if="branchModal.visible" class="git-branch-overlay" @click.self="closeBranchModal">
        <div class="git-branch-modal" :class="{ dark: isDark }">
          <!-- Search / Create input -->
          <div class="git-branch-modal-input-row">
            <input
              ref="branchInputRef"
              v-model="branchModal.query"
              class="git-branch-modal-input"
              :class="{ dark: isDark }"
              placeholder="Switch to or create branch..."
              @keydown.enter="onBranchInputEnter"
              @keydown.escape="closeBranchModal"
            />
          </div>

          <!-- Create new branch option (shown when query doesn't match existing) -->
          <button
            v-if="branchModal.query.trim() && !filteredBranches.some(b => b.name === branchModal.query.trim())"
            class="git-branch-modal-row create-row"
            :class="{ dark: isDark }"
            @click="createBranch"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            <span>Create branch: <strong>{{ branchModal.query.trim() }}</strong></span>
          </button>

          <!-- Error message -->
          <div v-if="branchModal.error" class="git-branch-modal-error">{{ branchModal.error }}</div>

          <!-- Branch list -->
          <div class="git-branch-modal-list">
            <button
              v-for="b in filteredBranches"
              :key="b.name"
              class="git-branch-modal-row"
              :class="{ dark: isDark, active: b.current }"
              @click="switchBranch(b.name)"
            >
              <svg v-if="b.current" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <svg v-else-if="b.remote" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5">
                <circle cx="12" cy="12" r="10"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
              <span v-else style="width:14px; display:inline-block"></span>
              <span class="git-branch-modal-name">{{ b.name }}</span>
              <span v-if="b.remote && !b.current" class="git-branch-modal-remote">remote</span>
            </button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { ipcRenderer } from 'electron';
import GitTreeNodes from './GitTreeNodes.vue';
import type { FileEntry } from '../filesystem/FileTreeSidebar.vue';

interface GitStatusEntry {
  index: string;
  worktree: string;
  file: string;
}

interface RepoState {
  root: string;
  name: string;
  branch: string;
  entries: GitStatusEntry[];
  open: boolean;
  stagedOpen: boolean;
  changesOpen: boolean;
  untrackedOpen: boolean;
  commitMessage: string;
}

const props = defineProps<{
  rootPath: string;
  isDark: boolean;
}>();

const emit = defineEmits<{
  'file-selected': [entry: FileEntry];
  'open-diff': [repoRoot: string, file: string, staged: boolean];
}>();

const loading = ref(false);
const repoStates = ref<RepoState[]>([]);
const treeView = ref(false);

// ─── Tree view helpers ───────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string; // relative path from repo root
  isDir: boolean;
  children: TreeNode[];
  entry?: GitStatusEntry; // leaf file nodes have this
}

function buildTree(entries: GitStatusEntry[]): TreeNode[] {
  const root: Record<string, any> = {};

  for (const entry of entries) {
    const parts = entry.file.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current[part]) {
        current[part] = { __children: {}, __entry: undefined, __path: parts.slice(0, i + 1).join('/') };
      }
      if (i === parts.length - 1) {
        current[part].__entry = entry;
      }
      current = current[part].__children;
    }
  }

  function toNodes(obj: Record<string, any>): TreeNode[] {
    return Object.keys(obj).sort((a, b) => {
      // Dirs first, then files
      const aIsDir = Object.keys(obj[a].__children).length > 0;
      const bIsDir = Object.keys(obj[b].__children).length > 0;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.localeCompare(b);
    }).map(key => {
      const node = obj[key];
      const children = toNodes(node.__children);
      return {
        name:     key,
        path:     node.__path,
        isDir:    children.length > 0,
        children,
        entry:    node.__entry,
      };
    });
  }

  // Collapse single-child directories (e.g. src/components -> src/components)
  function collapse(nodes: TreeNode[]): TreeNode[] {
    return nodes.map(n => {
      n.children = collapse(n.children);
      if (n.isDir && n.children.length === 1 && n.children[0].isDir) {
        const child = n.children[0];
        return { ...child, name: n.name + '/' + child.name };
      }
      return n;
    });
  }

  return collapse(toNodes(root));
}


// ─── Filters ────────────────────────────────────────────────────

function repoStaged(repo: RepoState): GitStatusEntry[] {
  return repo.entries.filter(e => e.index !== ' ' && e.index !== '?');
}

function repoChanged(repo: RepoState): GitStatusEntry[] {
  return repo.entries.filter(e => e.index !== '?' && e.worktree !== ' ' && e.worktree !== '?');
}

function repoUntracked(repo: RepoState): GitStatusEntry[] {
  return repo.entries.filter(e => e.index === '?');
}

function totalChanges(repo: RepoState): number {
  return repo.entries.length;
}

// ─── Helpers ────────────────────────────────────────────────────

function basename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1];
}

function dirname(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

function statusClass(code: string): string {
  switch (code) {
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'A': return 'added';
    case 'R': return 'renamed';
    default:  return 'modified';
  }
}

// ─── Data fetching ──────────────────────────────────────────────

async function discoverAndRefresh() {
  if (!props.rootPath) return;
  loading.value = true;
  try {
    const discovered: Array<{ root: string; name: string }> = await ipcRenderer.invoke('git-discover-repos', props.rootPath);

    // Preserve existing UI state (open/closed) for repos we already know about
    const existingMap = new Map(repoStates.value.map(r => [r.root, r]));

    const newStates: RepoState[] = discovered.map(d => {
      const existing = existingMap.get(d.root);
      return reactive({
        root:           d.root,
        name:           d.name,
        branch:         existing?.branch || '',
        entries:        existing?.entries || [],
        open:           existing?.open ?? true,
        stagedOpen:     existing?.stagedOpen ?? true,
        changesOpen:    existing?.changesOpen ?? true,
        untrackedOpen:  existing?.untrackedOpen ?? true,
        commitMessage:  existing?.commitMessage || '',
      });
    });

    repoStates.value = newStates;

    // Fetch branch + status for all repos in parallel
    await Promise.all(newStates.map(repo => refreshRepo(repo)));
  } catch (err) {
    console.error('[GitPane] discover error:', err);
  } finally {
    loading.value = false;
  }
}

async function refreshRepo(repo: RepoState) {
  try {
    const [br, entries] = await Promise.all([
      ipcRenderer.invoke('git-branch', repo.root),
      ipcRenderer.invoke('git-status-full', repo.root),
    ]);
    repo.branch = br;
    repo.entries = entries;
  } catch (err) {
    console.error(`[GitPane] refreshRepo error for ${repo.name}:`, err);
  }
}

// ─── Actions ────────────────────────────────────────────────────

async function stage(repo: RepoState, file: string) {
  await ipcRenderer.invoke('git-stage', repo.root, [file]);
  await refreshRepo(repo);
}

async function unstage(repo: RepoState, file: string) {
  await ipcRenderer.invoke('git-unstage', repo.root, [file]);
  await refreshRepo(repo);
}

async function doCommit(repo: RepoState) {
  const msg = repo.commitMessage.trim();
  if (!msg) return;
  const ok = await ipcRenderer.invoke('git-commit', repo.root, msg);
  if (ok) {
    repo.commitMessage = '';
  }
  await refreshRepo(repo);
}

// ─── Repo menu (ellipsis dropdown) ───────────────────────────────

const repoMenu = reactive({
  visible: false,
  repo:    null as RepoState | null,
});

function toggleRepoMenu(repo: RepoState) {
  if (repoMenu.visible && repoMenu.repo === repo) {
    repoMenu.visible = false;
    repoMenu.repo = null;
  } else {
    repoMenu.visible = true;
    repoMenu.repo = repo;
  }
}

function closeRepoMenu() {
  repoMenu.visible = false;
  repoMenu.repo = null;
}

async function repoAction(repo: RepoState, action: string) {
  closeRepoMenu();
  let ipcChannel: string;
  switch (action) {
    case 'pull':        ipcChannel = 'git-pull'; break;
    case 'push':        ipcChannel = 'git-push'; break;
    case 'fetch':       ipcChannel = 'git-fetch'; break;
    case 'stash':       ipcChannel = 'git-stash'; break;
    case 'stash-pop':   ipcChannel = 'git-stash-pop'; break;
    case 'discard-all': ipcChannel = 'git-discard-all'; break;
    default: return;
  }
  try {
    await ipcRenderer.invoke(ipcChannel, repo.root);
  } catch (err) {
    console.error(`[GitPane] ${action} error:`, err);
  }
  await refreshRepo(repo);
}

// Close repo menu on outside click
function onDocumentClick() {
  if (repoMenu.visible) closeRepoMenu();
}
onMounted(() => document.addEventListener('click', onDocumentClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick));

function openFile(repo: RepoState, file: string, staged = false) {
  // Open diff view for changed files by default
  emit('open-diff', repo.root, file, staged);
}

function openFileRaw(repo: RepoState, file: string) {
  const fullPath = repo.root + '/' + file;
  const name = basename(file);
  const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
  emit('file-selected', { name, path: fullPath, isDir: false, size: 0, ext } as FileEntry);
}

// ─── File context menu ───────────────────────────────────────────

const fileCtx = reactive({
  visible: false,
  x: 0,
  y: 0,
  repo: null as RepoState | null,
  file: '',
  staged: false,
});

function showFileContextMenu(event: MouseEvent, repo: RepoState, file: string, staged: boolean) {
  fileCtx.x = event.clientX;
  fileCtx.y = event.clientY;
  fileCtx.repo = repo;
  fileCtx.file = file;
  fileCtx.staged = staged;
  fileCtx.visible = true;
}

function closeFileContextMenu() {
  fileCtx.visible = false;
}

function ctxOpen() {
  if (fileCtx.repo) openFileRaw(fileCtx.repo, fileCtx.file);
  closeFileContextMenu();
}

function ctxOpenChanges() {
  if (fileCtx.repo) {
    emit('open-diff', fileCtx.repo.root, fileCtx.file, fileCtx.staged);
  }
  closeFileContextMenu();
}

function ctxReveal() {
  if (fileCtx.repo) {
    const fullPath = fileCtx.repo.root + '/' + fileCtx.file;
    ipcRenderer.invoke('filesystem-reveal', fullPath);
  }
  closeFileContextMenu();
}

async function ctxAddGitignore() {
  if (fileCtx.repo) {
    await ipcRenderer.invoke('git-add-gitignore', fileCtx.repo.root, fileCtx.file);
    await refreshRepo(fileCtx.repo);
  }
  closeFileContextMenu();
}

// ─── Branch modal ────────────────────────────────────────────────

interface BranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
}

const branchInputRef = ref<HTMLInputElement | null>(null);
const branchModal = reactive({
  visible: false,
  repo:    null as RepoState | null,
  query:   '',
  error:   '',
  branches: [] as BranchInfo[],
});

const filteredBranches = computed(() => {
  const q = branchModal.query.trim().toLowerCase();
  if (!q) return branchModal.branches;
  return branchModal.branches.filter(b => b.name.toLowerCase().includes(q));
});

async function openBranchModal(repo: RepoState) {
  branchModal.repo = repo;
  branchModal.query = '';
  branchModal.error = '';
  branchModal.visible = true;
  branchModal.branches = await ipcRenderer.invoke('git-list-branches', repo.root);
  await nextTick();
  branchInputRef.value?.focus();
}

function closeBranchModal() {
  branchModal.visible = false;
  branchModal.repo = null;
  branchModal.query = '';
  branchModal.error = '';
  branchModal.branches = [];
}

async function switchBranch(name: string) {
  if (!branchModal.repo) return;
  const repo = branchModal.repo;
  const result = await ipcRenderer.invoke('git-checkout-branch', repo.root, name);
  if (!result.success) {
    branchModal.error = result.error;
    return;
  }
  closeBranchModal();
  await refreshRepo(repo);
}

async function createBranch() {
  const name = branchModal.query.trim();
  if (!name || !branchModal.repo) return;
  const repo = branchModal.repo;
  const result = await ipcRenderer.invoke('git-create-branch', repo.root, name);
  if (!result.success) {
    branchModal.error = result.error;
    return;
  }
  closeBranchModal();
  await refreshRepo(repo);
}

function onBranchInputEnter() {
  const q = branchModal.query.trim();
  if (!q) return;
  const exact = branchModal.branches.find(b => b.name === q);
  if (exact) {
    switchBranch(exact.name);
  } else {
    createBranch();
  }
}

watch(() => props.rootPath, () => discoverAndRefresh());
onMounted(() => discoverAndRefresh());
</script>

<style scoped>
.git-pane {
  flex: 1;
  overflow-y: auto;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
}

.git-pane.dark {
  background: #1e293b;
}

.git-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  flex-shrink: 0;
}

.git-header-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
}

.git-header.dark .git-header-title {
  color: #94a3b8;
}

.git-header-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
}

.git-header-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}

.git-header-btn.dark {
  color: #94a3b8;
}

.git-header-btn.dark:hover {
  background: rgba(255, 255, 255, 0.08);
}

.git-header-btn.active {
  color: #0078d4;
  background: rgba(0, 120, 212, 0.08);
}

.git-header-btn.dark.active {
  color: #60a5fa;
  background: rgba(96, 165, 250, 0.12);
}

.git-header-actions {
  display: flex;
  gap: 2px;
}

/* Repo list */
.git-repos-list {
  flex: 1;
}

/* Repo header (root node) */
.git-repo-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: transparent;
  font-size: 13px;
  font-weight: 600;
  color: #334155;
  cursor: pointer;
  text-align: left;
}

.git-repo-header:hover {
  background: rgba(0, 0, 0, 0.03);
}

.git-repo-header.dark {
  color: #e2e8f0;
}

.git-repo-header.dark:hover {
  background: rgba(255, 255, 255, 0.04);
}

.git-repo-header svg {
  transition: transform 0.15s;
  flex-shrink: 0;
}

.git-repo-header svg.rotated {
  transform: rotate(90deg);
}

.git-repo-icon {
  flex-shrink: 0;
}

.git-repo-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-repo-branch-inline {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: #64748b;
  padding: 1px 6px;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  margin-left: 4px;
  flex-shrink: 0;
}

.git-repo-branch-inline:hover {
  background: rgba(0, 0, 0, 0.06);
}

.git-repo-branch-inline.dark {
  color: #94a3b8;
}

.git-repo-branch-inline.dark:hover {
  background: rgba(255, 255, 255, 0.06);
}

/* Repo header action buttons (refresh + ellipsis) */
.git-repo-actions {
  display: flex;
  gap: 2px;
  margin-left: auto;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.1s;
}

.git-repo-header:hover .git-repo-actions {
  opacity: 1;
}

.git-repo-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
}

.git-repo-action-btn:hover {
  background: rgba(0, 0, 0, 0.08);
}

.git-repo-action-btn.dark {
  color: #94a3b8;
}

.git-repo-action-btn.dark:hover {
  background: rgba(255, 255, 255, 0.1);
}

/* Repo dropdown menu */
.git-repo-node {
  position: relative;
}

.git-repo-menu {
  position: absolute;
  right: 8px;
  top: 28px;
  z-index: 100;
  min-width: 180px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  padding: 4px 0;
}

.git-repo-menu.dark {
  background: #1e293b;
  border-color: #334155;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.git-repo-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  font-size: 13px;
  color: #333;
  cursor: pointer;
  text-align: left;
}

.git-repo-menu-item:hover {
  background: rgba(0, 0, 0, 0.04);
}

.git-repo-menu-item.dark {
  color: #e2e8f0;
}

.git-repo-menu-item.dark:hover {
  background: rgba(255, 255, 255, 0.06);
}

.git-repo-menu-item.danger {
  color: #dc2626;
}

.git-repo-menu-item.danger.dark {
  color: #f87171;
}

.git-repo-menu-divider {
  height: 1px;
  margin: 4px 0;
  background: #e2e8f0;
}

.git-repo-menu-divider.dark {
  background: #334155;
}

/* Repo content (indented) */
.git-repo-content {
  padding-left: 8px;
}

.git-repo-clean {
  padding: 6px 10px 6px 28px;
  font-size: 12px;
  color: #94a3b8;
}

/* Commit bar */
.git-commit-bar {
  display: flex;
  gap: 4px;
  padding: 4px 10px 6px;
}

.git-commit-input {
  flex: 1;
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  background: #fff;
  color: #333;
  outline: none;
  font-family: inherit;
}

.git-commit-input:focus {
  border-color: #0078d4;
}

.git-commit-input.dark {
  background: #0f172a;
  border-color: #334155;
  color: #e2e8f0;
}

.git-commit-input.dark:focus {
  border-color: #2563eb;
}

.git-commit-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 4px;
  background: #0078d4;
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
}

.git-commit-btn:hover:not(:disabled) {
  background: #106ebe;
}

.git-commit-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Section headers (Staged / Changes / Untracked) */
.git-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 10px;
  border: none;
  background: transparent;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
  cursor: pointer;
  text-align: left;
}

.git-section-header.dark {
  color: #94a3b8;
}

.git-section-header:hover {
  background: rgba(0, 0, 0, 0.03);
}

.git-section-header.dark:hover {
  background: rgba(255, 255, 255, 0.04);
}

.git-section-header svg {
  transition: transform 0.15s;
}

.git-section-header svg.rotated {
  transform: rotate(90deg);
}

.git-section-count {
  margin-left: auto;
  font-size: 10px;
  font-weight: 500;
  padding: 0 5px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.06);
  color: #64748b;
}

.dark .git-section-count {
  background: rgba(255, 255, 255, 0.08);
  color: #94a3b8;
}

/* File rows */
.git-file-list {
  padding: 0;
}

.git-file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 32px;
  font-size: 13px;
  cursor: pointer;
  color: #333;
}

.git-file-row:hover {
  background: rgba(0, 0, 0, 0.04);
}

.git-file-row.dark {
  color: #e2e8f0;
}

.git-file-row.dark:hover {
  background: rgba(255, 255, 255, 0.04);
}

.git-status-badge {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  font-family: monospace;
  border-radius: 3px;
}

.git-status-badge.staged   { color: #16a34a; background: rgba(22, 163, 74, 0.12); }
.git-status-badge.modified { color: #d97706; background: rgba(217, 119, 6, 0.12); }
.git-status-badge.deleted  { color: #dc2626; background: rgba(220, 38, 38, 0.12); }
.git-status-badge.added    { color: #16a34a; background: rgba(22, 163, 74, 0.12); }
.git-status-badge.renamed  { color: #2563eb; background: rgba(37, 99, 235, 0.12); }
.git-status-badge.untracked { color: #64748b; background: rgba(100, 116, 139, 0.12); }

.git-file-name {
  flex-shrink: 0;
  white-space: nowrap;
}

.git-file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: #94a3b8;
}

.git-file-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.1s;
}

.git-file-row:hover .git-file-action {
  opacity: 1;
}

.git-file-action:hover {
  background: rgba(0, 0, 0, 0.08);
}

.git-file-action.dark {
  color: #94a3b8;
}

.git-file-action.dark:hover {
  background: rgba(255, 255, 255, 0.1);
}

.git-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
}

.git-empty-text {
  font-size: 12px;
  color: #94a3b8;
}

/* Branch modal overlay */
.git-branch-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 80px;
  background: rgba(0, 0, 0, 0.35);
}

.git-branch-modal {
  width: 380px;
  max-height: 400px;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

.git-branch-modal.dark {
  background: #1e293b;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.git-branch-modal-input-row {
  padding: 8px;
  flex-shrink: 0;
}

.git-branch-modal-input {
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  background: #fff;
  color: #333;
  outline: none;
  font-family: inherit;
  box-sizing: border-box;
}

.git-branch-modal-input:focus {
  border-color: #0078d4;
}

.git-branch-modal-input.dark {
  background: #0f172a;
  border-color: #334155;
  color: #e2e8f0;
}

.git-branch-modal-input.dark:focus {
  border-color: #2563eb;
}

.git-branch-modal-error {
  padding: 4px 12px 6px;
  font-size: 11px;
  color: #dc2626;
}

.git-branch-modal-list {
  flex: 1;
  overflow-y: auto;
  padding-bottom: 4px;
}

.git-branch-modal-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  font-size: 13px;
  color: #333;
  cursor: pointer;
  text-align: left;
}

.git-branch-modal-row:hover {
  background: rgba(0, 0, 0, 0.04);
}

.git-branch-modal-row.dark {
  color: #e2e8f0;
}

.git-branch-modal-row.dark:hover {
  background: rgba(255, 255, 255, 0.06);
}

.git-branch-modal-row.active {
  font-weight: 600;
}

.git-branch-modal-row.create-row {
  color: #0078d4;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  padding-bottom: 8px;
  margin-bottom: 2px;
}

.git-branch-modal-row.create-row.dark {
  color: #60a5fa;
  border-bottom-color: rgba(255, 255, 255, 0.06);
}

.git-branch-modal-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-branch-modal-remote {
  font-size: 10px;
  color: #94a3b8;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.04);
}

.dark .git-branch-modal-remote {
  background: rgba(255, 255, 255, 0.06);
}

/* File context menu */
.git-file-ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 9998;
}

.git-file-ctx-menu {
  position: fixed;
  min-width: 180px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  padding: 4px 0;
  z-index: 9999;
}

.git-file-ctx-menu.dark {
  background: #1e293b;
  border-color: #334155;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.git-file-ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  font-size: 13px;
  color: #333;
  cursor: pointer;
  text-align: left;
}

.git-file-ctx-item:hover {
  background: rgba(0, 0, 0, 0.04);
}

.git-file-ctx-item.dark {
  color: #e2e8f0;
}

.git-file-ctx-item.dark:hover {
  background: rgba(255, 255, 255, 0.06);
}

.git-file-ctx-divider {
  height: 1px;
  margin: 4px 0;
  background: #e2e8f0;
}

.git-file-ctx-divider.dark {
  background: #334155;
}
</style>
