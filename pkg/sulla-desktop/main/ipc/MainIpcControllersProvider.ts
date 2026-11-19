// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BrowserWindow, ipcMain, webContents } from 'electron';
import * as fs from 'fs/promises';

import { AgentTabContractIpcController } from '../agentTabContractIpc';
import { BookmarksIpcController } from '../bookmarksIpc';
import { TabsIpcController } from '../browserTabs/tabsIpc';
import { ChatArtifactsIpcController } from '../chatArtifactsIpc';
import { ChatHeartbeatIpcController } from '../chatHeartbeatIpc';
import { ChatMessagesIpcController } from '../chatMessagesIpc';
import { cloudRequest } from '../cloud/cloudFetch';
import { ConversationMessagesIpcController } from '../conversationMessagesIpc';
import { ExtensionUiIpcController } from '../extensionUiIpc';
import { IntegrationGrantIpcController, IntegrationGrantPackageStore } from '../integrationGrantIpc';
import { getIpcMainProxy } from '../ipcMain';
import { MessageBusIpcController } from '../messageBusIpc';
import { ModelDefaultsIpcController } from '../modelDefaultsIpc';
import { ModelRoutingIpcController } from '../modelRoutingIpc';
import { OrgConversationsIpcController } from '../orgConversationsIpc';
import { LazyBundleMarketplace, SullaBundleIpcController } from '../sullaBundleEvents';
import { SullaPatchIpcController } from '../sullaPatchEvents';
import { SupportSessionCloudClient, SupportSessionIpcController } from '../supportSessionIpc';
import { UsageIpcController } from '../usageEvents';

import { tabRegistry } from '@pkg/main/browserTabs/TabRegistry';
import { getBrowserSession } from '@pkg/main/browserTabs/browserSession';
import { ChatArtifactModel } from '@pkg/agent/database/models/ChatArtifactModel';
import { ConversationHistoryModel } from '@pkg/agent/database/models/ConversationHistoryModel';
import { ConversationMessagesModel } from '@pkg/agent/database/models/ConversationMessagesModel';
import { ConversationThreadStore } from '@pkg/agent/database/models/ConversationThreadStore';
import { modelDefaultsState, resetModelDefaults, setModelDefaults } from '@pkg/agent/languagemodels/modelDefaults';
import { modelRouter, recommendedState } from '@pkg/agent/languagemodels/modelRouter';
import { acknowledgeAgentTabReady, getAgentTabThreadSnapshot } from '@pkg/agent/services/AgentTabOpener';
import { configureChatArtifactBookmarkSync, configureChatArtifactFilesRegistration, getChatArtifactService } from '@pkg/agent/services/ChatArtifactService';
import { getChatHeartbeatService } from '@pkg/agent/services/ChatHeartbeatService';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { IpcMessageBus } from '@pkg/agent/services/IpcMessageBus';
import { getUsageSummary } from '@pkg/agent/usage/providerUsage';
import { getArtifactBookmarkSync } from '@pkg/main/bookmarks/artifactBookmarkSync';
import { bookmarkService } from '@pkg/main/bookmarks/bookmarkService';
import { getChatArtifactFilesRegistration } from '@pkg/main/chatArtifactFilesRegistration';
import { getDatabaseReadGuard } from '@pkg/main/DatabaseReadGuard';
import { listDockerLinks } from '@pkg/main/dockerLinks';
import Logging from '@pkg/utils/logging';
import { safeSend } from '@pkg/utils/safeSend';

import type { IpcMainRegistrar, IpcRegistrar } from './IpcController';

/**
 * Composition root for the main-process IPC controllers. Constructing it has
 * no side effects; each controller registers its channels only when its
 * register() is called, so sullaEvents keeps its original registration order.
 * Controllers that used the logged ipcMain proxy before still use it.
 */
export class MainIpcControllersProvider {
  readonly messageBus:           MessageBusIpcController;
  readonly extensionUi:          ExtensionUiIpcController;
  readonly integrationGrant:     IntegrationGrantIpcController;
  readonly supportSession:       SupportSessionIpcController;
  readonly agentTabContract:     AgentTabContractIpcController;
  readonly tabs:                 TabsIpcController;
  readonly modelRouting:         ModelRoutingIpcController;
  readonly modelDefaults:        ModelDefaultsIpcController;
  readonly orgConversations:     OrgConversationsIpcController;
  readonly bookmarks:            BookmarksIpcController;
  readonly chatMessages:         ChatMessagesIpcController;
  readonly conversationMessages: ConversationMessagesIpcController;
  readonly chatArtifacts:        ChatArtifactsIpcController;
  readonly chatHeartbeat:        ChatHeartbeatIpcController;
  readonly usage:                UsageIpcController;
  readonly sullaBundle:          SullaBundleIpcController;
  readonly sullaPatch:           SullaPatchIpcController;

  constructor(raw: IpcMainRegistrar = ipcMain as unknown as IpcMainRegistrar, proxy: IpcRegistrar = getIpcMainProxy(Logging.background) as unknown as IpcRegistrar) {
    const log = Logging.background;
    const broadcastToWindows = (channel: string, payload: unknown) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
    };

    this.messageBus = new MessageBusIpcController(raw, {
      bus:            () => IpcMessageBus.getInstance(),
      allWebContents: () => webContents.getAllWebContents(),
      send:           (wc, channel, ...args) => safeSend(wc, channel, ...args),
      log:            (message, ...rest) => log.log(message, ...rest),
    });
    this.extensionUi = new ExtensionUiIpcController(raw, {
      readGuard:   { run: (label, read, fallback) => getDatabaseReadGuard().run(label, read, fallback) },
      onHookAudit: listener => import('@pkg/agent/extensions/HookRegistry').then(({ onExtensionHookAudit }) => onExtensionHookAudit(listener as any)),
      broadcast:   broadcastToWindows,
    });
    this.integrationGrant = new IntegrationGrantIpcController(raw, new IntegrationGrantPackageStore());
    this.supportSession = new SupportSessionIpcController(proxy, new SupportSessionCloudClient((method, path, init) => cloudRequest(method, path, init)), (message, details) => log.error(message, details));
    this.agentTabContract = new AgentTabContractIpcController(raw, { acknowledgeReady: acknowledgeAgentTabReady, snapshot: getAgentTabThreadSnapshot });
    this.tabs = new TabsIpcController(raw, tabRegistry as any, {
      allWebContents: () => webContents.getAllWebContents(),
      browserSession: () => getBrowserSession(),
      send:           (wc, channel, payload) => safeSend(wc, channel, payload),
    });
    this.modelRouting = new ModelRoutingIpcController(raw, {
      router:                   modelRouter as any,
      recommendedState,
      listAgents:               async() => (await import('@pkg/agent/database/models/AgentDefinitionModel')).AgentDefinitionModel.list() as any,
      onIntegrationValueChange: listener => getIntegrationService().onValueChange(listener as any),
      broadcast:                broadcastToWindows,
    });
    this.modelDefaults = new ModelDefaultsIpcController(raw, { state: modelDefaultsState, set: setModelDefaults as any, reset: resetModelDefaults });
    this.orgConversations = new OrgConversationsIpcController(raw, () => {
      const { getBackendGraphWebSocketService } = require('@pkg/agent/services/BackendGraphWebSocketService');
      return getBackendGraphWebSocketService();
    });
    this.bookmarks = new BookmarksIpcController(proxy, {
      bookmarks:             bookmarkService as any,
      configureArtifactSync: () => configureChatArtifactBookmarkSync(getArtifactBookmarkSync()),
      listDockerLinks,
      isAppWindow:           sender => !!BrowserWindow.fromWebContents(sender),
    });
    this.chatMessages = new ChatMessagesIpcController(raw, ConversationThreadStore as any, log);
    this.conversationMessages = new ConversationMessagesIpcController(raw, ConversationMessagesModel, log);
    this.chatArtifacts = new ChatArtifactsIpcController(raw, {
      service: () => {
        configureChatArtifactFilesRegistration(getChatArtifactFilesRegistration());

        return getChatArtifactService();
      },
      readGuard:          { run: (label, read, fallback) => getDatabaseReadGuard().run(label, read, fallback) },
      getArtifactById:    id => ChatArtifactModel.getById(id) as any,
      getHistoryByThread: threadId => ConversationHistoryModel.getByThread(threadId) as any,
    });
    this.chatHeartbeat = new ChatHeartbeatIpcController(raw, getChatHeartbeatService);
    this.usage = new UsageIpcController(proxy, {
      summary:            (hours, profileId) => getUsageSummary(hours, profileId),
      activeContractorId: async() => (await import('../sullaCloudAuth')).getActiveContractorId(),
    });
    this.sullaBundle = new SullaBundleIpcController(proxy, new LazyBundleMarketplace(), log);
    this.sullaPatch = new SullaPatchIpcController(raw, fs, log);
  }
}
