/**
 * Custom declarations for Electron IPC topics.
 */

import Electron from 'electron';
import semver from 'semver';

import type { ServiceEntry } from '@pkg/backend/k8s';
import { SnapshotDialog, SnapshotEvent } from '@pkg/main/snapshots/types';
import type { Direction, RecursivePartial } from '@pkg/utils/typeUtils';
/**
 * IpcMainEvents describes events the renderer can send to the main process,
 * i.e. ipcRenderer.send() -> ipcMain.on().
 */
export interface IpcMainEvents {
  'backend-state-check':   () => string;
  'k8s-restart':           () => void;
  'settings-read':         () => void;
  'k8s-versions':          () => void;
  'k8s-reset':             (mode: 'fast' | 'wipe') => void;
  'k8s-state':             () => void;
  'k8s-current-engine':    () => void;
  'k8s-current-port':      () => void;
  'k8s-progress':          () => void;
  'k8s-integrations':      () => void;
  'k8s-integration-set':   (name: string, newState: boolean) => void;
  'factory-reset':         (keepSystemImages: boolean) => void;
  'get-app-version':       () => void;
  'update-network-status': (status: boolean) => void;

  // #region main/update
  'update-state': () => void;
  // Quit and apply the update.
  'update-apply': () => void;
  // #endregion

  // #region main/containerEvents
  'do-containers-exec':        (command: string, containerId: string[]) => void;
  'containers-process-output': (data: string, isStdErr: boolean) => void;
  // #endregion

  // #region main/imageEvents
  'confirm-do-image-deletion': (imageName: string, imageID: string) => void;
  'do-image-build':            (taggedImageName: string) => void;
  'do-image-pull':             (imageName: string) => void;
  'do-image-scan':             (imageName: string, namespace: string) => void;
  'do-image-push':             (imageName: string, imageID: string, tag: string) => void;
  'do-image-deletion':         (imageName: string, imageID: string) => void;
  'do-image-deletion-batch':   (images: string[]) => void;
  'images-namespaces-read':    () => void;
  // #endregion

  // #region dialog
  'dialog/load':    () => void;
  'dialog/ready':   () => void;
  'dialog/mounted': () => void;
  /** For message box only */
  'dialog/error':   (args: Record<string, string>) => void;
  'dialog/close':   (...args: any[]) => void;
  // #endregion

  // #region sudo-prompt
  'sudo-prompt/closed': (suppress: boolean) => void;
  // #endregion

  // #region kubernetes-errors
  'kubernetes-errors/ready': () => void;
  // #endregion

  // #region Preferences
  'preferences-open':       () => void;
  'preferences-close':      () => void;
  'preferences-set-dirty':  (isDirty: boolean) => void;
  'get-debugging-statuses': () => void;
  // #endregion

  'show-logs': () => void;

  'dashboard-open':  () => void;
  'dashboard-close': () => void;

  'diagnostics/run': () => void;

  /** Only for the preferences window */
  'preferences/load': () => void;

  'help/preferences/open-url': () => void;

  // #region Extensions
  'extensions/open':            (id: string, path: string) => void;
  'extensions/close':           () => void;
  'extensions/open-external':   (url: string) => void;
  'extensions/spawn/kill':      (execId: string) => void;
  /** Execute the given command, streaming results back via events. */
  'extensions/spawn/streaming': (
    options: import('@pkg/main/extensions/types').SpawnOptions
  ) => void;
  /** Show a notification */
  'extensions/ui/toast': (
    level: 'success' | 'warning' | 'error',
    message: string
  ) => void;
  'ok:extensions/getContentArea': (payload: { top: number, right: number, bottom: number, left: number }) => void;
  // #endregion

  // #region Snapshots
  snapshot:          (event: SnapshotEvent | null) => void;
  'snapshot-cancel': () => void;
  // #endregion

  // #region Agent Configuration
  'model-changed': (payload: { model: string; type: 'local' } | { model: string; type: 'remote'; provider: string }) => void;
  // #endregion

  // #region Error Reporting
  'error-report/submit': (report: {
    error_type:    string;
    error_message: string;
    stack_trace?:  string;
    user_context?: string;
    notify_email?: string;
  }) => void;
  // #endregion

  // #region Voice Logging
  'voice-log': (entry: { type: string; ts: string; threadId: string; channel: string; [key: string]: unknown }) => void;
  // #endregion
}

/**
 * IpcMainInvokeEvents describes handlers describes RPC calls the renderer can
 * invoke on the main process, i.e. ipcRenderer.invoke() -> ipcMain.handle()
 */
export interface IpcMainInvokeEvents {
  'get-locked-fields':         () => import('@pkg/config/settings').LockedSettingsType;
  'settings-write':            (arg: RecursivePartial<import('@pkg/config/settings').Settings>) => void;
  'transient-settings-fetch':  () => import('@pkg/config/transientSettings').TransientSettings;
  'transient-settings-update': (arg: RecursivePartial<import('@pkg/config/transientSettings').TransientSettings>) => void;
  'service-fetch':             (namespace?: string) => import('@pkg/backend/k8s').ServiceEntry[];
  'service-forward':           (service: ServiceEntry, state: boolean) => void;
  'get-app-version':           () => string;
  'show-message-box':          (options: Electron.MessageBoxOptions) => Electron.MessageBoxReturnValue;
  'show-message-box-rd':       (options: Electron.MessageBoxOptions, modal?: boolean) => any;
  'api-get-credentials':       () => { user: string, password: string, port: number };
  'k8s-progress':              () => Readonly<{ current: number, max: number, description?: string, transitionTime?: Date }>;

  // #region Error Reporting
  'error-report/invoke': (report: {
    error_type:    string;
    error_message: string;
    stack_trace?:  string;
    user_context?: string;
    notify_email?: string;
  }) => { success: boolean; action?: string; issue_number?: number };
  // #endregion

  // #region Sulla
  'start-sulla-custom-env': () => void;
  'sulla-restart-ollama':   () => void;
  'app-quit':               () => void;
  'browser-tab:exec-in-frame': (code: string) => unknown;
  'sulla-settings-get':     (property: string, defaultValue?: any) => any;
  'sulla-settings-set':     (property: string, value: any) => void;
  'audio-transcribe':       (payload: { audio: ArrayBuffer; mimeType: string; diarize?: boolean }) => { text: string; words?: Array<{ text: string; speaker_id?: string; start?: number; end?: number }> };
  'audio-speak':            (payload: { text: string; voiceId?: string }) => { audio: ArrayBuffer; mimeType: string };
  'integration-get-value':  (integrationId: string, property: string) => { value: string } | null;
  // #endregion

  // #region Filesystem
  'filesystem-get-root':        () => string;
  'filesystem-get-git-changes': (path: string) => Promise<{ status: string, file: string }[]>;

  // Git source control
  'git-discover-repos':            (dirPath: string) => { root: string; name: string }[];
  'git-branch':                    (dirPath: string) => string;
  'git-list-branches':             (dirPath: string) => { name: string; current: boolean; remote: boolean }[];
  'git-checkout-branch':           (dirPath: string, branchName: string) => { success: boolean; error: string };
  'git-create-branch':             (dirPath: string, branchName: string) => { success: boolean; error: string };
  'git-status-full':               (dirPath: string) => { index: string; worktree: string; file: string }[];
  'git-stage':                     (dirPath: string, files: string[]) => boolean;
  'git-unstage':                   (dirPath: string, files: string[]) => boolean;
  'git-diff':                      (dirPath: string, file: string, staged: boolean) => string;
  'git-show-head':                 (dirPath: string, file: string) => string;
  'git-show-staged':               (dirPath: string, file: string) => string;
  'agents-list':                   () => { id: string; name: string; description: string; type: string; templateId: string; path: string }[];
  'agents-get-prompt-templates':   () => { soul: string; environment: string };
  'agents-delete':                 (agentId: string) => boolean;
  'agents-get-template-variables': () => { key: string; label: string; preview: string }[];
  'tools-list-by-category':        () => { category: string; description: string; tools: { name: string; description: string; operationTypes: string[] }[] }[];
  'tools-get-schema':              (toolName: string) => Record<string, any> | null;

  // Workflow CRUD
  'workflow-list':   () => { id: string; name: string; updatedAt: string; status: import('@pkg/pages/editor/workflow/types').WorkflowStatus }[];
  'workflow-get':    (workflowId: string) => any;
  'workflow-save':   (workflow: any) => boolean;
  'workflow-delete': (workflowId: string) => boolean;
  'workflow-move':   (workflowId: string, targetStatus: import('@pkg/pages/editor/workflow/types').WorkflowStatus) => { success: boolean; newStatus: import('@pkg/pages/editor/workflow/types').WorkflowStatus };
  'workflow-watch-start':    () => boolean;
  'workflow-watch-stop':     () => boolean;
  'workflow-check-updated':  (workflowId: string, editorUpdatedAt: string) => { changed: boolean; diskUpdatedAt: string };

  // Workflow execution
  'workflow-execute':          (workflowId: string, triggerPayload: unknown) => { executionId: string };
  'workflow-execution-status': (executionId: string) => { executionId: string; status: string; startedAt?: string; completedAt?: string; error?: string } | null;
  'workflow-execution-abort':  (executionId: string) => boolean;
  'workflow-execution-resume': (executionId: string, nodeId: string, userData: unknown) => boolean;

  // Workflow registry dispatch (used by external trigger sources)
  'workflow-dispatch': (triggerType: string, message: string, workflowId?: string) => { executionId: string; workflowId: string; workflowName: string } | null;

  'git-commit':        (dirPath: string, message: string) => boolean;
  'git-pull':          (dirPath: string) => { success: boolean; output: string };
  'git-push':          (dirPath: string) => { success: boolean; output: string };
  'git-fetch':         (dirPath: string) => { success: boolean; output: string };
  'git-stash':         (dirPath: string) => { success: boolean; output: string };
  'git-stash-pop':     (dirPath: string) => { success: boolean; output: string };
  'git-discard-all':   (dirPath: string) => { success: boolean; output: string };
  'git-add-gitignore': (repoRoot: string, pattern: string) => { success: boolean; output: string };

  'filesystem-read-dir':       (dirPath: string) => { name: string; path: string; isDir: boolean; size: number; ext: string }[];
  'filesystem-read-file':      (filePath: string) => string;
  'filesystem-write-file':     (filePath: string, content: string) => void;
  'filesystem-save-dialog':    (defaultName: string, defaultPath?: string) => string | null;
  'filesystem-rename':         (oldPath: string, newName: string) => string;
  'filesystem-delete':         (targetPath: string) => void;
  'filesystem-create-file':    (dirPath: string, fileName: string) => string;
  'filesystem-create-dir':     (dirPath: string, dirName: string) => string;
  'filesystem-copy':           (srcPath: string, destDir: string) => string;
  'filesystem-move':           (srcPath: string, destDir: string) => string;
  'filesystem-reveal':         (targetPath: string) => void;
  'filesystem-open-external':  (targetPath: string) => void;
  'filesystem-open-in-editor': (targetPath: string, line?: number) => void;
  'filesystem-upload':         (destDir: string, fileName: string, base64Data: string) => string;
  // #endregion

  // #region Training
  'training-install-status':           () => { installed: boolean; installing: boolean; error: string; modelKey: string; displayName: string; trainingRepo: string; requiredBytes: number; availableBytes: number };
  'training-install':                  () => { logFilename: string };
  'training-run':                      (modelKey: string, sources: { documentProcessing: boolean; loraTraining: boolean; skills: boolean }) => { logFilename: string; logPath: string };
  'training-status':                   () => { running: boolean; logFilename: string };
  'training-docs-config-exists':       () => boolean;
  'training-history':                  () => { filename: string; size: number; createdAt: string; modifiedAt: string; model?: string; durationMs?: number; conversationsProcessed?: number; status: 'completed' | 'running' | 'failed' }[];
  'training-log-read':                 (filename: string) => string;
  'training-schedule-get':             () => { enabled: boolean; hour: number; minute: number };
  'training-schedule-set':             (opts: { enabled: boolean; hour: number; minute: number }) => { ok: boolean };
  'training-models-downloaded':        () => { key: string; displayName: string; trainingRepo: string }[];
  'training-docs-config-load':         () => { folders: string[]; files: string[]; fileTypes: string[] };
  'training-docs-list-dir':            (dirPath: string) => { path: string; name: string; isDir: boolean; hasChildren: boolean; size: number; ext: string }[];
  'training-docs-config-save':         (folders: string[], files: string[], fileTypes: string[]) => { ok: boolean };
  'training-content-tree':             (dirPath?: string) => { path: string; name: string; isDir: boolean; hasChildren: boolean; size: number; ext: string; category?: string }[];
  'editor-footer-stats':               () => { availableBytes: number; unprocessedTrainingBytes: number };
  'training-data-files':               () => { filename: string; path: string; size: number; modifiedAt: string; examples: number; source: 'sessions' | 'documents' | 'processed' }[];
  'training-preprocess':               () => { conversations: number; filesProcessed: number; filesSkipped: number };
  'training-prepare-docs':             (folders: string[], files: string[], options: { prompt: string; modelId: string; modelProvider: string; outputFilename: string }) => { filesProcessed: number; pairsGenerated: number };
  'training-queue-add':                (entries: { filePath: string; prompt: string; modelId: string; modelProvider: string; outputFilename: string }[]) => { queued: number };
  'training-queue-process-now':        () => { ok: boolean };
  'training-queue-status':             () => { pending: number; processing: boolean };
  'training-train-conversations-now':  () => { logFilename: string; logPath: string };
  'training-scheduled-configs-list':   () => { id: string; name: string; source: 'conversations' | 'documents'; modelKey: string; prompt?: string; outputFilename?: string; createdAt: string; files?: string[] }[];
  'training-scheduled-configs-add':    (config: { name: string; source: 'conversations' | 'documents'; modelKey: string; prompt?: string; outputFilename?: string; files?: string[] }) => { id: string };
  'training-scheduled-configs-remove': (id: string) => { ok: boolean };
  'training-wizard-settings-save':     (wizard: 'create' | 'train', settings: Record<string, unknown>) => { ok: boolean };
  'training-wizard-settings-load':     (wizard: 'create' | 'train') => Record<string, unknown>;
  // #endregion

  // #region QMD Search
  'qmd-index':  (dirPath: string, glob?: string) => { indexed: number; updated: number; removed: number };
  'qmd-search': (query: string, dirPath: string) => {
    path:    string;
    name:    string;
    line:    number;
    preview: string;
    score:   number;
    source:  'fts' | 'filename';
  }[];
  // #endregion

  // #region Local Models
  'system-resources':     () => { totalMemoryGB: number; availableMemoryGB: number; availableDiskGB: number };
  'local-models-status':  () => Record<string, boolean>;
  'local-model-download': (modelKey: string) => { ok: boolean };
  // #endregion

  // #region main/imageEvents
  'images-mounted':     (mounted: boolean) => { imageName: string, tag: string, imageID: string, size: string }[];
  'images-check-state': () => boolean;
  // #endregion

  // #region extensions
  /** Execute the given command and return the results. */
  'extensions/spawn/blocking': (options: import('@pkg/main/extensions/types').SpawnOptions) => import('@pkg/main/extensions/types').SpawnResult;
  'extensions/ui/show-open':   (options: import('electron').OpenDialogOptions) => import('electron').OpenDialogReturnValue;
  /* Fetch data from the backend, or arbitrary host ignoring CORS. */
  'extensions/vm/http-fetch':  (config: import('@docker/extension-api-client-types').v1.RequestConfig) => import('@docker/extension-api-client-types').v1.ServiceError;
  // #endregion

  // #region Versions
  'versions/macOs': () => semver.SemVer;
  // #endregion

  // #region Host
  'host/isArm': () => boolean;
  // #endregion

  // #region Docker
  'docker-list-containers': () => { id: string; name: string; image: string; status: string; state: string; ports: string }[];
  // #endregion

  // #region Snapshots
  'show-snapshots-confirm-dialog':  (options: { window: Partial<Electron.MessageBoxOptions>, format: SnapshotDialog }) => any;
  'show-snapshots-blocking-dialog': (options: { window: Partial<Electron.MessageBoxOptions>, format: SnapshotDialog }) => any;
  'snapshot-cancel':                () => void;
  // #endregion

  // #region Debug & Monitoring
  'debug-heartbeat-status':    () => { initialized: boolean; isExecuting: boolean; lastTriggerMs: number; schedulerRunning: boolean; totalTriggers: number; totalErrors: number; totalSkips: number; uptimeMs: number };
  'debug-heartbeat-history':   (limit?: number) => { ts: number; type: string; message: string; durationMs?: number; error?: string; meta?: Record<string, unknown> }[];
  'debug-heartbeat-schedule':  () => { enabled: boolean; delayMinutes: number; nextTriggerMs: number };
  'debug-conversations-list':  () => { id: string; type: string; name: string; startedAt: string; completedAt?: string; status?: string; error?: string; channel?: string }[];
  'debug-conversation-events': (conversationId: string) => { ts: string; type: string; [key: string]: unknown }[];
  'debug-health-check':        () => Record<string, { name: string; ok: boolean; port?: number; error?: string }>;
  'debug-active-agents':       () => { agentId: string; name: string; role: string; channel: string; type: string; status: string; startedAt: number; lastActiveAt: number; description: string; statusNote?: string }[];
  'debug-errors':              (limit?: number) => { conversationId: string; type: string; name: string; startedAt: string; error: string; channel?: string }[];
  'debug-ws-stats':            () => Record<string, { connected: boolean; reconnectAttempts: number; pendingMessages: number; subscribedChannels: string[] }>;
  'debug-ws-tap':              (enabled: boolean) => { ok: boolean; error?: string };
  'debug-ws-messages':         (connectionId?: string, limit?: number) => { connectionId: string; direction: 'in' | 'out'; message: any; ts: number }[];
  'debug-service-detail':      (serviceKey: string) => any;
  'debug-live-start':          () => { ok: boolean; error?: string };
  'debug-live-stop':           () => { ok: boolean; error?: string };
  // #endregion

  // #region Config API (integration YAML -> live API calls)
  'configapi-list-integrations': () => ({
    slug:      string;
    name:      string;
    baseUrl:   string;
    version:   string;
    endpoints: {
      name:        string;
      path:        string;
      method:      'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
      description: string;
      auth:        'required' | 'optional' | 'none';
      queryParams: { key: string; type: string; required?: boolean; default?: any; description?: string; enum?: string[] }[];
    }[];
  } | null)[];
  'configapi-reload': () => string[];
  'configapi-call':   (slug: string, endpointName: string, params: Record<string, any>, options?: Record<string, any>) => any;
  // #endregion
}

/**
 * IpcRendererEvents describes events that the main process may send to the renderer
 * process, i.e. webContents.send() -> ipcRenderer.on().
 */
export interface IpcRendererEvents {
  'workflow-files-changed': () => void;
  'ollama-model-status': (event: Electron.IpcRendererEvent, payload: { status: string; model?: string }) => void;
  'backend-locked':      (action?: string) => void;
  'backend-unlocked':    () => void;
  'settings-update': (
    settings: import('@pkg/config/settings').Settings
  ) => void;
  'settings-read':        (settings: import('@pkg/config/settings').Settings) => void;
  'settings-write-error': (error: any) => void;
  'local-model-download-progress': (data: { modelKey: string; received: number; total: number; percent: number }) => void;
  'get-app-version':      (version: string) => void;
  'update-state':         (state: import('@pkg/main/update').UpdateState) => void;
  'always-debugging':     (status: boolean) => void;
  'is-debugging':         (status: boolean) => void;
  'k8s-progress': (
    progress: Readonly<{
      current:         number;
      max:             number;
      description?:    string;
      transitionTime?: Date;
    }>
  ) => void;
  'k8s-check-state':    (state: import('@pkg/backend/k8s').State) => void;
  'k8s-current-engine': (
    engine: import('@pkg/config/settings').ContainerEngine
  ) => void;
  'k8s-current-port': (port: number) => void;
  'k8s-versions': (
    versions: import('@pkg/utils/kubeVersions').VersionEntry[],
    cachedOnly: boolean
  ) => void;
  'k8s-integrations':          (integrations: Record<string, boolean | string>) => void;
  'service-changed':           (services: ServiceEntry[]) => void;
  'service-error':             (service: ServiceEntry, errorMessage: string) => void;
  'kubernetes-errors-details': (
    titlePart: string,
    mainMessage: string,
    failureDetails: import('@pkg/backend/k8s').FailureDetails
  ) => void;
  'update-network-status': (status: boolean) => void;
  'diagnostics/update':    () => void;

  // #region Images
  'images-process-cancelled': () => void;
  'images-process-ended':     (exitCode: number) => void;
  'images-process-output':    (data: string, isStdErr: boolean) => void;
  'ok:images-process-output': (data: string) => void;
  'images-changed': (
    images: { imageName: string; tag: string; imageID: string; size: string }[]
  ) => void;
  'images-check-state':       (state: boolean) => void;
  'images-namespaces':        (namespaces: string[]) => void;
  'container-process-output': (data: string, isStdErr: boolean) => void;
  // #endregion

  // #region dialog
  'dialog/mounted':  () => void;
  'dialog/populate': (...args: any) => void;
  'dialog/size':     (size: { width: number; height: number }) => void;
  'dialog/options':  (...args: any) => void;
  'dialog/close':    (...args: any) => void;
  'dialog/error':    (args: any) => void;
  'dialog/info':     (args: Record<string, string>) => void;
  'dashboard-open':  () => void;
  // #endregion

  // #region tab navigation
  route: (route: {
    name?:      string;
    path?:      string;
    direction?: Direction;
  }) => void;
  // #endregion

  // #region extensions
  // The list of installed extensions may have changed.
  'extensions/changed':        () => void;
  'extensions/getContentArea': () => void;
  'extensions/open':           (id: string, path: string) => void;
  'err:extensions/open':       () => void;
  'extensions/close':          () => void;
  'extensions/spawn/close':    (id: string, code: number) => void;
  'extensions/spawn/error':    (id: string, error: Error | NodeJS.Signals) => void;
  'extensions/spawn/output': (
    id: string,
    data: { stdout: string } | { stderr: string }
  ) => void;
  'ok:extensions/uninstall': (id: string) => void;
  // #endregion

  // #region window
  'window/blur': (state: boolean) => void;
  // #endregion

  // #region preferences
  'preferences/changed': () => void;
  // #endregion

  // #region Versions
  'versions/macOs': (macOsVersion: semver.SemVer) => void;
  // #endregion

  // #region Host
  'host/isArm': (isArm: boolean) => void;
  // #endregion

  // #region Snapshots
  'snapshot-cancel': () => void;
  // #endregion

  // #region Agent Configuration
  'model-changed': (payload: { model: string; type: 'local' } | { model: string; type: 'remote'; provider: string }) => void;
  // #endregion
}
