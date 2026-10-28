// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export { ChromeApiService, getChromeApi } from './ChromeApiService';
export { initChromeApiIpc } from './chromeApiIpc';
export type {
  // Core
  ChromeApi,
  ChromeEvent,
  EventListener,

  // Tabs
  ChromeTab,
  TabQueryInfo,
  TabCreateProperties,
  TabUpdateProperties,
  TabChangeInfo,

  // Scripting
  ScriptInjection,
  ScriptInjectionTarget,
  CSSInjection,
  InjectionResult,

  // Cookies
  ChromeCookie,
  CookieGetDetails,
  CookieGetAllDetails,
  CookieSetDetails,
  CookieRemoveDetails,

  // Storage
  StorageArea,

  // Windows
  ChromeWindow,
  WindowCreateProperties,

  // Alarms
  AlarmCreateInfo,
  ChromeAlarm,

  // WebRequest
  WebRequestFilter,
  WebRequestDetails,
  WebRequestHeadersDetails,
  WebRequestResponseDetails,

  // ContextMenus
  ContextMenuCreateProperties,
  ContextMenuUpdateProperties,
  ContextMenuClickInfo,

  // Notifications
  NotificationOptions,

  // WebNavigation
  WebNavigationDetails,
  WebNavigationErrorDetails,

  // Commands
  ChromeCommand,

  // TTS
  TtsOptions,
  TtsVoice,

  // Action
  ActionSetIconDetails,
  ActionSetBadgeDetails,
  ActionSetTitleDetails,

  // Downloads
  DownloadOptions,
  DownloadItem,
  DownloadQuery,

  // History
  HistoryItem,
  HistoryQuery,

  // SidePanel
  SidePanelOptions,

  // Runtime
  RuntimeMessage,
} from './types';
